use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{Cursor, Read};
use std::rc::Rc;

use aiproxy_db::body_store::BodyStore;
use serde::de::{DeserializeSeed, Error as DeError, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserializer;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::protocol::ToolError;
use crate::redaction::{RedactionRecord, Redactor};

use super::body::{
    decode_inline_reference, render_json_path, JsonPathSegment, StoredBodyReference,
};

pub(crate) const MAX_JSON_PATH_SCAN_BYTES: usize = 64 * 1024 * 1024;
const ROOT_PATH_SCAN_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXTRACTED_VALUE_BYTES: usize = 64 * 1024;
const MAX_JSON_PATH_MATCHES: usize = 256;
const MAX_EXTRACTED_RESULT_BYTES: usize = 960 * 1024;
const MAX_SUMMARY_KEYS: usize = 32;
const MAX_SUMMARY_ITEMS: usize = 16;
const MAX_SUMMARY_KEY_CHARS: usize = 64;
const MAX_SUMMARY_BYTES: usize = 4 * 1024;
const MAX_JSON_DEPTH: usize = 128;

#[derive(Debug)]
pub(crate) struct JsonPathExtraction {
    pub values: Vec<Value>,
    pub truncated: bool,
    pub redacted_fields: Vec<String>,
    pub view_size_bytes: usize,
    pub hash: String,
}

#[derive(Debug, Clone)]
struct CapturedValue {
    value: Value,
    value_type: &'static str,
    value_summary: Option<Value>,
    truncated: bool,
    serialized_size: usize,
    already_redacted: bool,
}

impl CapturedValue {
    fn ignored() -> Self {
        Self {
            value: Value::Null,
            value_type: "null",
            value_summary: None,
            truncated: false,
            serialized_size: 0,
            already_redacted: false,
        }
    }
}

#[derive(Debug)]
struct CapturedMatch {
    dedup_path: String,
    value: Value,
    value_summary: Option<Value>,
    value_type: String,
    truncated: bool,
}

#[derive(Debug, Default)]
struct PathNode {
    terminals: Vec<usize>,
    keys: BTreeMap<String, PathNode>,
    indices: BTreeMap<usize, PathNode>,
    wildcard: Option<Box<PathNode>>,
}

impl PathNode {
    fn has_routes(&self) -> bool {
        !self.keys.is_empty() || !self.indices.is_empty() || self.wildcard.is_some()
    }

    fn has_terminals(&self) -> bool {
        !self.terminals.is_empty()
    }
}

struct ExtractionState {
    raw: bool,
    redactor: Redactor,
    slots: Vec<Vec<CapturedMatch>>,
    path_limited: Vec<bool>,
    omitted_paths: BTreeSet<usize>,
    redacted_fields: BTreeSet<String>,
    result_bytes: usize,
    result_limited: bool,
}

impl ExtractionState {
    fn new(path_count: usize, raw: bool, redactor: Redactor) -> Self {
        Self {
            raw,
            redactor,
            slots: (0..path_count).map(|_| Vec::new()).collect(),
            path_limited: vec![false; path_count],
            omitted_paths: BTreeSet::new(),
            redacted_fields: BTreeSet::new(),
            result_bytes: 0,
            result_limited: false,
        }
    }

    fn capture(&mut self, terminals: &[usize], dedup_path: &str, mut captured: CapturedValue) {
        if !self.raw && !captured.already_redacted {
            let mut records = Vec::new();
            self.redactor
                .redact_json_value(&mut captured.value, dedup_path, &mut records);
            self.collect_redactions(records);
        }

        for &path_index in terminals {
            self.push(
                CapturedMatch {
                    dedup_path: dedup_path.to_string(),
                    value: captured.value.clone(),
                    value_summary: captured.value_summary.clone(),
                    value_type: captured.value_type.to_string(),
                    truncated: captured.truncated,
                },
                path_index,
            );
        }
    }

    fn capture_sensitive(
        &mut self,
        terminals: &[usize],
        dedup_path: &str,
        captured: CapturedValue,
    ) {
        for &path_index in terminals {
            self.push(
                CapturedMatch {
                    dedup_path: dedup_path.to_string(),
                    value: captured.value.clone(),
                    value_summary: None,
                    value_type: captured.value_type.to_string(),
                    truncated: captured.truncated,
                },
                path_index,
            );
        }
    }

    fn collect_redactions(&mut self, records: Vec<RedactionRecord>) {
        for record in records {
            self.redacted_fields.insert(record.rule);
        }
    }

    fn push(&mut self, captured: CapturedMatch, path_index: usize) {
        let captured_bytes = match_storage_bytes(&captured);
        let slot = &mut self.slots[path_index];
        if let Some(existing) = slot
            .iter_mut()
            .find(|existing| existing.dedup_path == captured.dedup_path)
        {
            let previous_bytes = match_storage_bytes(existing);
            let next_bytes = self
                .result_bytes
                .saturating_sub(previous_bytes)
                .saturating_add(captured_bytes);
            if next_bytes > MAX_EXTRACTED_RESULT_BYTES {
                self.result_limited = true;
                self.path_limited[path_index] = true;
                self.omitted_paths.insert(path_index);
                slot.retain(|matched| matched.dedup_path != captured.dedup_path);
                self.result_bytes = self.result_bytes.saturating_sub(previous_bytes);
                return;
            }
            self.result_bytes = next_bytes;
            *existing = captured;
            return;
        }
        if slot.len() >= MAX_JSON_PATH_MATCHES {
            self.path_limited[path_index] = true;
            return;
        }
        if self.result_bytes.saturating_add(captured_bytes) > MAX_EXTRACTED_RESULT_BYTES {
            self.result_limited = true;
            self.path_limited[path_index] = true;
            self.omitted_paths.insert(path_index);
            return;
        }
        self.result_bytes = self.result_bytes.saturating_add(captured_bytes);
        slot.push(captured);
    }
}

fn match_storage_bytes(captured: &CapturedMatch) -> usize {
    let value_bytes = serde_json::to_vec(&captured.value).map_or(0, |value| value.len());
    let summary_bytes = captured
        .value_summary
        .as_ref()
        .and_then(|summary| serde_json::to_vec(summary).ok())
        .map_or(0, |summary| summary.len());
    value_bytes
        .saturating_add(summary_bytes)
        .saturating_add(captured.dedup_path.len())
        .saturating_add(captured.value_type.len())
        .saturating_add(64)
}

#[derive(Clone)]
struct CaptureSeed<'a> {
    nodes: Vec<&'a PathNode>,
    path: String,
    collect_all: bool,
    depth: usize,
    state: Rc<RefCell<ExtractionState>>,
}

impl<'de, 'a> DeserializeSeed<'de> for CaptureSeed<'a> {
    type Value = CapturedValue;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        let terminals = collect_terminals(&self.nodes);
        let build = self.collect_all || !terminals.is_empty();
        let routes = self.nodes.iter().any(|node| node.has_routes());
        if !build && !routes {
            DepthLimitedIgnoredSeed { depth: self.depth }.deserialize(deserializer)?;
            return Ok(CapturedValue::ignored());
        }

        let captured = deserializer.deserialize_any(CaptureVisitor {
            nodes: self.nodes,
            path: self.path.clone(),
            build,
            depth: self.depth,
            state: Rc::clone(&self.state),
        })?;
        if !terminals.is_empty() {
            self.state
                .borrow_mut()
                .capture(&terminals, &self.path, captured.clone());
        }
        Ok(captured)
    }
}

struct CaptureVisitor<'a> {
    nodes: Vec<&'a PathNode>,
    path: String,
    build: bool,
    depth: usize,
    state: Rc<RefCell<ExtractionState>>,
}

impl<'de, 'a> Visitor<'de> for CaptureVisitor<'a> {
    type Value = CapturedValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        ensure_json_depth::<A::Error>(self.depth)?;
        let mut object = Map::new();
        let mut serialized_size = 2usize;
        let mut key_count = 0usize;
        let mut summary_keys = Vec::new();
        let mut truncated = false;

        while let Some(key) = map.next_key::<String>()? {
            key_count += 1;
            let child_nodes = child_nodes_for_key(&self.nodes, &key);
            let child_terminals = collect_terminals(&child_nodes);
            let has_child_routes = child_nodes.iter().any(|node| node.has_routes());
            if !self.build && child_terminals.is_empty() && !has_child_routes {
                map.next_value_seed(DepthLimitedIgnoredSeed {
                    depth: self.depth + 1,
                })?;
                continue;
            }

            let child_path = append_key_path(&self.path, &key);
            let sensitive =
                !self.state.borrow().raw && self.state.borrow().redactor.is_sensitive_name(&key);
            let child_build = self.build || !child_terminals.is_empty();

            let captured = if sensitive {
                let captured = map.next_value_seed(SensitiveValueSeed {
                    key: &key,
                    path: child_path.clone(),
                    depth: self.depth + 1,
                    state: Rc::clone(&self.state),
                })?;
                if self.build {
                    append_object_entry(
                        &mut object,
                        &mut serialized_size,
                        &mut truncated,
                        key.clone(),
                        captured.value.clone(),
                    );
                    push_summary_key(&mut summary_keys, &key, &captured);
                }
                if !child_terminals.is_empty() {
                    self.state.borrow_mut().capture_sensitive(
                        &child_terminals,
                        &child_path,
                        captured,
                    );
                }
                continue;
            } else {
                map.next_value_seed(CaptureSeed {
                    nodes: child_nodes,
                    path: child_path.clone(),
                    collect_all: child_build,
                    depth: self.depth + 1,
                    state: Rc::clone(&self.state),
                })?
            };

            if self.build {
                append_object_entry(
                    &mut object,
                    &mut serialized_size,
                    &mut truncated,
                    key.clone(),
                    captured.value.clone(),
                );
                push_summary_key(&mut summary_keys, &key, &captured);
            }
        }

        if !self.build {
            return Ok(CapturedValue::ignored());
        }

        if truncated {
            let summary = bounded_summary(json!({
                "kind": "object",
                "sizeBytes": Value::Null,
                "keyCount": key_count,
                "returnedKeys": summary_keys.len(),
                "keys": summary_keys,
                "arrayLength": Value::Null,
                "items": [],
            }));
            Ok(CapturedValue {
                value: Value::Null,
                value_type: "object",
                value_summary: Some(summary),
                truncated: true,
                serialized_size,
                already_redacted: !self.state.borrow().raw,
            })
        } else {
            let value = Value::Object(object);
            let serialized_size = serde_json::to_vec(&value).map_or(serialized_size, |v| v.len());
            Ok(CapturedValue {
                value,
                value_type: "object",
                value_summary: None,
                truncated: false,
                serialized_size,
                already_redacted: !self.state.borrow().raw,
            })
        }
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        ensure_json_depth::<A::Error>(self.depth)?;
        let mut items = Vec::new();
        let mut serialized_size = 2usize;
        let mut index = 0usize;
        let mut summary_items = Vec::new();
        let mut truncated = false;

        loop {
            let child_nodes = child_nodes_for_index(&self.nodes, index);
            let child_terminals = collect_terminals(&child_nodes);
            let has_child_routes = child_nodes.iter().any(|node| node.has_routes());
            if !self.build && child_terminals.is_empty() && !has_child_routes {
                if seq
                    .next_element_seed(DepthLimitedIgnoredSeed {
                        depth: self.depth + 1,
                    })?
                    .is_none()
                {
                    break;
                }
            } else {
                let child_path = append_index_path(&self.path, index);
                let child_build = self.build || !child_terminals.is_empty();
                let Some(captured) = seq.next_element_seed(CaptureSeed {
                    nodes: child_nodes,
                    path: child_path,
                    collect_all: child_build,
                    depth: self.depth + 1,
                    state: Rc::clone(&self.state),
                })?
                else {
                    break;
                };
                if self.build {
                    append_array_entry(
                        &mut items,
                        &mut serialized_size,
                        &mut truncated,
                        captured.value.clone(),
                    );
                    if summary_items.len() < MAX_SUMMARY_ITEMS {
                        summary_items.push(summary_item(index, &captured));
                    }
                }
            }
            index = index.saturating_add(1);
        }

        if !self.build {
            return Ok(CapturedValue::ignored());
        }

        if truncated {
            let summary = bounded_summary(json!({
                "kind": "array",
                "sizeBytes": Value::Null,
                "keyCount": Value::Null,
                "returnedKeys": Value::Null,
                "keys": [],
                "arrayLength": index,
                "items": summary_items,
            }));
            Ok(CapturedValue {
                value: Value::Null,
                value_type: "array",
                value_summary: Some(summary),
                truncated: true,
                serialized_size,
                already_redacted: !self.state.borrow().raw,
            })
        } else {
            let value = Value::Array(items);
            let serialized_size = serde_json::to_vec(&value).map_or(serialized_size, |v| v.len());
            Ok(CapturedValue {
                value,
                value_type: "array",
                value_summary: None,
                truncated: false,
                serialized_size,
                already_redacted: !self.state.borrow().raw,
            })
        }
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(complete_scalar(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(complete_scalar(Value::Number(value.into())))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(complete_scalar(Value::Number(value.into())))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
        Ok(complete_scalar(
            serde_json::Number::from_f64(value)
                .map(Value::Number)
                .unwrap_or(Value::Null),
        ))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(captured_string(value, &self.path, &self.state))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(captured_string(&value, &self.path, &self.state))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(complete_scalar(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(complete_scalar(Value::Null))
    }
}

struct SensitiveValueSeed<'a> {
    key: &'a str,
    path: String,
    depth: usize,
    state: Rc<RefCell<ExtractionState>>,
}

impl<'de, 'a> DeserializeSeed<'de> for SensitiveValueSeed<'a> {
    type Value = CapturedValue;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        let candidate =
            deserializer.deserialize_any(SensitiveValueVisitor { depth: self.depth })?;
        let mut value = candidate;
        let mut records = Vec::new();
        let mut state = self.state.borrow_mut();
        state
            .redactor
            .redact_json_field(self.key, &mut value, &self.path, &mut records);
        state.collect_redactions(records);
        let serialized_size = serde_json::to_vec(&value).map_or(0, |v| v.len());
        Ok(CapturedValue {
            value_type: json_type_name(&value),
            value,
            value_summary: None,
            truncated: false,
            serialized_size,
            already_redacted: true,
        })
    }
}

struct SensitiveValueVisitor {
    depth: usize,
}

impl<'de> Visitor<'de> for SensitiveValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a sensitive JSON value")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        ensure_json_depth::<A::Error>(self.depth)?;
        while map.next_key::<IgnoredAny>()?.is_some() {
            map.next_value_seed(DepthLimitedIgnoredSeed {
                depth: self.depth + 1,
            })?;
        }
        Ok(Value::Object(Map::new()))
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        ensure_json_depth::<A::Error>(self.depth)?;
        while seq
            .next_element_seed(DepthLimitedIgnoredSeed {
                depth: self.depth + 1,
            })?
            .is_some()
        {}
        Ok(Value::Array(Vec::new()))
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
        Ok(serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Value::String(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }
}

struct DepthLimitedIgnoredSeed {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for DepthLimitedIgnoredSeed {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(DepthLimitedIgnoredVisitor { depth: self.depth })
    }
}

struct DepthLimitedIgnoredVisitor {
    depth: usize,
}

impl<'de> Visitor<'de> for DepthLimitedIgnoredVisitor {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an ignored JSON value")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        ensure_json_depth::<A::Error>(self.depth)?;
        while map.next_key::<IgnoredAny>()?.is_some() {
            map.next_value_seed(DepthLimitedIgnoredSeed {
                depth: self.depth + 1,
            })?;
        }
        Ok(())
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        ensure_json_depth::<A::Error>(self.depth)?;
        while seq
            .next_element_seed(DepthLimitedIgnoredSeed {
                depth: self.depth + 1,
            })?
            .is_some()
        {}
        Ok(())
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
}

fn ensure_json_depth<E: DeError>(depth: usize) -> Result<(), E> {
    if depth >= MAX_JSON_DEPTH {
        return Err(E::custom(format!(
            "recursion limit exceeded: maximum JSON depth is {MAX_JSON_DEPTH}"
        )));
    }
    Ok(())
}

fn complete_scalar(value: Value) -> CapturedValue {
    let serialized_size = serde_json::to_vec(&value).map_or(0, |v| v.len());
    CapturedValue {
        value_type: json_type_name(&value),
        value,
        value_summary: None,
        truncated: false,
        serialized_size,
        already_redacted: false,
    }
}

fn captured_string(value: &str, path: &str, state: &Rc<RefCell<ExtractionState>>) -> CapturedValue {
    let (value, already_redacted) = {
        let mut state = state.borrow_mut();
        if state.raw {
            (value.to_string(), false)
        } else {
            let mut redacted = Value::String(value.to_string());
            let mut records = Vec::new();
            state
                .redactor
                .redact_json_value(&mut redacted, path, &mut records);
            state.collect_redactions(records);
            match redacted {
                Value::String(value) => (value, true),
                _ => (value.to_string(), false),
            }
        }
    };
    if value.len() <= MAX_EXTRACTED_VALUE_BYTES {
        let mut captured = complete_scalar(Value::String(value));
        captured.already_redacted = already_redacted;
        return captured;
    }

    let mut end = MAX_EXTRACTED_VALUE_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let original_size =
        serde_json::to_vec(&Value::String(value.to_string())).map_or(value.len(), |v| v.len());
    let bounded = format!("{}…[truncated]", &value[..end]);
    let serialized_size =
        serde_json::to_vec(&Value::String(bounded.clone())).map_or(original_size, |v| v.len());
    let summary = json!({
        "kind": "string",
        "sizeBytes": original_size,
        "keyCount": Value::Null,
        "returnedKeys": Value::Null,
        "keys": [],
        "arrayLength": Value::Null,
        "items": [],
    });
    CapturedValue {
        value: Value::String(bounded),
        value_type: "string",
        value_summary: Some(summary),
        truncated: true,
        serialized_size,
        already_redacted,
    }
}

fn append_object_entry(
    object: &mut Map<String, Value>,
    serialized_size: &mut usize,
    truncated: &mut bool,
    key: String,
    value: Value,
) {
    if *truncated {
        return;
    }
    let key_size =
        serde_json::to_vec(&Value::String(key.clone())).map_or(key.len() + 2, |v| v.len());
    let comma = usize::from(!object.is_empty());
    let next_size = serialized_size
        .saturating_add(comma)
        .saturating_add(key_size)
        .saturating_add(1)
        .saturating_add(
            serde_json::to_vec(&value)
                .map(|v| v.len())
                .unwrap_or(MAX_EXTRACTED_VALUE_BYTES + 1),
        );
    if next_size > MAX_EXTRACTED_VALUE_BYTES {
        *truncated = true;
        *serialized_size = next_size;
        object.clear();
        return;
    }
    object.insert(key, value);
    *serialized_size = next_size;
}

fn append_array_entry(
    items: &mut Vec<Value>,
    serialized_size: &mut usize,
    truncated: &mut bool,
    value: Value,
) {
    if *truncated {
        return;
    }
    let comma = usize::from(!items.is_empty());
    let next_size = serialized_size.saturating_add(comma).saturating_add(
        serde_json::to_vec(&value)
            .map(|v| v.len())
            .unwrap_or(MAX_EXTRACTED_VALUE_BYTES + 1),
    );
    if next_size > MAX_EXTRACTED_VALUE_BYTES {
        *truncated = true;
        *serialized_size = next_size;
        items.clear();
        return;
    }
    items.push(value);
    *serialized_size = next_size;
}

fn push_summary_key(keys: &mut Vec<Value>, key: &str, captured: &CapturedValue) {
    if keys.len() < MAX_SUMMARY_KEYS {
        keys.push(json!({
            "name": truncate_text(key, MAX_SUMMARY_KEY_CHARS),
            "kind": captured.value_type,
            "sizeBytes": summary_size_bytes(captured),
        }));
    }
}

fn summary_item(index: usize, captured: &CapturedValue) -> Value {
    json!({
        "index": index,
        "kind": captured.value_type,
        "sizeBytes": summary_size_bytes(captured),
    })
}

fn summary_size_bytes(captured: &CapturedValue) -> Value {
    if matches!(captured.value_type, "object" | "array") {
        Value::Null
    } else {
        json!(captured.serialized_size)
    }
}

fn bounded_summary(mut summary: Value) -> Value {
    loop {
        if serde_json::to_vec(&summary).map_or(0, |value| value.len()) <= MAX_SUMMARY_BYTES {
            return summary;
        }
        let remaining_keys = summary
            .get_mut("keys")
            .and_then(Value::as_array_mut)
            .and_then(|keys| keys.pop().map(|_| keys.len()));
        if let Some(remaining_keys) = remaining_keys {
            summary["returnedKeys"] = json!(remaining_keys);
            continue;
        }
        if let Some(items) = summary.get_mut("items").and_then(Value::as_array_mut) {
            if items.pop().is_some() {
                continue;
            }
        }
        return summary;
    }
}

fn collect_terminals(nodes: &[&PathNode]) -> Vec<usize> {
    let mut terminals = nodes
        .iter()
        .flat_map(|node| node.terminals.iter().copied())
        .collect::<Vec<_>>();
    terminals.sort_unstable();
    terminals.dedup();
    terminals
}

fn child_nodes_for_key<'a>(nodes: &[&'a PathNode], key: &str) -> Vec<&'a PathNode> {
    let mut children = Vec::new();
    for node in nodes {
        if let Some(child) = node.keys.get(key) {
            children.push(child);
        }
        if let Some(wildcard) = node.wildcard.as_deref() {
            children.push(wildcard);
        }
    }
    children
}

fn child_nodes_for_index<'a>(nodes: &[&'a PathNode], index: usize) -> Vec<&'a PathNode> {
    let mut children = Vec::new();
    for node in nodes {
        if let Some(child) = node.indices.get(&index) {
            children.push(child);
        }
        if let Some(wildcard) = node.wildcard.as_deref() {
            children.push(wildcard);
        }
    }
    children
}

pub(crate) fn extract_json_paths(
    store: &BodyStore,
    reference: &StoredBodyReference,
    decoded_size_bytes: u64,
    segments: &[Vec<JsonPathSegment>],
    raw: bool,
    redactor: &Redactor,
) -> Result<JsonPathExtraction, ToolError> {
    if decoded_size_bytes > MAX_JSON_PATH_SCAN_BYTES as u64 {
        return Err(scan_limit_error(decoded_size_bytes));
    }
    if segments.iter().any(Vec::is_empty) && decoded_size_bytes > ROOT_PATH_SCAN_BYTES as u64 {
        return Err(ToolError::new(
            "BODY_TOO_LARGE",
            "The root JSON path ($) is limited to 8 MiB. Request a specific field path instead of the full root value.",
        )
        .with_details(json!({
            "decodedSizeBytes": decoded_size_bytes,
            "reason": "rootPathTooLarge",
            "rootPathLimitBytes": ROOT_PATH_SCAN_BYTES,
        })));
    }

    let (hash, inline_bytes) = match &reference.file_path {
        Some(path) => (validate_file(store, path)?, None),
        None => {
            let bytes = decode_inline_reference(reference)?;
            let hash = validate_bytes(&bytes)?;
            (hash, Some(bytes))
        }
    };

    let root = build_path_tree(segments);
    let state = Rc::new(RefCell::new(ExtractionState::new(
        segments.len(),
        raw,
        redactor.clone(),
    )));

    match inline_bytes {
        Some(bytes) => parse_reader(
            Cursor::new(bytes),
            &root,
            Rc::clone(&state),
            reference.truncated,
        )?,
        None => {
            let path = reference.file_path.as_deref().ok_or_else(|| {
                ToolError::new(
                    "BODY_NOT_FOUND",
                    "The body reference contains no readable payload.",
                )
            })?;
            let reader = store.open_body_reader(path).map_err(|error| {
                ToolError::new(
                    "BODY_NOT_FOUND",
                    format!("The stored body file is unavailable: {error}"),
                )
                .with_details(json!({ "reason": "fileMissing" }))
            })?;
            parse_reader(reader, &root, Rc::clone(&state), reference.truncated)?;
        }
    }

    let state = state.borrow();
    let values = build_results(
        segments,
        &state.slots,
        &state.path_limited,
        &state.omitted_paths,
    );
    let truncated = state.path_limited.iter().any(|limited| *limited)
        || state.result_limited
        || state
            .slots
            .iter()
            .flatten()
            .any(|matched| matched.truncated);
    let view_size_bytes = serde_json::to_vec(&values).map_or(0, |value| value.len());
    let mut redacted_fields = state.redacted_fields.iter().cloned().collect::<Vec<_>>();
    redacted_fields.sort();
    redacted_fields.dedup();

    Ok(JsonPathExtraction {
        values,
        truncated,
        redacted_fields,
        view_size_bytes,
        hash,
    })
}

fn parse_reader<R: Read>(
    reader: R,
    root: &PathNode,
    state: Rc<RefCell<ExtractionState>>,
    capture_truncated: bool,
) -> Result<(), ToolError> {
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    CaptureSeed {
        nodes: vec![root],
        path: "$".to_string(),
        collect_all: root.has_terminals(),
        depth: 0,
        state,
    }
    .deserialize(&mut deserializer)
    .map_err(|error| json_parse_error(error.to_string(), capture_truncated))?;
    deserializer
        .end()
        .map_err(|error| json_parse_error(error.to_string(), capture_truncated))?;
    Ok(())
}

fn json_parse_error(message: String, capture_truncated: bool) -> ToolError {
    let code = if message.contains("recursion limit exceeded") {
        "JSON_TOO_DEEP"
    } else {
        "BODY_NOT_JSON"
    };
    let mut details = json!({
        "reason": if code == "JSON_TOO_DEEP" { "depthLimit" } else { "invalidJson" },
        "captureTruncated": capture_truncated,
    });
    if code == "JSON_TOO_DEEP" {
        details["maxDepth"] = json!(MAX_JSON_DEPTH);
    }
    let error_message = if code == "JSON_TOO_DEEP" {
        format!("The JSON body exceeds the maximum supported depth: {message}")
    } else {
        format!("The body is not valid JSON: {message}")
    };
    ToolError::new(code, error_message).with_details(details)
}

fn validate_file(store: &BodyStore, path: &str) -> Result<String, ToolError> {
    let mut reader = store.open_body_reader(path).map_err(|error| {
        ToolError::new(
            "BODY_NOT_FOUND",
            format!("The stored body file is unavailable: {error}"),
        )
        .with_details(json!({ "reason": "fileMissing" }))
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut pending = Vec::new();
    let mut total = 0usize;
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            ToolError::new(
                "BODY_NOT_FOUND",
                format!("Unable to read the stored body file: {error}"),
            )
            .with_details(json!({ "reason": "fileReadFailed" }))
        })?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read);
        if total > MAX_JSON_PATH_SCAN_BYTES {
            return Err(scan_limit_error(total as u64));
        }
        hasher.update(&buffer[..read]);
        validate_utf8_chunk(&mut pending, &buffer[..read])?;
    }
    if !pending.is_empty() {
        return Err(invalid_utf8_error());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_bytes(bytes: &[u8]) -> Result<String, ToolError> {
    if bytes.len() > MAX_JSON_PATH_SCAN_BYTES {
        return Err(scan_limit_error(bytes.len() as u64));
    }
    std::str::from_utf8(bytes).map_err(|_| invalid_utf8_error())?;
    Ok(crate::tools::body::sha256_hex(bytes))
}

fn validate_utf8_chunk(pending: &mut Vec<u8>, chunk: &[u8]) -> Result<(), ToolError> {
    pending.extend_from_slice(chunk);
    match std::str::from_utf8(pending) {
        Ok(_) => {
            pending.clear();
            Ok(())
        }
        Err(error) if error.error_len().is_none() => {
            let valid = error.valid_up_to();
            pending.drain(..valid);
            Ok(())
        }
        Err(_) => Err(invalid_utf8_error()),
    }
}

fn invalid_utf8_error() -> ToolError {
    ToolError::new("BODY_NOT_JSON", "The body is not UTF-8 JSON.").with_details(json!({
        "reason": "invalidUtf8",
    }))
}

fn scan_limit_error(decoded_size_bytes: u64) -> ToolError {
    ToolError::new(
        "BODY_TOO_LARGE",
        format!(
            "JSON field extraction requires scanning the complete body, but it exceeds {} bytes.",
            MAX_JSON_PATH_SCAN_BYTES
        ),
    )
    .with_details(json!({
        "reason": "scanLimit",
        "decodedSizeBytes": decoded_size_bytes,
        "scanLimitBytes": MAX_JSON_PATH_SCAN_BYTES,
    }))
}

fn build_path_tree(segments: &[Vec<JsonPathSegment>]) -> PathNode {
    let mut root = PathNode::default();
    for (path_index, path) in segments.iter().enumerate() {
        let mut node = &mut root;
        for segment in path {
            node = match segment {
                JsonPathSegment::Key(key) => node.keys.entry(key.clone()).or_default(),
                JsonPathSegment::Index(index) => node.indices.entry(*index).or_default(),
                JsonPathSegment::Wildcard => node
                    .wildcard
                    .get_or_insert_with(|| Box::new(PathNode::default())),
            };
        }
        node.terminals.push(path_index);
    }
    root
}

fn build_results(
    segments: &[Vec<JsonPathSegment>],
    slots: &[Vec<CapturedMatch>],
    path_limited: &[bool],
    omitted_paths: &BTreeSet<usize>,
) -> Vec<Value> {
    segments
        .iter()
        .enumerate()
        .map(|(path_index, path_segments)| {
            let path = render_json_path(path_segments);
            let matches = &slots[path_index];
            let omitted = omitted_paths.contains(&path_index);
            if matches.is_empty() {
                return json!({
                    "path": path,
                    "found": false,
                    "value": Value::Null,
                    "valueType": "missing",
                    "matchCount": 0,
                    "truncated": path_limited[path_index] || omitted,
                    "valueSummary": Value::Null,
                    "omittedByResultLimit": omitted,
                });
            }

            let contains_wildcard = path_segments
                .iter()
                .any(|segment| matches!(segment, JsonPathSegment::Wildcard));
            let truncated = path_limited[path_index]
                || matches.iter().any(|matched| matched.truncated);
            let value = if contains_wildcard || matches.len() > 1 {
                Value::Array(matches.iter().map(|matched| matched.value.clone()).collect())
            } else {
                matches[0].value.clone()
            };
            let value_summary = if matches.len() == 1 {
                matches[0].value_summary.clone().unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            json!({
                "path": path,
                "found": true,
                "value": value,
                "valueType": if contains_wildcard { "array".to_string() } else { matches[0].value_type.clone() },
                "matchCount": matches.len(),
                "truncated": truncated,
                "valueSummary": value_summary,
                "omittedByResultLimit": false,
            })
        })
        .collect()
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max_chars).collect::<String>())
}

fn append_key_path(path: &str, key: &str) -> String {
    if key
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        format!("{path}.{key}")
    } else {
        format!(
            "{path}['{}']",
            key.replace('\\', "\\\\").replace('\'', "\\'")
        )
    }
}

fn append_index_path(path: &str, index: usize) -> String {
    format!("{path}[{index}]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AgentAccessConfig;
    use crate::tools::body::parse_json_paths;
    use std::io::Write;

    fn test_store() -> (tempfile::TempDir, BodyStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = BodyStore::new(directory.path().to_path_buf());
        store.ensure_dir().unwrap();
        (directory, store)
    }

    fn inline_reference(text: &str) -> StoredBodyReference {
        StoredBodyReference {
            file_path: None,
            inline_text: Some(text.to_string()),
            base64_text: None,
            mime_type: Some("application/json".to_string()),
            encoding: None,
            size_bytes: text.len() as u64,
            truncated: false,
        }
    }

    fn file_reference(store: &BodyStore, text: &str) -> StoredBodyReference {
        let path = store.write_body("s1", "response", text.as_bytes()).unwrap();
        StoredBodyReference {
            file_path: Some(path),
            inline_text: None,
            base64_text: None,
            mime_type: Some("application/json".to_string()),
            encoding: None,
            size_bytes: text.len() as u64,
            truncated: false,
        }
    }

    fn redactor() -> Redactor {
        Redactor::from_config(
            &AgentAccessConfig::default(),
            std::path::Path::new("/tmp/test"),
        )
        .unwrap()
    }

    fn extract(
        store: &BodyStore,
        reference: &StoredBodyReference,
        paths: &[&str],
        raw: bool,
    ) -> JsonPathExtraction {
        let paths = paths
            .iter()
            .map(|path| path.to_string())
            .collect::<Vec<_>>();
        let segments = parse_json_paths(&paths).unwrap();
        extract_json_paths(
            store,
            reference,
            reference
                .inline_text
                .as_deref()
                .map(|text| text.len() as u64)
                .unwrap_or_else(|| {
                    store
                        .read_body(reference.file_path.as_deref().unwrap())
                        .unwrap()
                        .len() as u64
                }),
            &segments,
            raw,
            &redactor(),
        )
        .unwrap()
    }

    #[test]
    fn streams_above_eight_mib_and_returns_only_target_fields() {
        let (_directory, store) = test_store();
        let padding = "x".repeat(8 * 1024 * 1024 + 1024);
        let body = format!(
            "{{\"before\":\"{}\",\"target\":{{\"flag\":\"B\"}},\"after\":\"{}\"}}",
            padding, padding
        );
        let reference = file_reference(&store, &body);
        let result = extract(&store, &reference, &["$.target.flag"], false);
        assert_eq!(result.values[0]["value"], "B");
        assert!(result.view_size_bytes < 1024);
    }

    #[test]
    fn oversized_object_returns_summary_that_can_be_used_for_drilldown() {
        let (_directory, store) = test_store();
        let large = "x".repeat(MAX_EXTRACTED_VALUE_BYTES + 20);
        let body = format!(
            "{{\"target\":{{\"small\":\"ok\",\"blob\":\"{}\",\"later\":42}}}}",
            large
        );
        let reference = inline_reference(&body);
        let result = extract(&store, &reference, &["$.target"], false);
        assert_eq!(result.values[0]["value"], Value::Null);
        assert_eq!(result.values[0]["truncated"], true);
        let keys = result.values[0]["valueSummary"]["keys"].as_array().unwrap();
        assert!(keys.iter().any(|key| key["name"] == "later"));
        let result = extract(&store, &reference, &["$.target.later"], false);
        assert_eq!(result.values[0]["value"], 42);
    }

    #[test]
    fn truncates_large_scalar_and_reports_summary() {
        let (_directory, store) = test_store();
        let large = "y".repeat(MAX_EXTRACTED_VALUE_BYTES + 20);
        let reference = inline_reference(&format!("{{\"target\":\"{large}\"}}"));
        let result = extract(&store, &reference, &["$.target"], false);
        assert!(result.values[0]["value"]
            .as_str()
            .unwrap()
            .ends_with("…[truncated]"));
        assert_eq!(result.values[0]["truncated"], true);
        assert_eq!(result.values[0]["valueSummary"]["kind"], "string");
    }

    #[test]
    fn redacts_nested_and_sensitive_target_fields() {
        let (_directory, store) = test_store();
        let reference = inline_reference(
            r#"{"user":{"email":"a@example.com","token":"secret"},"deviceId":"abc"}"#,
        );
        let result = extract(&store, &reference, &["$.user", "$.deviceId"], false);
        assert!(result.values[0]["value"]["token"]
            .as_str()
            .unwrap()
            .starts_with("[REDACTED"));
        assert!(result.values[0]["value"]["email"]
            .as_str()
            .unwrap()
            .starts_with("[EMAIL:"));
        assert!(result.values[1]["value"]
            .as_str()
            .unwrap()
            .starts_with("[ID:"));
        assert!(!result.redacted_fields.is_empty());
    }

    #[test]
    fn sensitive_ancestor_cannot_be_bypassed() {
        let (_directory, store) = test_store();
        let reference = inline_reference(r#"{"token":{"nested":"visible"}}"#);
        let result = extract(&store, &reference, &["$.token.nested"], false);
        assert_eq!(result.values[0]["found"], false);
        let result = extract(&store, &reference, &["$.token"], false);
        assert_eq!(result.values[0]["value"], "[REDACTED]");
    }

    #[test]
    fn duplicate_keys_use_the_last_source_value() {
        let (_directory, store) = test_store();
        let reference = inline_reference(r#"{"target":"first","target":"last"}"#);
        let result = extract(&store, &reference, &["$.target"], false);
        assert_eq!(result.values[0]["value"], "last");
    }

    #[test]
    fn object_wildcard_uses_source_order() {
        let (_directory, store) = test_store();
        let reference = inline_reference(r#"{"items":{"z":1,"a":2,"m":3}}"#);
        let result = extract(&store, &reference, &["$.items[*]"], true);
        assert_eq!(result.values[0]["value"], json!([1, 2, 3]));
    }

    #[test]
    fn wildcard_match_count_is_bounded_and_marked_truncated() {
        let (_directory, store) = test_store();
        let values = (0..300).map(|value| value.to_string()).collect::<Vec<_>>();
        let reference = inline_reference(&format!("{{\"items\":[{}]}}", values.join(",")));
        let result = extract(&store, &reference, &["$.items[*]"], true);
        assert_eq!(result.values[0]["matchCount"], MAX_JSON_PATH_MATCHES);
        assert_eq!(result.values[0]["truncated"], true);
        assert!(result.truncated);
    }

    #[test]
    fn missing_paths_are_reported_as_not_found() {
        let (_directory, store) = test_store();
        let reference = inline_reference(r#"{"items":[]}"#);
        let result = extract(&store, &reference, &["$.items[4].name"], true);
        assert_eq!(result.values[0]["found"], false);
        assert_eq!(result.values[0]["valueType"], "missing");
    }

    #[test]
    fn oversized_summary_stays_within_four_kibibytes() {
        let (_directory, store) = test_store();
        let mut target = Map::new();
        for index in 0..40 {
            target.insert(
                format!("{index:02}_{}", "界".repeat(80)),
                Value::String("x".repeat(2048)),
            );
        }
        let reference = inline_reference(&json!({ "target": target }).to_string());
        let result = extract(&store, &reference, &["$.target"], false);
        let summary = &result.values[0]["valueSummary"];
        assert!(serde_json::to_vec(summary).unwrap().len() <= MAX_SUMMARY_BYTES);
        assert_eq!(
            summary["returnedKeys"].as_u64().unwrap() as usize,
            summary["keys"].as_array().unwrap().len()
        );
    }

    #[test]
    fn result_budget_omits_later_paths_instead_of_exceeding_response_budget() {
        let (_directory, store) = test_store();
        let mut paths = Vec::new();
        let mut object = Map::new();
        for index in 0..20 {
            let key = format!("p{index}");
            object.insert(key.clone(), Value::String("x".repeat(63 * 1024)));
            paths.push(format!("$.root.{key}"));
        }
        let reference = inline_reference(&json!({ "root": object }).to_string());
        let borrowed_paths = paths.iter().map(String::as_str).collect::<Vec<_>>();
        let result = extract(&store, &reference, &borrowed_paths, true);
        assert!(result.truncated);
        assert!(result
            .values
            .iter()
            .any(|value| value["omittedByResultLimit"] == true));
        assert!(serde_json::to_vec(&result.values).unwrap().len() < 1024 * 1024);
    }

    #[test]
    fn rejects_invalid_utf8_and_truncated_json_without_partial_results() {
        let (directory, store) = test_store();
        let path = directory.path().join("bad.body");
        std::fs::write(&path, b"{\"target\":\"ok\",\"tail\":").unwrap();
        let reference = StoredBodyReference {
            file_path: Some("bad.body".to_string()),
            inline_text: None,
            base64_text: None,
            mime_type: None,
            encoding: None,
            size_bytes: 20,
            truncated: true,
        };
        let error = extract_json_paths(
            &store,
            &reference,
            19,
            &parse_json_paths(&["$.target".to_string()]).unwrap(),
            false,
            &redactor(),
        )
        .unwrap_err();
        assert_eq!(error.code, "BODY_NOT_JSON");
        assert_eq!(error.details.unwrap()["captureTruncated"], true);

        let mut file = std::fs::File::create(directory.path().join("utf8.body")).unwrap();
        file.write_all(b"{\"target\":\"ok\",\"bad\":\"\xff\"}")
            .unwrap();
        let reference = StoredBodyReference {
            file_path: Some("utf8.body".to_string()),
            inline_text: None,
            base64_text: None,
            mime_type: None,
            encoding: None,
            size_bytes: 24,
            truncated: false,
        };
        let error = extract_json_paths(
            &store,
            &reference,
            24,
            &parse_json_paths(&["$.target".to_string()]).unwrap(),
            false,
            &redactor(),
        )
        .unwrap_err();
        assert_eq!(error.code, "BODY_NOT_JSON");
        assert_eq!(error.details.unwrap()["reason"], "invalidUtf8");
    }

    #[test]
    fn root_path_above_eight_mib_is_rejected() {
        let (_directory, store) = test_store();
        let reference = inline_reference("{}");
        let error = extract_json_paths(
            &store,
            &reference,
            ROOT_PATH_SCAN_BYTES as u64 + 1,
            &parse_json_paths(&["$".to_string()]).unwrap(),
            false,
            &redactor(),
        )
        .unwrap_err();
        assert_eq!(error.code, "BODY_TOO_LARGE");
        assert_eq!(error.details.unwrap()["reason"], "rootPathTooLarge");
    }

    #[test]
    fn body_above_scan_limit_is_rejected_before_reading() {
        let (_directory, store) = test_store();
        let reference = inline_reference("{}");
        let error = extract_json_paths(
            &store,
            &reference,
            MAX_JSON_PATH_SCAN_BYTES as u64 + 1,
            &parse_json_paths(&["$.target".to_string()]).unwrap(),
            false,
            &redactor(),
        )
        .unwrap_err();
        assert_eq!(error.code, "BODY_TOO_LARGE");
        assert_eq!(error.details.unwrap()["reason"], "scanLimit");
    }

    #[test]
    fn excessive_json_depth_is_reported_as_json_too_deep() {
        let (_directory, store) = test_store();
        let body = format!("{}0{}", "[".repeat(160), "]".repeat(160));
        let reference = inline_reference(&body);
        let error = extract_json_paths(
            &store,
            &reference,
            body.len() as u64,
            &parse_json_paths(&["$.target".to_string()]).unwrap(),
            false,
            &redactor(),
        )
        .unwrap_err();
        assert_eq!(error.code, "JSON_TOO_DEEP");
        assert_eq!(error.details.unwrap()["maxDepth"], 128);
    }
}
