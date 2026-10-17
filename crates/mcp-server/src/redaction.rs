use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const REDACTED_VALUE: &str = "[REDACTED]";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderEntry {
    pub name: String,
    pub value: String,
    // Persisted proxy headers use `is_pseudo`; keep the camelCase output while
    // accepting both spellings from older and newer database rows.
    #[serde(skip_serializing_if = "Option::is_none", alias = "is_pseudo")]
    pub is_pseudo: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct RedactionOutput<T> {
    pub value: T,
    pub fields: Vec<String>,
}

pub fn redact_headers_json(json: &str) -> RedactionOutput<Vec<HeaderEntry>> {
    let mut fields = BTreeSet::new();
    let headers = serde_json::from_str::<Vec<HeaderEntry>>(json)
        .unwrap_or_default()
        .into_iter()
        .map(|mut header| {
            if is_sensitive_name(&header.name) {
                fields.insert(header.name.to_lowercase());
                header.value = REDACTED_VALUE.to_string();
            }
            header
        })
        .collect();

    RedactionOutput {
        value: headers,
        fields: fields.into_iter().collect(),
    }
}

pub fn redact_cookie_headers(headers: Vec<HeaderEntry>) -> RedactionOutput<Vec<HeaderEntry>> {
    let mut fields = BTreeSet::new();
    let headers = headers
        .into_iter()
        .map(|mut header| {
            fields.insert(header.name.to_lowercase());
            header.value = REDACTED_VALUE.to_string();
            header
        })
        .collect();
    RedactionOutput {
        value: headers,
        fields: fields.into_iter().collect(),
    }
}

pub fn redact_key_value_json(json: &str) -> RedactionOutput<Vec<HeaderEntry>> {
    let mut fields = BTreeSet::new();
    let entries = serde_json::from_str::<Vec<HeaderEntry>>(json)
        .unwrap_or_default()
        .into_iter()
        .map(|mut entry| {
            if is_sensitive_name(&entry.name) {
                fields.insert(entry.name.to_lowercase());
                entry.value = REDACTED_VALUE.to_string();
            }
            entry
        })
        .collect();
    RedactionOutput {
        value: entries,
        fields: fields.into_iter().collect(),
    }
}

pub fn redact_json_string(text: &str) -> Option<RedactionOutput<String>> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    let mut fields = BTreeSet::new();
    redact_value(&mut value, &mut fields);
    let rendered = serde_json::to_string_pretty(&value).ok()?;
    Some(RedactionOutput {
        value: rendered,
        fields: fields.into_iter().collect(),
    })
}

pub fn redact_text(text: &str) -> RedactionOutput<String> {
    if let Some(redacted) = redact_json_string(text) {
        return redacted;
    }

    let mut fields = BTreeSet::new();
    let mut output = text.to_string();
    if let Some(regex) = text_secret_regex() {
        output = regex
            .replace_all(&output, |captures: &regex::Captures<'_>| {
                let key = captures.get(1).map(|value| value.as_str()).unwrap_or("");
                if !key.is_empty() {
                    fields.insert(key.to_lowercase());
                }
                format!("{key}{}{}", &captures[2], REDACTED_VALUE)
            })
            .into_owned();
    }
    if let Some(regex) = bearer_regex() {
        output = regex
            .replace_all(&output, |captures: &regex::Captures<'_>| {
                fields.insert("authorization".to_string());
                format!("{}{}", &captures[1], REDACTED_VALUE)
            })
            .into_owned();
    }

    RedactionOutput {
        value: output,
        fields: fields.into_iter().collect(),
    }
}

pub fn redact_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let redacted_query = query
        .split('&')
        .map(|pair| {
            let Some((key, value)) = pair.split_once('=') else {
                return pair.to_string();
            };
            if is_sensitive_name(key) {
                format!("{key}={REDACTED_VALUE}")
            } else {
                format!("{key}={value}")
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{redacted_query}")
}

pub fn is_sensitive_name(name: &str) -> bool {
    let normalized = name.trim().to_lowercase();
    matches!(
        normalized.as_str(),
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "api-key"
            | "x-auth-token"
            | "x-csrf-token"
            | "x-xsrf-token"
    ) || normalized.contains("token")
        || normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("secret")
        || normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("private_key")
        || normalized.contains("csrf")
        || normalized.contains("session")
}

fn redact_value(value: &mut Value, fields: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => redact_object(object, fields),
        Value::Array(items) => {
            for item in items {
                redact_value(item, fields);
            }
        }
        _ => {}
    }
}

fn redact_object(object: &mut Map<String, Value>, fields: &mut BTreeSet<String>) {
    for (key, value) in object.iter_mut() {
        if is_sensitive_name(key) {
            fields.insert(key.to_lowercase());
            *value = Value::String(REDACTED_VALUE.to_string());
        } else {
            redact_value(value, fields);
        }
    }
}

fn text_secret_regex() -> Option<&'static Regex> {
    static REGEX: OnceLock<Option<Regex>> = OnceLock::new();
    REGEX
        .get_or_init(|| {
            Regex::new(
                r#"(?i)(authorization|cookie|set-cookie|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|client[_-]?secret|secret|csrf)(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^"\r\n,;]+)"#,
            )
            .ok()
        })
        .as_ref()
}

fn bearer_regex() -> Option<&'static Regex> {
    static REGEX: OnceLock<Option<Regex>> = OnceLock::new();
    REGEX
        .get_or_init(|| Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+").ok())
        .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_headers_and_json_fields() {
        let headers = redact_headers_json(
            r#"[{"name":"Authorization","value":"Bearer secret"},{"name":"Accept","value":"application/json"}]"#,
        );
        assert_eq!(headers.value[0].value, REDACTED_VALUE);
        assert_eq!(headers.value[1].value, "application/json");

        let body = redact_text(r#"{"token":"abc","nested":{"password":"pwd"},"ok":true}"#);
        assert!(!body.value.contains("abc"));
        assert!(!body.value.contains("pwd"));
        assert!(body.fields.contains(&"token".to_string()));
    }

    #[test]
    fn redacts_bearer_tokens_in_plain_text() {
        let output = redact_text("Authorization: Bearer abc.def.ghi\nnext");
        assert!(!output.value.contains("abc.def.ghi"));
    }

    #[test]
    fn header_entries_accept_snake_case_pseudo_flag() {
        let headers = redact_headers_json(
            r#"[{"name":":method","value":"GET","is_pseudo":true},{"name":"authorization","value":"Bearer secret","is_pseudo":false}]"#,
        );
        assert_eq!(headers.value[0].is_pseudo, Some(true));
        assert_eq!(headers.value[1].is_pseudo, Some(false));
        assert_eq!(headers.value[1].value, REDACTED_VALUE);
    }
}
