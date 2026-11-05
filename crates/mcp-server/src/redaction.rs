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
        let hash_key = load_hash_key(data_dir);

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

        self.redact_non_json_text(text)
    }

    /// Redact text already known not to be a single JSON document. This skips
    /// the full JSON parse so large SSE/NDJSON bodies cannot materialize a
    /// value tree through the fallback path.
    pub fn redact_non_json_text(&self, text: &str) -> RedactionOutput<String> {
        // P1-5: SSE/NDJSON/multi-document bodies are not ONE JSON document.
        // Redact each line that itself carries a JSON object/array with the
        // structured pass (so nested secrets are found), keep every other line
        // byte-identical, then let the plain-text rules cover form bodies and
        // bare tokens. A key regex alone cannot do this: `"credentials":
        // {"password":"…"}` is a single non-secret key whose value consumes the
        // nested secret.
        let mut records = Vec::new();
        let mut output = String::with_capacity(text.len());
        for (index, line) in text.split('\n').enumerate() {
            if index > 0 {
                output.push('\n');
            }
            output.push_str(&self.redact_json_line(line, &mut records));
        }

        let output = self.redact_string_inner(&output, "$text", &mut records);
        self.output(output, records)
    }

    /// Redact one line that contains a JSON object/array (NDJSON, SSE `data:`).
    /// Lines that do not parse as JSON are returned unchanged so non-JSON
    /// content keeps its exact bytes.
    fn redact_json_line(&self, line: &str, records: &mut Vec<RedactionRecord>) -> String {
        let Some((prefix, candidate, suffix)) = split_json_segment(line) else {
            return line.to_string();
        };
        let Ok(mut value) = serde_json::from_str::<Value>(candidate) else {
            return line.to_string();
        };
        let before = records.len();
        self.redact_json_value_inner(&mut value, "$", records);
        if records.len() == before {
            return line.to_string();
        }
        match serde_json::to_string(&value) {
            Ok(serialized) => format!("{prefix}{serialized}{suffix}"),
            Err(_) => line.to_string(),
        }
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

    /// Redact a non-sensitive JSON string value, applying the same value-level
    /// rules used by the materialized redaction path.
    pub fn redact_text_value(
        &self,
        value: &str,
        path: &str,
        records: &mut Vec<RedactionRecord>,
    ) -> String {
        self.redact_string_inner(value, path, records)
    }

    /// Redact a scalar under a sensitive key without materializing the full
    /// JSON document.
    pub fn redact_named_scalar(
        &self,
        name: &str,
        value: &str,
        path: &str,
        records: &mut Vec<RedactionRecord>,
    ) -> String {
        match self.classify(name) {
            Some(classification) => self.redact_scalar(value, path, &classification, records),
            None => self.redact_string_inner(value, path, records),
        }
    }

    /// Sensitive object/array values are replaced as a whole, matching
    /// `redact_json_field` behavior for the materialized path.
    pub fn redact_named_container(
        &self,
        name: &str,
        path: &str,
        records: &mut Vec<RedactionRecord>,
    ) -> String {
        let rule = self
            .classify(name)
            .map(|classification| classification.rule)
            .unwrap_or_else(|| name.trim().to_lowercase());
        records.push(RedactionRecord {
            path: path.to_string(),
            rule,
            action: "redact".to_string(),
        });
        REDACTED_VALUE.to_string()
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
        if let Some(regex) = json_quoted_secret_regex() {
            output = regex
                .replace_all(&output, |captures: &regex::Captures<'_>| {
                    let key = captures.get(1).map(|value| value.as_str()).unwrap_or("");
                    let lower = key.trim().to_lowercase();
                    let normalized: String = lower
                        .chars()
                        .filter(|character| {
                            character.is_ascii_alphanumeric() || !character.is_ascii()
                        })
                        .collect();
                    let is_custom = self
                        .redaction
                        .custom_sensitive_keys
                        .iter()
                        .any(|candidate| candidate == &lower || candidate == &normalized);
                    if !is_custom && !is_secret_name(&normalized) {
                        // Not a secret: keep the original text byte-for-byte.
                        return captures
                            .get(0)
                            .map(|value| value.as_str().to_string())
                            .unwrap_or_default();
                    }
                    records.push(RedactionRecord {
                        path: path.to_string(),
                        rule: if is_custom {
                            format!("custom:{normalized}")
                        } else {
                            normalized
                        },
                        action: "redact".to_string(),
                    });
                    format!("\"{key}\"{}\"{REDACTED_VALUE}\"", &captures[2])
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

const REDACTION_KEY_FILE: &str = "agent-redaction.key";

/// HMAC key used for identifier pseudonyms, persisted next to the Agent config.
///
/// P3: the key used to be `SHA-256(b"aiproxy-agent-redaction-v1" + data_dir)`.
/// The data directory path is guessable (or known), so anyone holding a
/// pseudonym could recompute the key and brute-force a low-entropy value (an
/// 11-digit phone number takes seconds). Generate 32 random bytes on first use
/// and persist them (0600 on Unix) so pseudonyms stay stable across runs without
/// being derivable from public information.
fn load_hash_key(data_dir: &Path) -> Vec<u8> {
    let path = data_dir.join(REDACTION_KEY_FILE);
    if let Some(key) = read_hash_key(&path) {
        return key;
    }

    if path.exists() {
        // An empty/partial file (crash between create and write, disk full) would
        // otherwise downgrade every future run to the path-derived key. Give a
        // concurrent writer a few milliseconds to finish, then replace it.
        for _ in 0..5 {
            if let Some(key) = read_hash_key(&path) {
                return key;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = std::fs::remove_file(&path);
    }

    let key = random_hash_key();
    match write_hash_key(&path, &key) {
        Ok(()) => key,
        // Another sidecar won the create race; use the persisted key.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_hash_key(&path)
            .unwrap_or_else(|| {
                tracing::warn!(
                    component = "mcp.redaction",
                    event = "redaction_key_race_lost",
                    "redaction key file appeared but is unreadable; using a path-derived key"
                );
                path_derived_hash_key(data_dir)
            }),
        Err(error) => {
            tracing::warn!(
                component = "mcp.redaction",
                event = "redaction_key_write_failed",
                error = %error,
                "could not persist the redaction key; using a path-derived key (lower protection)"
            );
            path_derived_hash_key(data_dir)
        }
    }
}

fn read_hash_key(path: &Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    (bytes.len() >= 32).then_some(bytes)
}

fn random_hash_key() -> Vec<u8> {
    let mut key = Vec::with_capacity(32);
    while key.len() < 32 {
        key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    key.truncate(32);
    key
}

fn write_hash_key(path: &Path, key: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(path)?;
    use std::io::Write as _;
    file.write_all(key)?;
    file.sync_all()
}

/// Pre-P3 behaviour, kept as a last-resort fallback when the key file cannot be
/// written. Deterministic so pseudonyms stay stable within such an environment.
fn path_derived_hash_key(data_dir: &Path) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(b"aiproxy-agent-redaction-v1\0");
    hasher.update(data_dir.to_string_lossy().as_bytes());
    hasher.finalize().to_vec()
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
            | "xsrf"
            | "jwt"
            | "pwd"
            | "sig"
            | "signature"
            | "xamzsignature"
            | "xgoogsignature"
            | "authkey"
            | "xauthkey"
    ) || name.contains("token")
        || name.contains("password")
        || name.contains("passwd")
        || name.contains("secret")
        || name.contains("privatekey")
        || name.contains("apikey")
        || name.contains("csrf")
        // P2-12: signature / auth-key headers (`X-Amz-Signature`,
        // `X-Goog-Signature`, `X-Auth-Key`, Cloudflare's `X-Auth-Key`) and the
        // `?sig=`-style query names used by signed URLs.
        || name.ends_with("signature")
        || name.ends_with("sig")
        || name.ends_with("authkey")
        // Localized keys, mirroring the Chinese PII coverage in `is_pii_name`.
        || name.contains("密码")
        || name.contains("口令")
        || name.contains("令牌")
        || name.contains("密钥")
        || name.contains("签名")
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
            // P2-12: the structured (JSON/header) path already treats any name
            // containing `token` as a secret via `is_secret_name`, but this
            // text-level regex is the only protection for form bodies
            // (`user=a&token=…`), unknown header names and URL query values
            // (`?signature=…`, `?sig=…`). Keep both word lists in sync.
            //
            // `\b` avoids matching inside longer identifiers (`token_type`,
            // `mytoken`), and the value class stops at framing characters.
            Regex::new(
                r#"(?i)\b(authorization|cookie|set-cookie|api[_-]?key|x-api-key|auth[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|client[_-]?secret|secret|csrf|xsrf|jwt|signature|sig|x-amz-signature|x-goog-signature|密码|口令|令牌|密钥)(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^"\r\n,;]+)"#,
            )
            .ok()
        })
        .as_ref()
}

/// P1-5: quoted-key JSON rule for the plain-text fallback.
///
/// `redact_text` only gets a structured pass when the WHOLE input is one JSON
/// document. SSE/NDJSON streams, BOM-prefixed JSON and concatenated documents
/// fall back to `redact_string_inner`, whose only key rule required a bare
/// `key:`/`key=` (no surrounding quotes) — so `{"password":"hunter2"}` leaked
/// verbatim while the tool still reported `redacted=true`.
///
/// The key is classified with `is_secret_name` (plus the configured custom
/// keys) in the replacement closure, so the word list stays in one place.
fn json_quoted_secret_regex() -> Option<&'static Regex> {
    static REGEX: OnceLock<Option<Regex>> = OnceLock::new();
    REGEX
        .get_or_init(|| {
            Regex::new(
                r#"(?i)"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null|\{[^{}]*\}|\[[^\[\]]*\])"#,
            )
            .ok()
        })
        .as_ref()
}

/// Split one line into `(prefix, json, suffix)` when it carries a JSON
/// object/array. Only short prefixes are accepted (SSE `data: `, a BOM) so text
/// that merely contains a `{` is not treated as structured JSON.
fn split_json_segment(line: &str) -> Option<(&str, &str, &str)> {
    let start = line.find(['{', '['])?;
    if start > 32 {
        return None;
    }
    let (prefix, rest) = line.split_at(start);
    let trimmed = rest.trim_end_matches(['\r', ' ', '\t']);
    let suffix = &rest[trimmed.len()..];
    Some((prefix, trimmed, suffix))
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

    fn redactor_for_dir(data_dir: &Path) -> Redactor {
        let config = AgentAccessConfig::default();
        Redactor::from_config(&config, data_dir).unwrap()
    }

    /// Unique data dir per call: the key file is persisted there, so a shared
    /// hard-coded path would leak state between tests (and write to `/tmp`).
    fn redactor() -> Redactor {
        let dir = tempfile::tempdir().unwrap();
        redactor_for_dir(dir.path())
    }

    // P3: pseudonyms used to be keyed by `SHA-256(constant + data_dir)`, which is
    // derivable from a guessable path; the key is now 32 random bytes persisted
    // in the data dir. It must still be stable across runs/instances.
    #[test]
    fn pseudonyms_are_stable_per_data_dir_and_distinct_across_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let first = redactor_for_dir(dir.path());
        let second = redactor_for_dir(dir.path());
        assert_eq!(
            first.pseudonym("email", "alice@example.com"),
            second.pseudonym("email", "alice@example.com")
        );

        let other = tempfile::tempdir().unwrap();
        assert_ne!(
            first.pseudonym("email", "alice@example.com"),
            redactor_for_dir(other.path()).pseudonym("email", "alice@example.com")
        );

        assert!(dir.path().join(REDACTION_KEY_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn redaction_key_file_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let _ = redactor_for_dir(dir.path());
        let mode = std::fs::metadata(dir.path().join(REDACTION_KEY_FILE))
            .unwrap()
            .permissions()
            .mode();

        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn replaces_an_unusable_key_file_instead_of_downgrading() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(REDACTION_KEY_FILE), b"bad").unwrap();

        let first = redactor_for_dir(dir.path());
        let bytes = std::fs::read(dir.path().join(REDACTION_KEY_FILE)).unwrap();
        assert_eq!(bytes.len(), 32, "an unusable key file must be replaced");

        let second = redactor_for_dir(dir.path());
        assert_eq!(
            first.pseudonym("email", "alice@example.com"),
            second.pseudonym("email", "alice@example.com")
        );
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
    fn text_fallback_redacts_quoted_json_secrets() {
        // P1-5: these bodies are valid JSON-in-parts but NOT a single JSON
        // document, so `redact_text` falls back to the plain-text rules. The
        // quoted-key rule must still find the secret (the old bare `key=value`
        // rule did not, and the tool still reported redacted=true).
        let redactor = redactor();
        let cases = [
            (r#"{"password":"hunter2"}"#, "hunter2"),
            ("data: {\"access_token\":\"abc123\"}\n", "abc123"),
            ("{\"a\":1}\n{\"token\":\"xyz\"}", "xyz"),
            ("\u{FEFF}{\"client_secret\":\"s3cret\"}", "s3cret"),
            (r#"{"user":{"password":"hunter2"}}"#, "hunter2"),
            (
                // Nested secret value in an NDJSON line (not a single JSON doc).
                "{\"a\":1}\n{\"credentials\":{\"password\":\"hunter2\"}}",
                "hunter2",
            ),
        ];

        for (input, secret) in cases {
            let output = redactor.redact_text(input);
            assert!(
                !output.value.contains(secret),
                "leaked {secret} from {input}: {}",
                output.value
            );
            assert!(
                !output.fields.is_empty(),
                "no redaction record for {input}: {}",
                output.value
            );
        }
    }

    #[test]
    fn text_fallback_leaves_non_secret_quoted_keys_untouched() {
        let redactor = redactor();
        let input = r#"{"status":"ok","count":3}"#;
        let output = redactor.redact_text(input);
        assert_eq!(output.value, input);
        assert!(output.fields.is_empty());
    }

    #[test]
    fn text_fallback_honours_custom_sensitive_keys() {
        let mut config = AgentAccessConfig::default();
        config.redaction.custom_sensitive_keys = vec!["x-custom".to_string()];
        let dir = tempfile::tempdir().unwrap();
        let redactor = Redactor::from_config(&config, dir.path()).unwrap();

        let output = redactor.redact_text("{\"a\":1}\n{\"x-custom\":\"custom-secret\"}");
        assert!(!output.value.contains("custom-secret"), "{}", output.value);
        assert!(output.fields.iter().any(|field| field == "custom:xcustom"));
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
        let dir = tempfile::tempdir().unwrap();
        let redactor = Redactor::from_config(&config, dir.path()).unwrap();
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
        // Keyed form: the `key=value` rule (which now also matches a bare
        // `token` name) may redact the whole value before the JWT detector sees
        // it — either marker is fine as long as nothing leaks.
        let keyed = redactor.redact_text(&format!("token={jwt}"));
        assert!(!keyed.value.contains(jwt));
        assert!(keyed.value.contains("[REDACTED"));
        // Bare form: only the JWT detector can catch this one.
        let bare = redactor.redact_text(&format!("pasted jwt {jwt}"));
        assert!(!bare.value.contains(jwt));
        assert!(bare.value.contains("[REDACTED:jwt]"));
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

    // P2-12: the text-level path is the only protection for form bodies,
    // unknown header names and URL query values. It used to know only
    // `access_token`/`refresh_token`/… and no signature parameters, so
    // `token=…`, `?signature=…`, `?sig=…` and `X-Auth-Key: …` went out verbatim
    // even though the tool description promises redacted values.
    #[test]
    fn redacts_bare_token_signature_and_auth_key_forms_in_text() {
        let redactor = redactor();
        for (text, secret) in [
            ("user=alice&token=3f9a2c", "3f9a2c"),
            ("?signature=abc123", "abc123"),
            ("?sig=def456", "def456"),
            ("?X-Amz-Signature=ghi789", "ghi789"),
            ("X-Goog-Signature: jkl012", "jkl012"),
            ("X-Auth-Key: k-123", "k-123"),
            ("密码=hunter2", "hunter2"),
            ("令牌: tok-42", "tok-42"),
        ] {
            let output = redactor.redact_text(text);
            assert!(
                !output.value.contains(secret),
                "`{text}` leaked `{secret}`: {}",
                output.value
            );
        }
    }

    // `\b` keeps longer identifiers from being treated as the secret name, so
    // useful diagnostics are not swallowed.
    #[test]
    fn does_not_redact_identifiers_that_merely_contain_a_short_secret_name() {
        let redactor = redactor();
        for text in [
            "token_type=Bearer",
            "design=compact",
            "mytoken=abc",
            "status_code=200",
        ] {
            let output = redactor.redact_text(text);
            assert_eq!(output.value, text, "`{text}` must pass through unchanged");
        }
    }

    // Structured keys: signature/auth-key headers and localized key names are
    // now classified as secrets, while a signature *algorithm* field is not.
    #[test]
    fn classifies_signature_headers_and_localized_keys_as_secrets() {
        let redactor = redactor();
        let headers = redactor.redact_headers_json(
            r#"[{"name":"X-Amz-Signature","value":"sig-1"},{"name":"X-Auth-Key","value":"key-1"},{"name":"X-Signature-Algorithm","value":"rsa-sha256"},{"name":"令牌","value":"tok-9"},{"name":"密码","value":"pw-9"}]"#,
        );

        assert_eq!(headers.value[0].value, REDACTED_VALUE);
        assert_eq!(headers.value[1].value, REDACTED_VALUE);
        assert_eq!(headers.value[2].value, "rsa-sha256");
        assert_eq!(headers.value[3].value, REDACTED_VALUE);
        assert_eq!(headers.value[4].value, REDACTED_VALUE);
    }
}
