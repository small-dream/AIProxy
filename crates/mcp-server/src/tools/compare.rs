use std::collections::{BTreeMap, BTreeSet};

use aiproxy_db::sessions::{load_session_detail, load_session_summary, SessionSummaryRow};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::{
    redact_cookie_headers, redact_headers_json, redact_key_value_json, redact_text, redact_url,
    HeaderEntry,
};

use super::body::{
    load_body_reference, read_body_bytes, sha256_hex, BodyPart, StoredBodyReference,
};
use super::sessions::RedactionMode;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompareSessionsRequest {
    pub left_session_id: String,
    pub right_session_id: String,
    #[serde(default)]
    pub include_body: bool,
    pub body_part: Option<BodyPart>,
    #[serde(default)]
    pub redaction_mode: RedactionMode,
}

#[derive(Debug)]
struct SessionSnapshot {
    summary: SessionSummaryRow,
    request_headers: BTreeMap<String, String>,
    response_headers: BTreeMap<String, String>,
    query: BTreeMap<String, String>,
    cookies: BTreeMap<String, String>,
    timing: BTreeMap<String, Value>,
}

pub async fn compare_sessions(
    state: &AppContext,
    request: CompareSessionsRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled in Agent Access.",
        ));
    }
    if request.include_body && !config.permissions.read_bodies {
        return Err(ToolError::permission_denied(
            "Comparing response bodies requires the readBodies permission.",
        ));
    }
    if request.left_session_id == request.right_session_id {
        return Err(ToolError::invalid(
            "leftSessionId and rightSessionId must be different.",
        ));
    }

    let raw = request.redaction_mode == RedactionMode::Raw;
    if raw && !config.permissions.read_raw_bodies {
        return Err(ToolError::permission_denied(
            "Raw comparison requires the readRawBodies permission.",
        ));
    }
    let left_id = request.left_session_id;
    let right_id = request.right_session_id;
    let (left, right) = state
        .with_db(move |connection| {
            let left = load_snapshot(connection, &left_id, raw)?;
            let right = load_snapshot(connection, &right_id, raw)?;
            Ok((left, right))
        })
        .await?;

    let left_id = left.summary.id.clone();
    let right_id = right.summary.id.clone();
    let mut data = json!({
        "leftSessionId": left_id,
        "rightSessionId": right_id,
        "summaryDiff": summary_diff(&left.summary, &right.summary, raw),
        "headerDiff": {
            "request": map_diff(&left.request_headers, &right.request_headers),
            "response": map_diff(&left.response_headers, &right.response_headers),
        },
        "queryDiff": map_diff(&left.query, &right.query),
        "cookieDiff": map_diff(&left.cookies, &right.cookies),
        "timingDiff": timing_diff(&left.timing, &right.timing),
    });

    let mut truncated = false;
    if request.include_body {
        let part = request.body_part.unwrap_or(BodyPart::Response);
        let left_body_id = left.summary.id.clone();
        let left_body = state
            .with_db(move |connection| load_body_reference(connection, &left_body_id, part))
            .await?;
        let right_body_id = right.summary.id.clone();
        let right_body = state
            .with_db(move |connection| load_body_reference(connection, &right_body_id, part))
            .await?;
        let max_each = config.limits.max_body_bytes.min(256 * 1024);
        let left_result = read_optional_body(state, left_body.as_ref(), max_each, raw)?;
        let right_result = read_optional_body(state, right_body.as_ref(), max_each, raw)?;
        truncated |= left_result.truncated || right_result.truncated;
        data["bodyDiff"] = body_diff(
            &left.summary.id,
            &right.summary.id,
            left_result,
            right_result,
            request.body_part.unwrap_or(BodyPart::Response),
        );
    }

    Ok((data, ToolMeta::new(truncated, !raw, None)))
}

fn load_snapshot(
    connection: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    raw: bool,
) -> Result<SessionSnapshot, aiproxy_db::DbError> {
    let summary = load_session_summary(connection, session_id)?
        .ok_or_else(|| aiproxy_db::DbError::not_found("session", session_id))?;
    let detail = load_session_detail(connection, session_id)?;

    let (request_headers, response_headers, query, cookies, timing) = if let Some(detail) = detail {
        let request_headers = header_map(&detail.request_headers, raw);
        let response_headers = header_map(&detail.response_headers, raw);
        let query = entry_map(&detail.query_params, raw);
        let cookies = if raw {
            entry_map(&detail.cookies, true)
        } else {
            cookie_map(&detail.cookies)
        };
        let timing = detail
            .timing
            .as_deref()
            .and_then(|value| serde_json::from_str::<BTreeMap<String, Value>>(value).ok())
            .unwrap_or_default();
        (request_headers, response_headers, query, cookies, timing)
    } else {
        (
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
            BTreeMap::new(),
        )
    };

    Ok(SessionSnapshot {
        summary,
        request_headers,
        response_headers,
        query,
        cookies,
        timing,
    })
}

fn header_map(json: &str, raw: bool) -> BTreeMap<String, String> {
    let entries = if raw {
        serde_json::from_str::<Vec<HeaderEntry>>(json).unwrap_or_default()
    } else {
        redact_headers_json(json).value
    };
    entries
        .into_iter()
        .map(|entry| (entry.name.to_lowercase(), entry.value))
        .collect()
}

fn entry_map(json: &str, raw: bool) -> BTreeMap<String, String> {
    let entries = if raw {
        serde_json::from_str::<Vec<HeaderEntry>>(json).unwrap_or_default()
    } else {
        redact_key_value_json(json).value
    };
    entries
        .into_iter()
        .map(|entry| (entry.name.to_lowercase(), entry.value))
        .collect()
}

fn cookie_map(json: &str) -> BTreeMap<String, String> {
    let entries = serde_json::from_str::<Vec<HeaderEntry>>(json).unwrap_or_default();
    redact_cookie_headers(entries)
        .value
        .into_iter()
        .map(|entry| (entry.name.to_lowercase(), entry.value))
        .collect()
}

fn summary_diff(left: &SessionSummaryRow, right: &SessionSummaryRow, raw: bool) -> Value {
    let mut output = serde_json::Map::new();
    for (name, left_value, right_value) in [
        (
            "statusCode",
            json!(left.status_code),
            json!(right.status_code),
        ),
        (
            "durationMs",
            json!(left.duration_ms),
            json!(right.duration_ms),
        ),
        ("sizeBytes", json!(left.size_bytes), json!(right.size_bytes)),
        ("protocol", json!(left.protocol), json!(right.protocol)),
        (
            "httpVersion",
            json!(left.http_version),
            json!(right.http_version),
        ),
        (
            "responseMimeType",
            json!(left.response_mime_type),
            json!(right.response_mime_type),
        ),
        (
            "url",
            json!(if raw {
                left.url.clone()
            } else {
                redact_url(&left.url)
            }),
            json!(if raw {
                right.url.clone()
            } else {
                redact_url(&right.url)
            }),
        ),
    ] {
        output.insert(
            name.to_string(),
            json!({ "left": left_value, "right": right_value, "changed": left_value != right_value }),
        );
    }
    Value::Object(output)
}

fn map_diff(left: &BTreeMap<String, String>, right: &BTreeMap<String, String>) -> Value {
    let keys: BTreeSet<_> = left.keys().chain(right.keys()).cloned().collect();
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for key in keys {
        match (left.get(&key), right.get(&key)) {
            (None, Some(value)) => added.push(json!({ "name": key, "value": value })),
            (Some(value), None) => removed.push(json!({ "name": key, "value": value })),
            (Some(left), Some(right)) if left != right => {
                changed.push(json!({ "name": key, "left": left, "right": right }))
            }
            _ => {}
        }
    }
    json!({ "added": added, "removed": removed, "changed": changed })
}

fn timing_diff(left: &BTreeMap<String, Value>, right: &BTreeMap<String, Value>) -> Value {
    let keys: BTreeSet<_> = left.keys().chain(right.keys()).cloned().collect();
    let mut values = serde_json::Map::new();
    for key in keys {
        let left_value = left.get(&key).cloned().unwrap_or(Value::Null);
        let right_value = right.get(&key).cloned().unwrap_or(Value::Null);
        let delta = match (left_value.as_f64(), right_value.as_f64()) {
            (Some(left), Some(right)) => json!(right - left),
            _ => Value::Null,
        };
        values.insert(
            key,
            json!({ "left": left_value, "right": right_value, "delta": delta }),
        );
    }
    Value::Object(values)
}

#[derive(Debug)]
struct OptionalBodyDiff {
    text: Option<String>,
    size_bytes: u64,
    mime_type: Option<String>,
    hash: Option<String>,
    truncated: bool,
}

fn read_optional_body(
    state: &AppContext,
    reference: Option<&StoredBodyReference>,
    max_bytes: usize,
    raw: bool,
) -> Result<OptionalBodyDiff, ToolError> {
    let Some(reference) = reference else {
        return Ok(OptionalBodyDiff {
            text: None,
            size_bytes: 0,
            mime_type: None,
            hash: None,
            truncated: false,
        });
    };
    let body = read_body_bytes(&state.body_store, reference, 0, max_bytes)?;
    let text = std::str::from_utf8(&body.bytes).ok().map(|value| {
        if raw {
            value.to_string()
        } else {
            redact_text(value).value
        }
    });
    Ok(OptionalBodyDiff {
        text,
        size_bytes: body.original_size_bytes,
        mime_type: reference.mime_type.clone(),
        hash: Some(sha256_hex(&body.bytes)),
        truncated: body.truncated || reference.truncated,
    })
}

fn body_diff(
    left_id: &str,
    right_id: &str,
    left: OptionalBodyDiff,
    right: OptionalBodyDiff,
    part: BodyPart,
) -> Value {
    let structure_parsed = left
        .text
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .zip(
            right
                .text
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok()),
        );
    let differences = if let Some((left_json, right_json)) = structure_parsed {
        let mut output = Vec::new();
        diff_json("$", &left_json, &right_json, &mut output, 200);
        json!({ "format": "json", "changes": output })
    } else if let (Some(left_text), Some(right_text)) = (&left.text, &right.text) {
        json!({
            "format": "text",
            "lines": diff_lines(left_text, right_text, 200),
        })
    } else {
        Value::Null
    };

    json!({
        "part": match part { BodyPart::Request => "request", BodyPart::Response => "response" },
        "leftSessionId": left_id,
        "rightSessionId": right_id,
        "left": {
            "sizeBytes": left.size_bytes,
            "contentType": left.mime_type,
            "hash": left.hash,
            "truncated": left.truncated,
        },
        "right": {
            "sizeBytes": right.size_bytes,
            "contentType": right.mime_type,
            "hash": right.hash,
            "truncated": right.truncated,
        },
        "structureParsed": differences.get("format").and_then(Value::as_str) == Some("json"),
        "differences": differences,
    })
}

fn diff_json(path: &str, left: &Value, right: &Value, output: &mut Vec<Value>, limit: usize) {
    if output.len() >= limit || left == right {
        return;
    }
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            let keys: BTreeSet<_> = left.keys().chain(right.keys()).collect();
            for key in keys {
                let next = format!("{path}.{key}");
                match (left.get(key), right.get(key)) {
                    (Some(left), Some(right)) => diff_json(&next, left, right, output, limit),
                    (Some(left), None) => {
                        output.push(json!({ "path": next, "left": left, "right": Value::Null }))
                    }
                    (None, Some(right)) => {
                        output.push(json!({ "path": next, "left": Value::Null, "right": right }))
                    }
                    _ => {}
                }
                if output.len() >= limit {
                    return;
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            for index in 0..left.len().max(right.len()) {
                let next = format!("{path}[{index}]");
                match (left.get(index), right.get(index)) {
                    (Some(left), Some(right)) => diff_json(&next, left, right, output, limit),
                    (Some(left), None) => {
                        output.push(json!({ "path": next, "left": left, "right": Value::Null }))
                    }
                    (None, Some(right)) => {
                        output.push(json!({ "path": next, "left": Value::Null, "right": right }))
                    }
                    _ => {}
                }
                if output.len() >= limit {
                    return;
                }
            }
        }
        _ => output.push(json!({ "path": path, "left": left, "right": right })),
    }
}

fn diff_lines(left: &str, right: &str, limit: usize) -> Vec<Value> {
    let left: Vec<_> = left.lines().collect();
    let right: Vec<_> = right.lines().collect();
    let mut output = Vec::new();
    for index in 0..left.len().max(right.len()).min(limit) {
        let left_line = left.get(index).copied();
        let right_line = right.get(index).copied();
        if left_line != right_line {
            output.push(json!({
                "line": index + 1,
                "left": left_line,
                "right": right_line,
            }));
        }
    }
    output
}
