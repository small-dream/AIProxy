use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::OnceLock;

use hmac::{Hmac, Mac};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::config::{AgentAccessConfig, AgentAccessRedaction, RedactionAction};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactionRecord {
    pub path: String,
    pub rule: String,
    pub action: String,
}

#[derive(Debug, Clone, Default)]
pub struct RedactionOutput<T> {
    pub value: T,
    pub fields: Vec<String>,
    pub records: Vec<RedactionRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sensitivity {
    Secret,
    Identifier,
    Pii,
}

#[derive(Debug, Clone)]
struct Classification {
    rule: String,
    sensitivity: Sensitivity,
}

#[derive(Debug, Clone)]
struct CompiledPattern {
    name: String,
    regex: Regex,
    action: RedactionAction,
}

#[derive(Debug, Clone)]
pub struct Redactor {
    hash_key: Vec<u8>,
    redaction: AgentAccessRedaction,
    custom_patterns: Vec<CompiledPattern>,
}

impl Redactor {
    pub fn from_config(config: &AgentAccessConfig, data_dir: &Path) -> Result<Self, String> {
        // The key is stable per AIProxy data directory and never leaves the local
        // machine. It makes identifiers linkable without exposing their raw value.
        let mut hasher = Sha256::new();
        hasher.update(b"aiproxy-agent-redaction-v1\0");
        hasher.update(data_dir.to_string_lossy().as_bytes());
        let hash_key = hasher.finalize().to_vec();

        let mut custom_patterns = Vec::new();
        for rule in &config.redaction.custom_patterns {
            if rule.pattern.len() > 512 {
                return Err(format!(
                    "redaction pattern '{}' exceeds 512 characters",
                    rule.name
                ));
            }
            let regex = Regex::new(&rule.pattern)
                .map_err(|error| format!("invalid redaction pattern '{}': {error}", rule.name))?;
            custom_patterns.push(CompiledPattern {
                name: rule.name.clone(),
                regex,
                action: rule.action,
            });
        }

        Ok(Self {
            hash_key,
            redaction: config.redaction.clone(),
            custom_patterns,
        })
    }

    pub fn redact_headers_json(&self, json: &str) -> RedactionOutput<Vec<HeaderEntry>> {
        let mut records = Vec::new();
        let headers = serde_json::from_str::<Vec<HeaderEntry>>(json)
            .unwrap_or_default()
            .into_iter()
            .map(|mut header| {
                let path = format!("header:{}", header.name.to_lowercase());
                if let Some(classification) = self.classify(&header.name) {
                    header.value =
                        self.redact_scalar(&header.value, &path, &classification, &mut records);
                } else {
                    header.value = self.redact_string_inner(&header.value, &path, &mut records);
                }
                header
            })
            .collect();
        self.output(headers, records)
    }

    /// Return true when a field name is classified as sensitive and should be
    /// represented by an environment placeholder in generated commands.
    pub fn is_sensitive_value_name(&self, name: &str) -> bool {
        self.classify(name).is_some()
    }

    pub fn redact_cookie_headers(
        &self,
        headers: Vec<HeaderEntry>,
    ) -> RedactionOutput<Vec<HeaderEntry>> {
        let mut records = Vec::new();
        let headers = headers
            .into_iter()
            .map(|mut header| {
                let path = format!("cookie:{}", header.name.to_lowercase());
                header.value = REDACTED_VALUE.to_string();
                records.push(RedactionRecord {
                    path,
                    rule: "cookie".to_string(),
                    action: "redact".to_string(),
                });
                header
            })
            .collect();
        self.output(headers, records)
    }

    pub fn redact_key_value_json(&self, json: &str) -> RedactionOutput<Vec<HeaderEntry>> {
        let mut records = Vec::new();
        let entries = serde_json::from_str::<Vec<HeaderEntry>>(json)
            .unwrap_or_default()
            .into_iter()
            .map(|mut entry| {
                let path = format!("query:{}", entry.name.to_lowercase());
                if let Some(classification) = self.classify(&entry.name) {
                    entry.value =
                        self.redact_scalar(&entry.value, &path, &classification, &mut records);
                } else {
                    entry.value = self.redact_string_inner(&entry.value, &path, &mut records);
                }
                entry
            })
            .collect();
        self.output(entries, records)
    }

    pub fn redact_text(&self, text: &str) -> RedactionOutput<String> {
        if let Ok(mut value) = serde_json::from_str::<Value>(text) {
            let mut records = Vec::new();
            self.redact_json_value_inner(&mut value, "$", &mut records);
            let rendered = serde_json::to_string(&value).unwrap_or_else(|_| text.to_string());
            return self.output(rendered, records);
        }

        let mut records = Vec::new();
        let output = self.redact_string_inner(text, "$text", &mut records);
        self.output(output, records)
    }

    pub fn redact_json_value(
        &self,
        value: &mut Value,
        path: &str,
        records: &mut Vec<RedactionRecord>,
    ) {
        self.redact_json_value_inner(value, path, records);
    }

    /// Apply the same classification used for an object's named field.
    /// Returns true when the field name matched a sensitive rule and the value
    /// was rewritten.
    pub fn redact_json_field(
        &self,
        key: &str,
        value: &mut Value,
        path: &str,
        records: &mut Vec<RedactionRecord>,
    ) -> bool {
        let Some(classification) = self.classify(key) else {
            return false;
        };
        let rendered = match value {
            Value::String(text) => self.redact_scalar(text, path, &classification, records),
            Value::Number(number) => {
                self.redact_scalar(&number.to_string(), path, &classification, records)
            }
            Value::Bool(boolean) => {
                self.redact_scalar(&boolean.to_string(), path, &classification, records)
            }
            Value::Null => REDACTED_VALUE.to_string(),
            _ => {
                records.push(RedactionRecord {
                    path: path.to_string(),
                    rule: classification.rule.clone(),
                    action: "redact".to_string(),
                });
                REDACTED_VALUE.to_string()
            }
        };
        *value = Value::String(rendered);
        true
    }

    pub fn redact_url(&self, url: &str) -> String {
        let Some((base, query)) = url.split_once('?') else {
            return url.to_string();
        };
        let mut records = Vec::new();
        let redacted_query = query
            .split('&')
            .map(|pair| {
                let Some((key, value)) = pair.split_once('=') else {
                    return pair.to_string();
                };
                let path = format!("url.query.{key}");
                let redacted = if let Some(classification) = self.classify(key) {
                    self.redact_scalar(value, &path, &classification, &mut records)
                } else {
                    self.redact_string_inner(value, &path, &mut records)
                };
                format!("{key}={redacted}")
            })
            .collect::<Vec<_>>()
            .join("&");
        format!("{base}?{redacted_query}")
    }

    pub fn is_sensitive_name(&self, name: &str) -> bool {
        self.classify(name).is_some()
    }

    pub fn redact_named_value(&self, name: &str, value: &str) -> RedactionOutput<String> {
        let path = format!("value:{name}");
        let mut records = Vec::new();
        let redacted = if let Some(classification) = self.classify(name) {
            self.redact_scalar(value, &path, &classification, &mut records)
        } else {
            self.redact_string_inner(value, &path, &mut records)
        };
        self.output(redacted, records)
    }

    fn redact_json_value_inner(
        &self,
        value: &mut Value,
        path: &str,
        records: &mut Vec<RedactionRecord>,
    ) {
        match value {
            Value::Object(object) => self.redact_object(object, path, records),
            Value::Array(items) => {
                for (index, item) in items.iter_mut().enumerate() {
                    let next = format!("{path}[{index}]");
                    self.redact_json_value_inner(item, &next, records);
                }
            }
            Value::String(text) => {
                *text = self.redact_string_inner(text, path, records);
            }
            _ => {}
        }
    }

    fn redact_object(
        &self,
        object: &mut Map<String, Value>,
        path: &str,
        records: &mut Vec<RedactionRecord>,
    ) {
        for (key, value) in object.iter_mut() {
            let next = format!("{path}.{key}");
            if !self.redact_json_field(key, value, &next, records) {
                self.redact_json_value_inner(value, &next, records);
            }
        }
    }

    fn redact_scalar(
        &self,
        value: &str,
        path: &str,
        classification: &Classification,
        records: &mut Vec<RedactionRecord>,
    ) -> String {
        let (action, output) = match classification.sensitivity {
            Sensitivity::Secret => ("redact", REDACTED_VALUE.to_string()),
            Sensitivity::Identifier => {
                if self.redaction.hash_identifiers {
                    ("hash", self.pseudonym("ID", value))
                } else {
                    ("redact", REDACTED_VALUE.to_string())
                }
            }
            Sensitivity::Pii => {
                if self.redaction.hash_identifiers && looks_like_email(value) {
                    ("hash", self.pseudonym("EMAIL", value))
                } else if self.redaction.hash_identifiers && looks_like_phone(value) {
                    ("hash", self.pseudonym("PHONE", value))
                } else {
                    ("redact", REDACTED_VALUE.to_string())
                }
            }
        };
        records.push(RedactionRecord {
            path: path.to_string(),
            rule: classification.rule.clone(),
            action: action.to_string(),
        });
        output
    }

    fn redact_string_inner(
        &self,
        value: &str,
        path: &str,
        records: &mut Vec<RedactionRecord>,
    ) -> String {
        let mut output = value.to_string();

        if let Some(regex) = text_secret_regex() {
            output = regex
                .replace_all(&output, |captures: &regex::Captures<'_>| {
                    let key = captures.get(1).map(|value| value.as_str()).unwrap_or("");
                    records.push(RedactionRecord {
                        path: path.to_string(),
                        rule: key.to_lowercase(),
                        action: "redact".to_string(),
                    });
                    format!("{key}{}{}", &captures[2], REDACTED_VALUE)
                })
                .into_owned();
        }
        if let Some(regex) = bearer_regex() {
            output = regex
                .replace_all(&output, |captures: &regex::Captures<'_>| {
                    records.push(RedactionRecord {
                        path: path.to_string(),
                        rule: "authorization".to_string(),
                        action: "redact".to_string(),
                    });
                    format!("{}{}", &captures[1], REDACTED_VALUE)
                })
                .into_owned();
        }
        if self.redaction.detect_sensitive_values {
            if let Some(regex) = jwt_regex() {
                output = regex
                    .replace_all(&output, |_: &regex::Captures<'_>| {
                        records.push(RedactionRecord {
                            path: path.to_string(),
                            rule: "jwt".to_string(),
                            action: "redact".to_string(),
                        });
                        "[REDACTED:jwt]".to_string()
                    })
                    .into_owned();
            }
            if let Some(regex) = email_regex() {
                output = regex
                    .replace_all(&output, |captures: &regex::Captures<'_>| {
                        let matched = captures
                            .get(0)
                            .map(|value| value.as_str())
                            .unwrap_or_default();
                        records.push(RedactionRecord {
                            path: path.to_string(),
                            rule: "email".to_string(),
                            action: if self.redaction.hash_identifiers {
                                "hash".to_string()
                            } else {
                                "redact".to_string()
                            },
                        });
                        if self.redaction.hash_identifiers {
                            self.pseudonym("EMAIL", matched)
                        } else {
                            REDACTED_VALUE.to_string()
                        }
                    })
                    .into_owned();
            }
            if let Some(regex) = phone_regex() {
                output = regex
                    .replace_all(&output, |captures: &regex::Captures<'_>| {
                        let matched = captures
                            .get(0)
                            .map(|value| value.as_str())
                            .unwrap_or_default();
                        records.push(RedactionRecord {
                            path: path.to_string(),
                            rule: "phone".to_string(),
                            action: if self.redaction.hash_identifiers {
                                "hash".to_string()
                            } else {
                                "redact".to_string()
                            },
                        });
                        if self.redaction.hash_identifiers {
                            self.pseudonym("PHONE", matched)
                        } else {
                            REDACTED_VALUE.to_string()
                        }
                    })
                    .into_owned();
            }
        }

        for pattern in &self.custom_patterns {
            output = pattern
                .regex
                .replace_all(&output, |captures: &regex::Captures<'_>| {
                    let matched = captures
                        .get(0)
                        .map(|value| value.as_str())
                        .unwrap_or_default();
                    let action = match pattern.action {
                        RedactionAction::Redact => "redact",
                        RedactionAction::Hash if self.redaction.hash_identifiers => "hash",
                        RedactionAction::Hash => "redact",
                    };
                    records.push(RedactionRecord {
                        path: path.to_string(),
                        rule: pattern.name.clone(),
                        action: action.to_string(),
                    });
                    match pattern.action {
                        RedactionAction::Redact => REDACTED_VALUE.to_string(),
                        RedactionAction::Hash if self.redaction.hash_identifiers => {
                            self.pseudonym(&pattern.name, matched)
                        }
                        RedactionAction::Hash => REDACTED_VALUE.to_string(),
                    }
                })
                .into_owned();
        }

        output
    }

    fn classify(&self, name: &str) -> Option<Classification> {
        let lower = name.trim().to_lowercase();
        let normalized: String = lower
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || !character.is_ascii())
            .collect();

        if self
            .redaction
            .custom_sensitive_keys
            .iter()
            .any(|key| key == &lower || key == &normalized)
        {
            return Some(Classification {
                rule: format!("custom:{normalized}"),
                sensitivity: Sensitivity::Secret,
            });
        }

        if is_secret_name(&normalized) {
            return Some(Classification {
                rule: normalized,
                sensitivity: Sensitivity::Secret,
            });
        }
        if is_identifier_name(&normalized) {
            return Some(Classification {
                rule: normalized,
                sensitivity: Sensitivity::Identifier,
            });
        }
        if is_pii_name(&normalized, &lower) {
            return Some(Classification {
                rule: normalized,
                sensitivity: Sensitivity::Pii,
            });
        }
        None
    }

    fn pseudonym(&self, kind: &str, value: &str) -> String {
        type HmacSha256 = Hmac<Sha256>;
        let mut mac =
            HmacSha256::new_from_slice(&self.hash_key).expect("HMAC accepts keys of any size");
        mac.update(kind.as_bytes());
        mac.update(b"\0");
        mac.update(value.as_bytes());
        let digest = mac.finalize().into_bytes();
        format!("[{kind}:{}]", hex_prefix(&digest, 8))
    }

    fn output<T>(&self, value: T, records: Vec<RedactionRecord>) -> RedactionOutput<T> {
        let mut records = records;
        records.sort_by(|left, right| {
            (&left.path, &left.rule, &left.action).cmp(&(&right.path, &right.rule, &right.action))
        });
        records.dedup();
        let fields = records
            .iter()
            .map(|record| record.rule.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        RedactionOutput {
            value,
            fields,
            records,
        }
    }
}

fn is_secret_name(name: &str) -> bool {
    matches!(
        name,
        "authorization"
            | "proxyauthorization"
            | "cookie"
            | "setcookie"
            | "xapikey"
            | "apikey"
            | "xauthtoken"
            | "xcsrftoken"
            | "xxsrftoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "password"
            | "passwd"
            | "secret"
            | "clientsecret"
            | "privatekey"
            | "csrf"
            | "jwt"
    ) || name.contains("token")
        || name.contains("password")
        || name.contains("passwd")
        || name.contains("secret")
        || name.contains("privatekey")
        || name.contains("apikey")
        || name.contains("csrf")
}

fn is_identifier_name(name: &str) -> bool {
    matches!(
        name,
        "session"
            | "sessionid"
            | "sessionkey"
            | "userid"
            | "uid"
            | "deviceid"
            | "advertisingid"
            | "idfa"
            | "idfv"
            | "oaid"
            | "imei"
            | "androidid"
            | "udid"
            | "installid"
    )
}

fn is_pii_name(normalized: &str, original: &str) -> bool {
    normalized.contains("email")
        || normalized.contains("mail")
        || normalized.contains("phone")
        || normalized.contains("mobile")
        || normalized.contains("address")
        || normalized.contains("shipping")
        || normalized.contains("receiver")
        || original.contains("邮箱")
        || original.contains("手机号")
        || original.contains("收货地址")
}

fn looks_like_email(value: &str) -> bool {
    email_regex().is_some_and(|regex| regex.is_match(value))
}

fn looks_like_phone(value: &str) -> bool {
    phone_regex().is_some_and(|regex| regex.is_match(value))
}

fn hex_prefix(bytes: &[u8], length: usize) -> String {
    let mut output = String::with_capacity(length * 2);
    for byte in bytes.iter().take(length) {
        let _ = write!(output, "{byte:02x}");
    }
    output
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

fn jwt_regex() -> Option<&'static Regex> {
    static REGEX: OnceLock<Option<Regex>> = OnceLock::new();
    REGEX
        .get_or_init(|| {
            Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b").ok()
        })
        .as_ref()
}

fn email_regex() -> Option<&'static Regex> {
    static REGEX: OnceLock<Option<Regex>> = OnceLock::new();
    REGEX
        .get_or_init(|| Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").ok())
        .as_ref()
}

fn phone_regex() -> Option<&'static Regex> {
    static REGEX: OnceLock<Option<Regex>> = OnceLock::new();
    REGEX
        .get_or_init(|| Regex::new(r"\b(?:\+?86[- ]?)?1[3-9][0-9]{9}\b").ok())
        .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redactor() -> Redactor {
        let config = AgentAccessConfig::default();
        Redactor::from_config(&config, Path::new("/tmp/aiproxy-redaction-test")).unwrap()
    }

    #[test]
    fn redacts_headers_json_fields_and_values() {
        let redactor = redactor();
        let headers = redactor.redact_headers_json(
            r#"[{"name":"Authorization","value":"Bearer secret"},{"name":"Accept","value":"application/json"},{"name":"X-User-Email","value":"alice@example.com"}]"#,
        );
        assert_eq!(headers.value[0].value, REDACTED_VALUE);
        assert_eq!(headers.value[1].value, "application/json");
        assert!(headers.value[2].value.starts_with("[EMAIL:"));

        let body = redactor.redact_text(
            r#"{"token":"abc","nested":{"password":"pwd"},"email":"alice@example.com","deviceId":"device-123","ok":true}"#,
        );
        assert!(!body.value.contains("abc"));
        assert!(!body.value.contains("pwd"));
        assert!(!body.value.contains("alice@example.com"));
        assert!(!body.value.contains("device-123"));
        assert!(body.fields.contains(&"token".to_string()));
        assert!(body.fields.contains(&"email".to_string()));
    }

    #[test]
    fn identifier_hashes_are_stable_and_do_not_expose_the_value() {
        let redactor = redactor();
        let session = redactor.redact_url("https://api.example.com/x?_sessionId=abc123");
        let body = redactor.redact_text(r#"{"sessionId":"abc123"}"#);
        assert!(session.contains("[ID:"));
        assert!(body.value.contains("[ID:"));
        let session_hash = session
            .split("[ID:")
            .nth(1)
            .and_then(|value| value.split(']').next())
            .unwrap();
        assert!(body.value.contains(&format!("[ID:{session_hash}]")));
        assert!(!session.contains("abc123"));
        assert!(!body.value.contains("abc123"));
    }

    #[test]
    fn disabled_hashing_reports_redaction_as_the_effective_action() {
        let mut config = AgentAccessConfig::default();
        config.redaction.hash_identifiers = false;
        let redactor =
            Redactor::from_config(&config, Path::new("/tmp/aiproxy-redaction-test")).unwrap();
        let output = redactor.redact_text("contact alice@example.com");
        assert_eq!(output.value, "contact [REDACTED]");
        assert!(output
            .records
            .iter()
            .all(|record| record.action == "redact"));
    }

    #[test]
    fn redacts_jwts_in_plain_text() {
        let redactor = redactor();
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature1234567890";
        let output = redactor.redact_text(&format!("token={jwt}"));
        assert!(!output.value.contains(jwt));
        assert!(output.value.contains("[REDACTED:jwt]"));
    }

    #[test]
    fn header_entries_accept_snake_case_pseudo_flag() {
        let redactor = redactor();
        let headers = redactor.redact_headers_json(
            r#"[{"name":":method","value":"GET","is_pseudo":true},{"name":"authorization","value":"Bearer secret","is_pseudo":false}]"#,
        );
        assert_eq!(headers.value[0].is_pseudo, Some(true));
        assert_eq!(headers.value[1].is_pseudo, Some(false));
        assert_eq!(headers.value[1].value, REDACTED_VALUE);
    }
}
