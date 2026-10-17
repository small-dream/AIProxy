use aiproxy_db::body_store::BodyStore;
use aiproxy_db::sessions::load_session_detail;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::redact_text;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BodyPart {
    Request,
    Response,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BodyRedactionMode {
    Metadata,
    #[default]
    RedactedText,
    Base64,
    Raw,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetSessionBodyRequest {
    pub session_id: String,
    pub part: BodyPart,
    #[serde(default)]
    pub redaction_mode: BodyRedactionMode,
    pub offset: Option<u64>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone)]
pub(crate) struct StoredBodyReference {
    pub file_path: Option<String>,
    pub inline_text: Option<String>,
    pub base64_text: Option<String>,
    pub mime_type: Option<String>,
    pub encoding: Option<String>,
    pub size_bytes: u64,
    pub truncated: bool,
}

#[derive(Debug)]
pub(crate) struct BodyBytes {
    pub bytes: Vec<u8>,
    pub original_size_bytes: u64,
    pub offset: u64,
    pub returned_bytes: usize,
    pub truncated: bool,
}

pub async fn get_session_body(
    state: &AppContext,
    request: GetSessionBodyRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_bodies {
        return Err(ToolError::permission_denied(
            "Body reading is disabled in Agent Access.",
        ));
    }
    if matches!(
        request.redaction_mode,
        BodyRedactionMode::Raw | BodyRedactionMode::Base64
    ) && !config.permissions.read_raw_bodies
    {
        return Err(ToolError::permission_denied(
            "Raw or base64 body reading requires the readRawBodies permission.",
        ));
    }

    let session_id = request.session_id;
    let session_id_for_query = session_id.clone();
    let part = request.part;
    let reference = state
        .with_db(move |connection| load_body_reference(connection, &session_id_for_query, part))
        .await?
        .ok_or_else(|| ToolError::new("BODY_NOT_FOUND", "The requested body is not available."))?;

    let max_bytes = request
        .max_bytes
        .unwrap_or(config.limits.max_body_bytes)
        .clamp(1, config.limits.max_body_bytes);
    let offset = request.offset.unwrap_or(0);
    let mode = request.redaction_mode;

    if mode == BodyRedactionMode::Metadata {
        return Ok((
            json!({
                "sessionId": session_id,
                "part": part_label(part),
                "contentType": reference.mime_type,
                "encoding": "metadata",
                "isUtf8": Value::Null,
                "originalSizeBytes": reference.size_bytes,
                "returnedBytes": 0,
                "offset": offset,
                "truncated": reference.truncated,
                "redactedFields": [],
                "structureParsed": false,
                "hash": Value::Null,
            }),
            ToolMeta::new(reference.truncated, true, None),
        ));
    }

    let body = read_body_bytes(&state.body_store, &reference, offset, max_bytes)?;
    let is_utf8 = std::str::from_utf8(&body.bytes).is_ok();
    let hash = sha256_hex(&body.bytes);
    let mut redacted_fields = Vec::new();
    let mut text = Value::Null;
    let mut base64 = Value::Null;
    let mut encoding = "text";
    let mut structure_parsed = false;
    let mut redacted = true;

    match mode {
        BodyRedactionMode::RedactedText => {
            if is_utf8 {
                let raw_text = String::from_utf8_lossy(&body.bytes);
                structure_parsed = offset == 0
                    && !body.truncated
                    && serde_json::from_str::<Value>(&raw_text).is_ok();
                let output = redact_text(&raw_text);
                redacted_fields = output.fields;
                text = Value::String(output.value);
            } else {
                encoding = "binary";
            }
        }
        BodyRedactionMode::Raw => {
            redacted = false;
            if is_utf8 {
                text = Value::String(String::from_utf8_lossy(&body.bytes).into_owned());
            } else {
                encoding = "base64";
                base64 = Value::String(STANDARD.encode(&body.bytes));
            }
        }
        BodyRedactionMode::Base64 => {
            redacted = false;
            encoding = "base64";
            base64 = Value::String(STANDARD.encode(&body.bytes));
        }
        BodyRedactionMode::Metadata => unreachable!(),
    }

    let truncated = body.truncated || reference.truncated;
    let data = json!({
        "sessionId": session_id,
        "part": part_label(part),
        "contentType": reference.mime_type,
        "contentEncoding": reference.encoding,
        "encoding": encoding,
        "isUtf8": is_utf8,
        "text": text,
        "base64": base64,
        "originalSizeBytes": body.original_size_bytes,
        "returnedBytes": body.returned_bytes,
        "offset": body.offset,
        "truncated": truncated,
        "redactedFields": redacted_fields,
        "structureParsed": structure_parsed,
        "hash": { "algorithm": "sha256", "value": hash, "scope": "returnedRange" },
    });
    Ok((data, ToolMeta::new(truncated, redacted, None)))
}

pub(crate) fn load_body_reference(
    connection: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    part: BodyPart,
) -> Result<Option<StoredBodyReference>, aiproxy_db::DbError> {
    let detail = load_session_detail(connection, session_id)?;
    let Some(detail) = detail else {
        return Ok(None);
    };
    let value = match part {
        BodyPart::Request => detail.request_body_ref,
        BodyPart::Response => detail.response_body_ref,
    };
    let Some(value) = value else {
        return Ok(None);
    };
    Ok(serde_json::from_str::<StoredBodyReferenceJson>(&value)
        .ok()
        .map(StoredBodyReference::from))
}

pub(crate) fn read_body_bytes(
    store: &BodyStore,
    reference: &StoredBodyReference,
    offset: u64,
    max_bytes: usize,
) -> Result<BodyBytes, ToolError> {
    if let Some(file_path) = &reference.file_path {
        let range = store
            .read_body_range(file_path, offset, max_bytes)
            .map_err(|_| {
                ToolError::new("BODY_NOT_FOUND", "The stored body file is unavailable.")
            })?;
        return Ok(BodyBytes {
            bytes: range.bytes,
            original_size_bytes: range.original_size_bytes,
            offset: range.offset,
            returned_bytes: range.returned_bytes,
            truncated: range.truncated,
        });
    }

    let decoded = if let Some(base64_text) = &reference.base64_text {
        STANDARD.decode(base64_text).map_err(|_| {
            ToolError::new("BODY_NOT_FOUND", "The inline body reference is invalid.")
        })?
    } else if let Some(inline_text) = &reference.inline_text {
        inline_text.as_bytes().to_vec()
    } else {
        return Err(ToolError::new(
            "BODY_NOT_FOUND",
            "The body reference contains no readable payload.",
        ));
    };
    let original_size_bytes = if reference.size_bytes > 0 {
        reference.size_bytes
    } else {
        decoded.len() as u64
    };
    if offset > decoded.len() as u64 {
        return Err(ToolError::invalid("Body offset exceeds body size."));
    }
    let start = offset as usize;
    let end = (start + max_bytes).min(decoded.len());
    let bytes = decoded[start..end].to_vec();
    Ok(BodyBytes {
        bytes,
        original_size_bytes,
        offset,
        returned_bytes: end - start,
        truncated: end < decoded.len(),
    })
}

fn part_label(part: BodyPart) -> &'static str {
    match part {
        BodyPart::Request => "request",
        BodyPart::Response => "response",
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Deserialize)]
struct StoredBodyReferenceJson {
    file_path: Option<String>,
    inline_text: Option<String>,
    base64_text: Option<String>,
    mime_type: Option<String>,
    encoding: Option<String>,
    #[serde(default)]
    size_bytes: u64,
    #[serde(default)]
    truncated: bool,
}

impl From<StoredBodyReferenceJson> for StoredBodyReference {
    fn from(value: StoredBodyReferenceJson) -> Self {
        Self {
            file_path: value.file_path,
            inline_text: value.inline_text,
            base64_text: value.base64_text,
            mime_type: value.mime_type,
            encoding: value.encoding,
            size_bytes: value.size_bytes,
            truncated: value.truncated,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_inline_body_range() {
        let reference = StoredBodyReference {
            file_path: None,
            inline_text: Some("hello world".to_string()),
            base64_text: None,
            mime_type: Some("text/plain".to_string()),
            encoding: None,
            size_bytes: 11,
            truncated: false,
        };
        let store = BodyStore::new(std::env::temp_dir());
        let range = read_body_bytes(&store, &reference, 6, 4).unwrap();
        assert_eq!(range.bytes, b"worl");
        assert!(range.truncated);
    }

    #[test]
    fn reads_file_body_range() {
        let directory = tempfile::tempdir().unwrap();
        let store = BodyStore::new(directory.path().to_path_buf());
        std::fs::create_dir_all(directory.path().join("s1")).unwrap();
        let mut file = std::fs::File::create(directory.path().join("s1/response.body")).unwrap();
        file.write_all(b"0123456789").unwrap();
        let reference = StoredBodyReference {
            file_path: Some("s1/response.body".to_string()),
            inline_text: None,
            base64_text: None,
            mime_type: None,
            encoding: None,
            size_bytes: 10,
            truncated: false,
        };
        let range = read_body_bytes(&store, &reference, 3, 4).unwrap();
        assert_eq!(range.bytes, b"3456");
        assert!(range.truncated);
    }
}
