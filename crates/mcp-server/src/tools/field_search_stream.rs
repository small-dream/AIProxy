use std::fmt;
use std::io::Read;

use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{json, Number, Value};

use crate::redaction::Redactor;

use super::body::{render_json_path, JsonPathSegment};
use super::body_stream::DepthLimitedIgnoredSeed;

pub(super) const MAX_MATCHES_PER_SESSION: usize = 20;
const MAX_MATCH_PATH_BYTES: usize = 1024;
const MAX_MATCH_VALUE_BYTES: usize = 512;
pub(super) const MAX_SEARCH_STRING_BYTES: usize = 64 * 1024;
const MAX_SESSION_MATCH_BYTES: usize = 6 * 1024;

pub(super) enum FieldTarget {
    Key(String),
    Path(Vec<JsonPathSegment>),
}

pub(super) enum FieldCondition {
    Exists,
    Equals(Value),
}

#[derive(Default)]
pub(super) struct JsonMatches {
    pub(super) items: Vec<Value>,
    pub(super) redacted: bool,
    pub(super) limited: bool,
    bytes: usize,
}

pub(super) fn scan_json<R: Read>(
    reader: R,
    target: &FieldTarget,
    condition: &FieldCondition,
    redactor: &Redactor,
) -> Result<JsonMatches, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let mut matches = JsonMatches::default();
    SearchVisitor {
        target,
        condition,
        redactor,
        path: &mut Vec::new(),
        result: &mut matches,
    }
    .deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(matches)
}

struct SearchVisitor<'a> {
    target: &'a FieldTarget,
    condition: &'a FieldCondition,
    redactor: &'a Redactor,
    path: &'a mut Vec<JsonPathSegment>,
    result: &'a mut JsonMatches,
}

impl SearchVisitor<'_> {
    fn selected(&self) -> bool {
        match self.target {
            FieldTarget::Key(name) => {
                matches!(self.path.last(), Some(JsonPathSegment::Key(key)) if key == name)
            }
            // Children outside the path are consumed by the ignored seed.
            FieldTarget::Path(segments) => segments.len() == self.path.len(),
        }
    }

    fn relevant_child(&self) -> bool {
        let FieldTarget::Path(segments) = self.target else {
            return true;
        };
        let depth = self.path.len() - 1;
        segments.get(depth).is_some_and(|selector| {
            let actual = &self.path[depth];
            selector == actual
                || matches!(
                    (selector, actual),
                    (JsonPathSegment::Wildcard, JsonPathSegment::Index(_))
                )
        })
    }

    fn record(&mut self, value_type: &str, value: Option<Value>) {
        if let FieldCondition::Equals(expected) = self.condition {
            if !value
                .as_ref()
                .is_some_and(|value| scalar_eq(expected, value))
            {
                return;
            }
        }

        let path = render_json_path(self.path);
        if self.result.items.len() == MAX_MATCHES_PER_SESSION || path.len() > MAX_MATCH_PATH_BYTES {
            self.result.limited = true;
            return;
        }

        let mut item = json!({ "jsonPath": path, "valueType": value_type });
        if let Some(value) = value {
            if value
                .as_str()
                .is_some_and(|text| text.len() > MAX_MATCH_VALUE_BYTES)
            {
                item["valueTruncated"] = json!(true);
            } else {
                item["value"] = value;
            }
        }
        let bytes = item.to_string().len() + 1;
        if self.result.bytes + bytes > MAX_SESSION_MATCH_BYTES {
            self.result.limited = true;
            return;
        }
        self.result.bytes += bytes;
        self.result.items.push(item);
    }

    fn scalar(mut self, value_type: &str, value: Value) {
        if self.selected() {
            self.record(value_type, Some(value));
        }
    }

    fn child(&mut self) -> SearchVisitor<'_> {
        SearchVisitor {
            target: self.target,
            condition: self.condition,
            redactor: self.redactor,
            path: self.path,
            result: self.result,
        }
    }
}

impl<'de> DeserializeSeed<'de> for SearchVisitor<'_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for SearchVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> {
        self.scalar("null", Value::Null);
        Ok(())
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<(), E> {
        self.scalar("boolean", value.into());
        Ok(())
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<(), E> {
        self.scalar("number", value.into());
        Ok(())
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<(), E> {
        self.scalar("number", value.into());
        Ok(())
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<(), E> {
        self.scalar("number", value.into());
        Ok(())
    }

    fn visit_str<E: serde::de::Error>(mut self, value: &str) -> Result<(), E> {
        if self.selected() {
            if value.len() > MAX_SEARCH_STRING_BYTES {
                // Do not compare strings that are too large to check for redaction.
                self.result.limited = true;
            } else if self.redactor.redact_text(value).records.is_empty() {
                self.record("string", Some(Value::String(value.to_owned())));
            } else {
                self.result.redacted = true;
            }
        }
        Ok(())
    }

    fn visit_map<M: MapAccess<'de>>(mut self, mut map: M) -> Result<(), M::Error> {
        if self.selected() {
            self.record("object", None);
        }
        while let Some(key) = map.next_key::<String>()? {
            if key.len() > MAX_MATCH_PATH_BYTES {
                self.result.limited = true;
                map.next_value_seed(DepthLimitedIgnoredSeed {
                    depth: self.path.len() + 1,
                })?;
            } else if self.redactor.is_sensitive_name(&key)
                || !self.redactor.redact_text(&key).records.is_empty()
            {
                self.result.redacted = true;
                map.next_value_seed(DepthLimitedIgnoredSeed {
                    depth: self.path.len() + 1,
                })?;
            } else {
                self.path.push(JsonPathSegment::Key(key));
                if self.relevant_child() {
                    map.next_value_seed(self.child())?;
                } else {
                    map.next_value_seed(DepthLimitedIgnoredSeed {
                        depth: self.path.len(),
                    })?;
                }
                self.path.pop();
            }
        }
        Ok(())
    }

    fn visit_seq<S: SeqAccess<'de>>(mut self, mut seq: S) -> Result<(), S::Error> {
        if self.selected() {
            self.record("array", None);
        }
        for index in 0.. {
            self.path.push(JsonPathSegment::Index(index));
            let item = if self.relevant_child() {
                seq.next_element_seed(self.child())?
            } else {
                seq.next_element_seed(DepthLimitedIgnoredSeed {
                    depth: self.path.len(),
                })?
            };
            self.path.pop();
            if item.is_none() {
                break;
            }
        }
        Ok(())
    }
}

fn scalar_eq(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Number(left), Value::Number(right)) if left.is_f64() != right.is_f64() => {
            let (float, integer) = if left.is_f64() {
                (left, right)
            } else {
                (right, left)
            };
            // Compare an integral float with the exact integer representation.
            // Converting the integer to f64 can equate adjacent large integers.
            float.as_f64().is_some_and(|value| {
                value.fract() == 0.0
                    && (value == 0.0 && integer.as_i64() == Some(0)
                        || format!("{value:.0}").parse::<Number>().ok().as_ref() == Some(integer))
            })
        }
        _ => expected == actual,
    }
}
