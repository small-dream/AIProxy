use std::collections::{BTreeMap, BTreeSet};

use aiproxy_db::sessions::{load_session_detail, load_session_summary, SessionSummaryRow};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::{HeaderEntry, Redactor};

use super::body::{
    extract_json_path, load_body_reference, parse_json_paths, read_body_bytes, sha256_hex,
    BodyPart, JsonPathSegment, StoredBodyReference,
};
use super::sessions::{require_session_id, RedactionMode};

const COMPARE_BODY_SCAN_BYTES: usize = 8 * 1024 * 1024;
const MAX_DIFF_CHANGES: usize = 200;
const MAX_DIFF_VALUE_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DiffMode {
    #[default]
    Auto,
    Json,
    Text,
}

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
    #[serde(default)]
    pub json_paths: Vec<String>,
    #[serde(default)]
    pub diff_mode: DiffMode,
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
    if !request.include_body && !request.json_paths.is_empty() {
        return Err(ToolError::invalid("jsonPaths requires includeBody=true."));
    }
    if request.diff_mode == DiffMode::Text && !request.json_paths.is_empty() {
        return Err(ToolError::invalid(
            "jsonPaths cannot be combined with diffMode=text.",
        ));
    }
    let json_paths = parse_json_paths(&request.json_paths)?;
    let raw = request.redaction_mode == RedactionMode::Raw;
    if raw && !config.permissions.read_raw_bodies {
        return Err(ToolError::permission_denied(
            "Raw comparison requires the readRawBodies permission.",
        ));
    }
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;
    let left_id = require_session_id(state, &request.left_session_id).await?;
    let right_id = require_session_id(state, &request.right_session_id).await?;
    if left_id == right_id {
        return Err(ToolError::invalid(
            "leftSessionId and rightSessionId must be different.",
        ));
    }

    let left_id_for_query = left_id.clone();
    let right_id_for_query = right_id.clone();
    let redactor_for_query = redactor.clone();
    let (left, right) = state
        .with_db(move |connection| {
            let left = load_snapshot(connection, &left_id_for_query, raw, &redactor_for_query)?;
            let right = load_snapshot(connection, &right_id_for_query, raw, &redactor_for_query)?;
            Ok((left, right))
        })
        .await?;

    let mut data = json!({
        "leftSessionId": left.summary.id,
        "rightSessionId": right.summary.id,
        "summaryDiff": summary_diff(&left.summary, &right.summary, raw, &redactor),
        "headerDiff": {
            "request": map_diff(&left.request_headers, &right.request_headers),
            "response": map_diff(&left.response_headers, &right.response_headers),
        },
        "queryDiff": map_diff(&left.query, &right.query),
        "cookieDiff": map_diff(&left.cookies, &right.cookies),
        "timingDiff": timing_diff(&left.timing, &right.timing),
    });

    let mut truncated = false;
    let mut truncated_reasons = Vec::<&str>::new();
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
        let left_result = read_optional_body(
            state,
            left_body.as_ref(),
            COMPARE_BODY_SCAN_BYTES,
            raw,
            &redactor,
        )?;
        let right_result = read_optional_body(
            state,
            right_body.as_ref(),
            COMPARE_BODY_SCAN_BYTES,
            raw,
            &redactor,
        )?;
        let outcome = body_diff(
            &left.summary.id,
            &right.summary.id,
            left_result,
            right_result,
            part,
            request.diff_mode,
            &request.json_paths,
            &json_paths,
        )?;
        truncated |= outcome.truncated;
        truncated_reasons.extend(outcome.truncated_reasons);
        data["bodyDiff"] = outcome.value;
    }
    truncated_reasons.sort();
    truncated_reasons.dedup();
    if let Some(object) = data.as_object_mut() {
        object.insert("truncatedReasons".to_string(), json!(truncated_reasons));
    }
    Ok((data, ToolMeta::new(truncated, !raw, None)))
}

fn load_snapshot(
    connection: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    raw: bool,
    redactor: &Redactor,
) -> Result<SessionSnapshot, aiproxy_db::DbError> {
    let summary = load_session_summary(connection, session_id)?
        .ok_or_else(|| aiproxy_db::DbError::not_found("session", session_id))?;
    let detail = load_session_detail(connection, session_id)?;

    let (request_headers, response_headers, query, cookies, timing) = if let Some(detail) = detail {
        let request_headers = header_map(&detail.request_headers, raw, redactor);
        let response_headers = header_map(&detail.response_headers, raw, redactor);
        let query = entry_map(&detail.query_params, raw, redactor);
        let cookies = cookie_map(&detail.cookies, raw, redactor);
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

fn header_map(json: &str, raw: bool, redactor: &Redactor) -> BTreeMap<String, String> {
    let entries = if raw {
        serde_json::from_str::<Vec<HeaderEntry>>(json).unwrap_or_default()
    } else {
        redactor.redact_headers_json(json).value
    };
    entries
        .into_iter()
        .map(|entry| (entry.name.to_lowercase(), entry.value))
        .collect()
}

fn entry_map(json: &str, raw: bool, redactor: &Redactor) -> BTreeMap<String, String> {
    let entries = if raw {
        serde_json::from_str::<Vec<HeaderEntry>>(json).unwrap_or_default()
    } else {
        redactor.redact_key_value_json(json).value
    };
    entries
        .into_iter()
        .map(|entry| (entry.name.to_lowercase(), entry.value))
        .collect()
}

fn cookie_map(json: &str, raw: bool, redactor: &Redactor) -> BTreeMap<String, String> {
    let entries = serde_json::from_str::<Vec<HeaderEntry>>(json).unwrap_or_default();
    let entries = if raw {
        entries
    } else {
        redactor.redact_cookie_headers(entries).value
    };
    entries
        .into_iter()
        .map(|entry| (entry.name.to_lowercase(), entry.value))
        .collect()
}

fn summary_diff(
    left: &SessionSummaryRow,
    right: &SessionSummaryRow,
    raw: bool,
    redactor: &Redactor,
) -> Value {
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
                redactor.redact_url(&left.url)
            }),
            json!(if raw {
                right.url.clone()
            } else {
                redactor.redact_url(&right.url)
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
    decoded_size_bytes: u64,
    wire_size_bytes: u64,
    mime_type: Option<String>,
    hash: Option<String>,
    capture_truncated: bool,
    scan_truncated: bool,
}

#[derive(Debug)]
struct BodyDiffOutcome {
    value: Value,
    truncated: bool,
    truncated_reasons: Vec<&'static str>,
}

fn read_optional_body(
    state: &AppContext,
    reference: Option<&StoredBodyReference>,
    max_bytes: usize,
    raw: bool,
    redactor: &Redactor,
) -> Result<OptionalBodyDiff, ToolError> {
    let Some(reference) = reference else {
        return Ok(OptionalBodyDiff {
            text: None,
            decoded_size_bytes: 0,
            wire_size_bytes: 0,
            mime_type: None,
            hash: None,
            capture_truncated: false,
            scan_truncated: false,
        });
    };
    let body = read_body_bytes(&state.body_store, reference, 0, max_bytes)?;
    let text = std::str::from_utf8(&body.bytes).ok().map(|value| {
        if raw {
            value.to_string()
        } else {
            redactor.redact_text(value).value
        }
    });
    Ok(OptionalBodyDiff {
        text,
        decoded_size_bytes: body.decoded_size_bytes,
        wire_size_bytes: body.wire_size_bytes,
        mime_type: reference.mime_type.clone(),
        hash: Some(sha256_hex(&body.bytes)),
        capture_truncated: body.capture_truncated,
        scan_truncated: body.has_more,
    })
}

#[allow(clippy::too_many_arguments)]
fn body_diff(
    left_id: &str,
    right_id: &str,
    left: OptionalBodyDiff,
    right: OptionalBodyDiff,
    part: BodyPart,
    mode: DiffMode,
    raw_paths: &[String],
    paths: &[Vec<JsonPathSegment>],
) -> Result<BodyDiffOutcome, ToolError> {
    let mut truncated_reasons = Vec::new();
    if left.capture_truncated || right.capture_truncated {
        truncated_reasons.push("captureLimit");
    }
    if left.scan_truncated || right.scan_truncated {
        truncated_reasons.push("scanLimit");
        return Err(ToolError::new(
            "BODY_TOO_LARGE",
            format!(
                "Body comparison requires scanning each complete body, but at least one side exceeds the {COMPARE_BODY_SCAN_BYTES}-byte scan limit."
            ),
        )
        .with_details(json!({
            "scanLimitBytes": COMPARE_BODY_SCAN_BYTES,
            "leftScanTruncated": left.scan_truncated,
            "rightScanTruncated": right.scan_truncated,
            "leftDecodedSizeBytes": left.decoded_size_bytes,
            "rightDecodedSizeBytes": right.decoded_size_bytes,
        })));
    }

    let left_json = left
        .text
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let right_json = right
        .text
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let wants_json = mode == DiffMode::Json || !paths.is_empty();
    if wants_json && (left_json.is_none() || right_json.is_none()) {
        return Err(ToolError::new(
            "BODY_NOT_JSON",
            "Structured comparison requires JSON bodies on both sides.",
        ));
    }
    if mode == DiffMode::Text && (left.text.is_none() || right.text.is_none()) {
        return Err(ToolError::new(
            "BODY_NOT_TEXT",
            "Text comparison requires UTF-8 bodies on both sides.",
        ));
    }

    let mut value_limited = false;
    let (differences, structure_parsed) =
        if wants_json || (mode == DiffMode::Auto && left_json.is_some() && right_json.is_some()) {
            let left_json = left_json.as_ref().expect("checked above");
            let right_json = right_json.as_ref().expect("checked above");
            if paths.is_empty() {
                let mut output = Vec::new();
                diff_json("$", left_json, right_json, &mut output, MAX_DIFF_CHANGES);
                (
                    json!({ "format": "json", "scope": "document", "changes": output }),
                    true,
                )
            } else {
                let (changes, limited) = path_changes(left_json, right_json, raw_paths, paths);
                value_limited |= limited;
                (
                    json!({ "format": "json", "scope": "paths", "changes": changes }),
                    true,
                )
            }
        } else if let (Some(left_text), Some(right_text)) = (&left.text, &right.text) {
            let (lines, limited) = diff_lines(left_text, right_text, MAX_DIFF_CHANGES);
            value_limited |= limited;
            (json!({ "format": "text", "lines": lines }), false)
        } else {
            (Value::Null, false)
        };

    let body_truncated = !truncated_reasons.is_empty() || value_limited;
    if value_limited {
        truncated_reasons.push("resultLimit");
    }
    truncated_reasons.sort();
    truncated_reasons.dedup();
    Ok(BodyDiffOutcome {
        value: json!({
            "part": part_label(part),
            "leftSessionId": left_id,
            "rightSessionId": right_id,
            "left": body_metadata(&left),
            "right": body_metadata(&right),
            "structureParsed": structure_parsed,
            "differences": differences,
            "truncated": body_truncated,
            "truncatedReasons": truncated_reasons,
        }),
        truncated: body_truncated,
        truncated_reasons,
    })
}

fn body_metadata(body: &OptionalBodyDiff) -> Value {
    json!({
        "present": body.text.is_some(),
        "decodedSizeBytes": body.decoded_size_bytes,
        "wireSizeBytes": body.wire_size_bytes,
        "contentType": body.mime_type,
        "hash": body.hash,
        "captureTruncated": body.capture_truncated,
        "scanTruncated": body.scan_truncated,
    })
}

fn path_changes(
    left: &Value,
    right: &Value,
    raw_paths: &[String],
    paths: &[Vec<JsonPathSegment>],
) -> (Vec<Value>, bool) {
    let mut changes = Vec::new();
    let mut limited = false;
    for (index, segments) in paths.iter().enumerate() {
        let path = raw_paths.get(index).map(String::as_str).unwrap_or("$");
        let left_result = extract_json_path(left, path, segments);
        let right_result = extract_json_path(right, path, segments);
        limited |= left_result
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || right_result
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let left_found = left_result
            .get("found")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let right_found = right_result
            .get("found")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let left_value = left_result.get("value").cloned().unwrap_or(Value::Null);
        let right_value = right_result.get("value").cloned().unwrap_or(Value::Null);
        if left_found != right_found || left_value != right_value {
            changes.push(json!({
                "path": path,
                "leftFound": left_found,
                "rightFound": right_found,
                "left": summary_value(&left_value),
                "right": summary_value(&right_value),
            }));
        }
        if changes.len() >= MAX_DIFF_CHANGES {
            limited = true;
            break;
        }
    }
    (changes, limited)
}

fn summary_value(value: &Value) -> Value {
    let serialized = serde_json::to_vec(value).unwrap_or_default();
    if serialized.len() <= MAX_DIFF_VALUE_BYTES {
        return value.clone();
    }
    if let Value::String(text) = value {
        let mut end = MAX_DIFF_VALUE_BYTES.min(text.len());
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        return Value::String(format!("{}…[truncated]", &text[..end]));
    }
    let mut end = MAX_DIFF_VALUE_BYTES.min(serialized.len());
    while end > 0 && std::str::from_utf8(&serialized[..end]).is_err() {
        end -= 1;
    }
    Value::String(format!(
        "{}…[truncated JSON value: {} bytes]",
        String::from_utf8_lossy(&serialized[..end]),
        serialized.len()
    ))
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
                    (Some(left), None) => output.push(json!({
                        "path": next,
                        "left": summary_value(left),
                        "right": Value::Null,
                    })),
                    (None, Some(right)) => output.push(json!({
                        "path": next,
                        "left": Value::Null,
                        "right": summary_value(right),
                    })),
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
                    (Some(left), None) => output.push(json!({
                        "path": next,
                        "left": summary_value(left),
                        "right": Value::Null,
                    })),
                    (None, Some(right)) => output.push(json!({
                        "path": next,
                        "left": Value::Null,
                        "right": summary_value(right),
                    })),
                    _ => {}
                }
                if output.len() >= limit {
                    return;
                }
            }
        }
        _ => output.push(json!({
            "path": path,
            "left": summary_value(left),
            "right": summary_value(right),
        })),
    }
}

fn diff_lines(left: &str, right: &str, limit: usize) -> (Vec<Value>, bool) {
    let left: Vec<_> = left.lines().collect();
    let right: Vec<_> = right.lines().collect();
    let mut output = Vec::new();
    let mut limited = false;
    for index in 0..left.len().max(right.len()) {
        if output.len() >= limit {
            limited = true;
            break;
        }
        let left_line = left.get(index).copied();
        let right_line = right.get(index).copied();
        if left_line != right_line {
            output.push(json!({
                "line": index + 1,
                "left": left_line.map(summary_text),
                "right": right_line.map(summary_text),
            }));
        }
    }
    (output, limited)
}

fn summary_text(value: &str) -> String {
    if value.len() <= MAX_DIFF_VALUE_BYTES {
        return value.to_string();
    }
    let mut end = MAX_DIFF_VALUE_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &value[..end])
}

fn part_label(part: BodyPart) -> &'static str {
    match part {
        BodyPart::Request => "request",
        BodyPart::Response => "response",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_changes_only_returns_requested_fields() {
        let left = json!({ "ab": { "ab_test": "A" }, "noise": 1 });
        let right = json!({ "ab": { "ab_test": "B" }, "noise": 2 });
        let raw_paths = vec!["$.ab.ab_test".to_string()];
        let paths = parse_json_paths(&raw_paths).unwrap();
        let (changes, limited) = path_changes(&left, &right, &raw_paths, &paths);
        assert!(!limited);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["path"], "$.ab.ab_test");
        assert_eq!(changes[0]["left"], "A");
        assert_eq!(changes[0]["right"], "B");
    }

    #[test]
    fn long_diff_values_are_bounded() {
        let value = Value::String("x".repeat(MAX_DIFF_VALUE_BYTES + 100));
        let bounded = summary_value(&value);
        assert!(bounded.as_str().unwrap().ends_with("…[truncated]"));
        assert!(bounded.as_str().unwrap().len() <= MAX_DIFF_VALUE_BYTES + 20);
    }

    #[test]
    fn scanned_body_truncation_is_an_explicit_error() {
        let body = |text: &str, scan_truncated: bool| OptionalBodyDiff {
            text: Some(text.to_string()),
            decoded_size_bytes: COMPARE_BODY_SCAN_BYTES as u64 + 1,
            wire_size_bytes: COMPARE_BODY_SCAN_BYTES as u64,
            mime_type: Some("application/json".to_string()),
            hash: None,
            capture_truncated: false,
            scan_truncated,
        };
        let error = body_diff(
            "left",
            "right",
            body("{\"ok\":true}", true),
            body("{\"ok\":false}", false),
            BodyPart::Response,
            DiffMode::Auto,
            &[],
            &[],
        )
        .unwrap_err();
        assert_eq!(error.code, "BODY_TOO_LARGE");
        assert_eq!(error.details.as_ref().unwrap()["leftScanTruncated"], true);
    }
}
