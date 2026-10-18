use aiproxy_db::body_store::BodyStore;
use aiproxy_db::sessions::load_session_detail;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use regex::RegexBuilder;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::Redactor;

use super::sessions::{lookup_session_id, require_session_id, SessionIdLookup};

const MAX_BODY_SCAN_BYTES: usize = 8 * 1024 * 1024;
const MAX_EXTRACTED_VALUE_BYTES: usize = 64 * 1024;
const MAX_TEXT_QUERY_HITS: usize = 20;
const DEFAULT_CONTEXT_BYTES: usize = 120;
const MAX_CONTEXT_BYTES: usize = 1024;
const MAX_BATCH_SESSIONS: usize = 20;
const MAX_JSON_PATHS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
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
    #[serde(default)]
    pub json_paths: Vec<String>,
    pub text_query: Option<String>,
    pub context_bytes: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetSessionFieldsRequest {
    pub session_ids: Vec<String>,
    pub part: BodyPart,
    pub json_paths: Vec<String>,
    #[serde(default)]
    pub redaction_mode: BodyRedactionMode,
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
    pub decoded_size_bytes: u64,
    pub wire_size_bytes: u64,
    pub offset: u64,
    pub returned_bytes: usize,
    pub has_more: bool,
    pub capture_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum JsonPathSegment {
    Key(String),
    Index(usize),
    Wildcard,
}

#[derive(Debug)]
struct BodySizes {
    wire_size_bytes: u64,
    decoded_size_bytes: u64,
    capture_truncated: bool,
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
    if request.redaction_mode == BodyRedactionMode::Metadata
        && (!request.json_paths.is_empty() || request.text_query.is_some())
    {
        return Err(ToolError::invalid(
            "metadata mode cannot be combined with jsonPaths or textQuery.",
        ));
    }
    if matches!(
        request.redaction_mode,
        BodyRedactionMode::Metadata | BodyRedactionMode::Base64
    ) && !request.json_paths.is_empty()
    {
        return Err(ToolError::invalid(
            "jsonPaths is supported only in redacted-text or raw mode.",
        ));
    }
    let json_paths = parse_json_paths(&request.json_paths)?;
    let text_query = validate_text_query(request.text_query.as_deref())?.map(str::to_string);
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;
    let session_id = require_session_id(state, &request.session_id).await?;
    let part = request.part;
    let reference = load_required_body_reference(state, &session_id, part).await?;
    let sizes = body_sizes(&state.body_store, &reference)?;

    if sizes.decoded_size_bytes == 0 {
        return Err(body_error(
            "BODY_NOT_FOUND",
            "The requested body is empty.",
            "empty",
            part,
        ));
    }

    if request.redaction_mode == BodyRedactionMode::Metadata {
        let data = json!({
            "sessionId": session_id,
            "part": part_label(part),
            "contentType": reference.mime_type,
            "contentEncoding": reference.encoding,
            "encoding": "metadata",
            "isUtf8": Value::Null,
            "text": Value::Null,
            "base64": Value::Null,
            "jsonPaths": [],
            "textMatches": [],
            "wireSizeBytes": sizes.wire_size_bytes,
            "decodedSizeBytes": sizes.decoded_size_bytes,
            "viewSizeBytes": Value::Null,
            "offsetUnit": "none",
            "offset": 0,
            "returnedBytes": 0,
            "nextOffset": Value::Null,
            "hasMore": false,
            "captureTruncated": sizes.capture_truncated,
            "scanTruncated": false,
            "truncatedReasons": if sizes.capture_truncated { vec!["captureLimit"] } else { Vec::<&str>::new() },
            "redactedFields": [],
            "structureParsed": false,
            "hash": Value::Null,
        });
        let meta = if sizes.capture_truncated {
            ToolMeta::new(true, false, None).with_truncated_reason("captureLimit")
        } else {
            ToolMeta::new(false, false, None)
        };
        return Ok((data, meta));
    }

    if !json_paths.is_empty() || text_query.is_some() {
        return extract_body(
            state,
            request,
            &session_id,
            part,
            &reference,
            &sizes,
            &json_paths,
            text_query.as_deref(),
            &redactor,
        );
    }

    read_body_page(
        state,
        request,
        &session_id,
        part,
        &reference,
        &sizes,
        &redactor,
        config.limits.max_body_bytes,
    )
}

pub async fn get_session_fields(
    state: &AppContext,
    request: GetSessionFieldsRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_bodies {
        return Err(ToolError::permission_denied(
            "Body reading is disabled in Agent Access.",
        ));
    }
    if request.redaction_mode == BodyRedactionMode::Raw && !config.permissions.read_raw_bodies {
        return Err(ToolError::permission_denied(
            "Raw field extraction requires the readRawBodies permission.",
        ));
    }
    if !matches!(
        request.redaction_mode,
        BodyRedactionMode::RedactedText | BodyRedactionMode::Raw
    ) {
        return Err(ToolError::invalid(
            "get_session_fields supports redacted-text or raw mode.",
        ));
    }
    if request.session_ids.is_empty() {
        return Err(ToolError::invalid("sessionIds must not be empty."));
    }
    if request.session_ids.len() > MAX_BATCH_SESSIONS {
        return Err(ToolError::invalid(format!(
            "sessionIds accepts at most {MAX_BATCH_SESSIONS} values."
        )));
    }
    let json_paths = parse_json_paths(&request.json_paths)?;
    if json_paths.is_empty() {
        return Err(ToolError::invalid("jsonPaths must not be empty."));
    }
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;
    let requested_ids = request.session_ids.clone();
    let lookups = state
        .with_db(move |connection| {
            requested_ids
                .iter()
                .map(|requested| {
                    lookup_session_id(connection, requested)
                        .map(|lookup| (requested.clone(), lookup))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .await?;

    let exact_ids = lookups
        .iter()
        .filter_map(|(_, lookup)| match lookup {
            SessionIdLookup::Found(id) => Some(id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let ids_for_query = exact_ids.clone();
    let part = request.part;
    let references = state
        .with_db(move |connection| {
            ids_for_query
                .iter()
                .map(|id| load_body_reference(connection, id, part))
                .collect::<Result<Vec<_>, _>>()
        })
        .await?;
    let reference_by_id = exact_ids
        .into_iter()
        .zip(references)
        .collect::<std::collections::BTreeMap<_, _>>();

    let mut items = Vec::with_capacity(lookups.len());
    let mut any_truncated = false;
    let raw = request.redaction_mode == BodyRedactionMode::Raw;
    for (requested, lookup) in lookups {
        match lookup {
            SessionIdLookup::NotFound => items.push(field_item_error(
                &requested,
                None,
                "SESSION_NOT_FOUND",
                "Session not found.",
            )),
            SessionIdLookup::Ambiguous(candidates) => items.push(json!({
                "requestedSessionId": requested,
                "error": {
                    "code": "SESSION_ID_AMBIGUOUS",
                    "message": "The sessionId prefix matches more than one session.",
                    "details": { "candidates": candidates },
                }
            })),
            SessionIdLookup::Found(id) => {
                let Some(Some(reference)) = reference_by_id.get(&id) else {
                    items.push(field_item_error(
                        &requested,
                        Some(&id),
                        "BODY_NOT_FOUND",
                        "The requested body is not captured.",
                    ));
                    continue;
                };
                match extract_fields_from_reference(
                    &state.body_store,
                    &id,
                    reference,
                    &json_paths,
                    raw,
                    &redactor,
                ) {
                    Ok((values, truncated)) => {
                        any_truncated |= truncated;
                        items.push(json!({
                            "requestedSessionId": requested,
                            "sessionId": id,
                            "part": part_label(part),
                            "values": values,
                        }));
                    }
                    Err(error) => items.push(field_item_error(
                        &requested,
                        Some(&id),
                        error.code,
                        &error.message,
                    )),
                }
            }
        }
    }

    Ok((
        json!({ "items": items }),
        ToolMeta::new(any_truncated, !raw, None),
    ))
}

#[allow(clippy::too_many_arguments)]
fn read_body_page(
    state: &AppContext,
    request: GetSessionBodyRequest,
    session_id: &str,
    part: BodyPart,
    reference: &StoredBodyReference,
    sizes: &BodySizes,
    redactor: &Redactor,
    configured_max_bytes: usize,
) -> Result<(Value, ToolMeta), ToolError> {
    let max_bytes = request
        .max_bytes
        .unwrap_or(configured_max_bytes)
        .clamp(1, configured_max_bytes);
    let offset = request.offset.unwrap_or(0);
    let mode = request.redaction_mode;

    if matches!(mode, BodyRedactionMode::RedactedText) {
        let body = read_full_body(&state.body_store, reference, MAX_BODY_SCAN_BYTES)?;
        if body.scan_truncated {
            return Err(ToolError::new(
                "BODY_TOO_LARGE",
                format!(
                    "Redacted body pagination requires scanning the complete body, but it exceeds {} bytes. Use metadata mode or jsonPaths for a narrower result.",
                    MAX_BODY_SCAN_BYTES
                ),
            )
            .with_details(json!({
                "decodedSizeBytes": sizes.decoded_size_bytes,
                "scanLimitBytes": MAX_BODY_SCAN_BYTES,
            })));
        }
        let Some(raw_text) = std::str::from_utf8(&body.bytes).ok().map(str::to_owned) else {
            let data = json!({
                "sessionId": session_id,
                "part": part_label(part),
                "contentType": reference.mime_type,
                "contentEncoding": reference.encoding,
                "encoding": "binary",
                "isUtf8": false,
                "text": Value::Null,
                "base64": Value::Null,
                "jsonPaths": [],
                "textMatches": [],
                "wireSizeBytes": sizes.wire_size_bytes,
                "decodedSizeBytes": sizes.decoded_size_bytes,
                "viewSizeBytes": Value::Null,
                "offsetUnit": "none",
                "offset": offset,
                "returnedBytes": 0,
                "nextOffset": Value::Null,
                "hasMore": false,
                "captureTruncated": sizes.capture_truncated,
                "scanTruncated": body.scan_truncated,
                "truncatedReasons": body_truncation_reasons(sizes.capture_truncated, body.scan_truncated, false, false),
                "redactedFields": [],
                "structureParsed": false,
                "hash": Value::Null,
            });
            return Ok((
                data,
                ToolMeta::new(sizes.capture_truncated || body.scan_truncated, false, None),
            ));
        };
        let redacted = redactor.redact_text(&raw_text);
        let view = redacted.value;
        let page = slice_text_page(&view, offset, max_bytes)?;
        let reasons = body_truncation_reasons(
            sizes.capture_truncated,
            body.scan_truncated,
            page.has_more,
            false,
        );
        let truncated = !reasons.is_empty();
        let data = json!({
            "sessionId": session_id,
            "part": part_label(part),
            "contentType": reference.mime_type,
            "contentEncoding": reference.encoding,
            "encoding": "text",
            "isUtf8": true,
            "text": page.text,
            "base64": Value::Null,
            "jsonPaths": [],
            "textMatches": [],
            "wireSizeBytes": sizes.wire_size_bytes,
            "decodedSizeBytes": sizes.decoded_size_bytes,
            "viewSizeBytes": view.len(),
            "offsetUnit": "decodedViewBytes",
            "offset": page.offset,
            "returnedBytes": page.returned_bytes,
            "nextOffset": page.next_offset,
            "hasMore": page.has_more,
            "captureTruncated": sizes.capture_truncated,
            "scanTruncated": body.scan_truncated,
            "truncatedReasons": reasons,
            "redactedFields": redacted.fields,
            "structureParsed": serde_json::from_str::<Value>(&view).is_ok() && page.offset == 0 && !page.has_more,
            "hash": { "algorithm": "sha256", "value": sha256_hex(page.text.as_bytes()), "scope": "returnedViewRange" },
        });
        return Ok((data, ToolMeta::new(truncated, true, None)));
    }

    let body = read_body_bytes(&state.body_store, reference, offset, max_bytes)?;
    if matches!(mode, BodyRedactionMode::Raw)
        && body.bytes.is_empty()
        && offset >= body.decoded_size_bytes
    {
        return Err(ToolError::invalid(
            "Body offset must be less than the decoded size.",
        ));
    }
    let is_utf8 = std::str::from_utf8(&body.bytes).is_ok();
    let (text, base64, encoding, redacted) = match mode {
        BodyRedactionMode::Raw if is_utf8 => (
            Value::String(String::from_utf8_lossy(&body.bytes).into_owned()),
            Value::Null,
            "text",
            false,
        ),
        BodyRedactionMode::Raw => (
            Value::Null,
            Value::String(STANDARD.encode(&body.bytes)),
            "base64",
            false,
        ),
        BodyRedactionMode::Base64 => (
            Value::Null,
            Value::String(STANDARD.encode(&body.bytes)),
            "base64",
            false,
        ),
        BodyRedactionMode::RedactedText | BodyRedactionMode::Metadata => unreachable!(),
    };
    let reasons = body_truncation_reasons(sizes.capture_truncated, false, body.has_more, false);
    let truncated = !reasons.is_empty();
    let data = json!({
        "sessionId": session_id,
        "part": part_label(part),
        "contentType": reference.mime_type,
        "contentEncoding": reference.encoding,
        "encoding": encoding,
        "isUtf8": is_utf8,
        "text": text,
        "base64": base64,
        "jsonPaths": [],
        "textMatches": [],
        "wireSizeBytes": body.wire_size_bytes,
        "decodedSizeBytes": body.decoded_size_bytes,
        "viewSizeBytes": body.decoded_size_bytes,
        "offsetUnit": "decodedBodyBytes",
        "offset": body.offset,
        "returnedBytes": body.returned_bytes,
        "nextOffset": if body.has_more { json!(body.offset + body.returned_bytes as u64) } else { Value::Null },
        "hasMore": body.has_more,
        "captureTruncated": body.capture_truncated,
        "scanTruncated": false,
        "truncatedReasons": reasons,
        "redactedFields": [],
        "structureParsed": false,
        "hash": { "algorithm": "sha256", "value": sha256_hex(&body.bytes), "scope": "returnedDecodedBytes" },
    });
    Ok((data, ToolMeta::new(truncated, redacted, None)))
}

#[allow(clippy::too_many_arguments)]
fn extract_body(
    state: &AppContext,
    request: GetSessionBodyRequest,
    session_id: &str,
    part: BodyPart,
    reference: &StoredBodyReference,
    sizes: &BodySizes,
    json_paths: &[Vec<JsonPathSegment>],
    text_query: Option<&str>,
    redactor: &Redactor,
) -> Result<(Value, ToolMeta), ToolError> {
    let body = read_full_body(&state.body_store, reference, MAX_BODY_SCAN_BYTES)?;
    if body.scan_truncated {
        return Err(ToolError::new(
            "BODY_TOO_LARGE",
            format!(
                "Field extraction requires scanning the complete body, but it exceeds {} bytes.",
                MAX_BODY_SCAN_BYTES
            ),
        )
        .with_details(json!({
            "decodedSizeBytes": sizes.decoded_size_bytes,
            "scanLimitBytes": MAX_BODY_SCAN_BYTES,
        })));
    }
    let raw_text = std::str::from_utf8(&body.bytes).map_err(|_| {
        body_error(
            if json_paths.is_empty() {
                "BODY_NOT_TEXT"
            } else {
                "BODY_NOT_JSON"
            },
            if json_paths.is_empty() {
                "textQuery requires a UTF-8 text body."
            } else {
                "jsonPaths requires a UTF-8 JSON body."
            },
            "notText",
            part,
        )
    })?;
    let raw = request.redaction_mode == BodyRedactionMode::Raw;
    let mut redacted_fields = Vec::new();
    let mut json_values = Vec::new();
    let mut text_match_results = Vec::new();
    let mut result_limited = false;
    let mut value_limited = false;

    let mut parsed_json = None;
    if !json_paths.is_empty() {
        let mut value = serde_json::from_str::<Value>(raw_text).map_err(|_| {
            body_error(
                "BODY_NOT_JSON",
                "jsonPaths requires a JSON body.",
                "notJson",
                part,
            )
        })?;
        if !raw {
            let mut records = Vec::new();
            redactor.redact_json_value(&mut value, "$", &mut records);
            redacted_fields = records.into_iter().map(|record| record.rule).collect();
        }
        parsed_json = Some(value);
    }

    if let Some(value) = &parsed_json {
        for (index, segments) in json_paths.iter().enumerate() {
            let result = extract_json_path(value, &request.json_paths[index], segments);
            if result
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                value_limited = true;
            }
            json_values.push(result);
        }
    }

    if let Some(query) = text_query {
        let (search_text, fields) = if raw {
            (raw_text.to_string(), Vec::new())
        } else if let Some(value) = &parsed_json {
            let rendered = serde_json::to_string(value).unwrap_or_else(|_| raw_text.to_string());
            (rendered, redacted_fields.clone())
        } else {
            let redacted = redactor.redact_text(raw_text);
            let value = redacted.value;
            let fields = redacted.fields;
            redacted_fields.extend(fields.iter().cloned());
            (value, fields)
        };
        redacted_fields.extend(fields);
        let context_bytes = request
            .context_bytes
            .unwrap_or(DEFAULT_CONTEXT_BYTES)
            .min(MAX_CONTEXT_BYTES);
        let result = text_matches(&search_text, query, context_bytes);
        result_limited = result.1;
        text_match_results = result.0;
    }

    let json_payload_size = if json_values.is_empty() {
        0
    } else {
        serde_json::to_vec(&json_values).map_or(0, |value| value.len())
    };
    let text_payload_size = if text_match_results.is_empty() {
        0
    } else {
        serde_json::to_vec(&text_match_results).map_or(0, |value| value.len())
    };
    let returned_bytes = json_payload_size + text_payload_size;
    let reasons = body_truncation_reasons(
        sizes.capture_truncated,
        false,
        false,
        result_limited || value_limited,
    );
    let truncated = !reasons.is_empty();
    redacted_fields.sort();
    redacted_fields.dedup();
    let data = json!({
        "sessionId": session_id,
        "part": part_label(part),
        "contentType": reference.mime_type,
        "contentEncoding": reference.encoding,
        "encoding": "json",
        "isUtf8": true,
        "text": Value::Null,
        "base64": Value::Null,
        "jsonPaths": json_values,
        "textMatches": text_match_results,
        "wireSizeBytes": sizes.wire_size_bytes,
        "decodedSizeBytes": sizes.decoded_size_bytes,
        "viewSizeBytes": parsed_json
            .as_ref()
            .and_then(|value| serde_json::to_vec(value).ok())
            .map(|value| value.len()),
        "offsetUnit": "none",
        "offset": 0,
        "returnedBytes": returned_bytes,
        "nextOffset": Value::Null,
        "hasMore": false,
        "captureTruncated": sizes.capture_truncated,
        "scanTruncated": false,
        "truncatedReasons": reasons,
        "redactedFields": redacted_fields,
        "structureParsed": parsed_json.is_some(),
        "hash": { "algorithm": "sha256", "value": sha256_hex(raw_text.as_bytes()), "scope": "decodedBody" },
    });
    Ok((data, ToolMeta::new(truncated, !raw, None)))
}

fn extract_fields_from_reference(
    store: &BodyStore,
    session_id: &str,
    reference: &StoredBodyReference,
    json_paths: &[Vec<JsonPathSegment>],
    raw: bool,
    redactor: &Redactor,
) -> Result<(Vec<Value>, bool), ToolError> {
    let _ = session_id;
    let body = read_full_body(store, reference, MAX_BODY_SCAN_BYTES)?;
    if body.scan_truncated {
        return Err(ToolError::new(
            "BODY_TOO_LARGE",
            "The body exceeds the field extraction scan limit.",
        ));
    }
    let text = std::str::from_utf8(&body.bytes)
        .map_err(|_| ToolError::new("BODY_NOT_JSON", "The body is not UTF-8 JSON."))?;
    let mut value = serde_json::from_str::<Value>(text)
        .map_err(|_| ToolError::new("BODY_NOT_JSON", "The body is not valid JSON."))?;
    if !raw {
        let mut records = Vec::new();
        redactor.redact_json_value(&mut value, "$", &mut records);
    }
    let mut truncated = false;
    let mut values = Vec::with_capacity(json_paths.len());
    for segments in json_paths {
        let path = render_json_path(segments);
        let result = extract_json_path(&value, &path, segments);
        truncated |= result
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        values.push(result);
    }
    Ok((values, truncated))
}

fn load_required_body_reference<'a>(
    state: &'a AppContext,
    session_id: &'a str,
    part: BodyPart,
) -> impl std::future::Future<Output = Result<StoredBodyReference, ToolError>> + 'a {
    let session_id = session_id.to_string();
    async move {
        state
            .with_db(move |connection| load_body_reference(connection, &session_id, part))
            .await?
            .ok_or_else(|| {
                body_error(
                    "BODY_NOT_FOUND",
                    "The requested body was not captured for this session.",
                    "notCaptured",
                    part,
                )
            })
    }
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
            .map_err(|error| {
                ToolError::new(
                    "BODY_NOT_FOUND",
                    format!("The stored body file is unavailable: {error}"),
                )
                .with_details(json!({ "reason": "fileMissing" }))
            })?;
        return Ok(BodyBytes {
            bytes: range.bytes,
            decoded_size_bytes: range.original_size_bytes,
            wire_size_bytes: wire_size(reference, range.original_size_bytes),
            offset: range.offset,
            returned_bytes: range.returned_bytes,
            has_more: range.truncated,
            capture_truncated: reference.truncated,
        });
    }

    let decoded = decode_inline_reference(reference)?;
    let decoded_size_bytes = decoded.len() as u64;
    if offset > decoded_size_bytes {
        return Err(ToolError::invalid(
            "Body offset exceeds the decoded body size.",
        ));
    }
    let start = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(decoded.len());
    let end = start.saturating_add(max_bytes).min(decoded.len());
    Ok(BodyBytes {
        bytes: decoded[start..end].to_vec(),
        decoded_size_bytes,
        wire_size_bytes: wire_size(reference, decoded_size_bytes),
        offset,
        returned_bytes: end - start,
        has_more: end < decoded.len(),
        capture_truncated: reference.truncated,
    })
}

struct FullBody {
    bytes: Vec<u8>,
    scan_truncated: bool,
}

fn read_full_body(
    store: &BodyStore,
    reference: &StoredBodyReference,
    max_bytes: usize,
) -> Result<FullBody, ToolError> {
    let page = read_body_bytes(store, reference, 0, max_bytes)?;
    Ok(FullBody {
        bytes: page.bytes,
        scan_truncated: page.has_more,
    })
}

fn body_sizes(store: &BodyStore, reference: &StoredBodyReference) -> Result<BodySizes, ToolError> {
    let decoded_size_bytes = if let Some(file_path) = &reference.file_path {
        store
            .read_body_range(file_path, 0, 0)
            .map_err(|error| {
                ToolError::new(
                    "BODY_NOT_FOUND",
                    format!("The stored body file is unavailable: {error}"),
                )
                .with_details(json!({ "reason": "fileMissing" }))
            })?
            .original_size_bytes
    } else {
        decode_inline_reference(reference)?.len() as u64
    };
    Ok(BodySizes {
        wire_size_bytes: wire_size(reference, decoded_size_bytes),
        decoded_size_bytes,
        capture_truncated: reference.truncated,
    })
}

fn wire_size(reference: &StoredBodyReference, decoded_size_bytes: u64) -> u64 {
    if reference.size_bytes > 0 {
        reference.size_bytes
    } else {
        decoded_size_bytes
    }
}

fn decode_inline_reference(reference: &StoredBodyReference) -> Result<Vec<u8>, ToolError> {
    if let Some(base64_text) = &reference.base64_text {
        STANDARD.decode(base64_text).map_err(|error| {
            ToolError::new(
                "BODY_NOT_FOUND",
                format!("The inline body reference is invalid: {error}"),
            )
            .with_details(json!({ "reason": "corruptReference" }))
        })
    } else if let Some(inline_text) = &reference.inline_text {
        Ok(inline_text.as_bytes().to_vec())
    } else {
        Err(ToolError::new(
            "BODY_NOT_FOUND",
            "The body reference contains no readable payload.",
        )
        .with_details(json!({ "reason": "corruptReference" })))
    }
}

struct TextPage {
    text: String,
    offset: u64,
    returned_bytes: usize,
    next_offset: Option<u64>,
    has_more: bool,
}

fn slice_text_page(text: &str, offset: u64, max_bytes: usize) -> Result<TextPage, ToolError> {
    let offset = usize::try_from(offset).unwrap_or(usize::MAX);
    if offset > text.len() {
        return Err(ToolError::invalid(
            "Body offset exceeds the decoded view size.",
        ));
    }
    if !text.is_char_boundary(offset) {
        return Err(ToolError::invalid(
            "Body offset must fall on a UTF-8 character boundary.",
        ));
    }
    let mut end = offset.saturating_add(max_bytes).min(text.len());
    while end > offset && !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == offset && offset < text.len() && max_bytes > 0 {
        end = text[offset..]
            .char_indices()
            .nth(1)
            .map(|(index, _)| offset + index)
            .unwrap_or(text.len());
    }
    let has_more = end < text.len();
    Ok(TextPage {
        text: text[offset..end].to_string(),
        offset: offset as u64,
        returned_bytes: end - offset,
        next_offset: has_more.then_some(end as u64),
        has_more,
    })
}

fn validate_text_query(query: Option<&str>) -> Result<Option<&str>, ToolError> {
    let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if query.chars().count() > 256 {
        return Err(ToolError::invalid(
            "textQuery must be at most 256 characters.",
        ));
    }
    Ok(Some(query))
}

pub(crate) fn parse_json_paths(paths: &[String]) -> Result<Vec<Vec<JsonPathSegment>>, ToolError> {
    if paths.len() > MAX_JSON_PATHS {
        return Err(ToolError::invalid(format!(
            "jsonPaths accepts at most {MAX_JSON_PATHS} values."
        )));
    }
    paths
        .iter()
        .map(|path| {
            parse_json_path(path).map_err(|message| {
                ToolError::new("JSON_PATH_INVALID", message).with_details(json!({ "path": path }))
            })
        })
        .collect()
}

fn parse_json_path(path: &str) -> Result<Vec<JsonPathSegment>, String> {
    let path = path.trim();
    if !path.starts_with('$') {
        return Err("JSON path must start with $.".to_string());
    }
    let mut segments = Vec::new();
    let bytes = path.as_bytes();
    let mut position = 1;
    while position < path.len() {
        match bytes[position] {
            b'.' => {
                position += 1;
                let key_start = position;
                while position < path.len() && bytes[position] != b'.' && bytes[position] != b'[' {
                    position += 1;
                }
                if key_start == position {
                    return Err("JSON path contains an empty property segment.".to_string());
                }
                let key = &path[key_start..position];
                if key.chars().any(char::is_control) {
                    return Err("JSON path property contains a control character.".to_string());
                }
                segments.push(JsonPathSegment::Key(key.to_string()));
            }
            b'[' => {
                let (segment, next_position) = parse_bracket_segment(path, position)?;
                segments.push(segment);
                position = next_position;
            }
            _ => {
                return Err("JSON path must use dot or bracket notation.".to_string());
            }
        }
    }
    Ok(segments)
}

fn parse_bracket_segment(path: &str, open: usize) -> Result<(JsonPathSegment, usize), String> {
    let inner_start = open + 1;
    if inner_start >= path.len() {
        return Err("JSON path is missing a closing ].".to_string());
    }
    if path[inner_start..].starts_with('*') {
        let close = inner_start + 1;
        if path.as_bytes().get(close) != Some(&b']') {
            return Err("Invalid wildcard JSON path segment.".to_string());
        }
        return Ok((JsonPathSegment::Wildcard, close + 1));
    }
    if let Some(quote) = path[inner_start..]
        .chars()
        .next()
        .filter(|value| matches!(value, '\'' | '"'))
    {
        let mut output = String::new();
        let mut escaped = false;
        let content_start = inner_start + quote.len_utf8();
        for (offset, character) in path[content_start..].char_indices() {
            if escaped {
                output.push(character);
                escaped = false;
                continue;
            }
            if character == '\\' {
                escaped = true;
                continue;
            }
            if character == quote {
                let close = content_start + offset + character.len_utf8();
                if path.as_bytes().get(close) != Some(&b']') {
                    return Err("Quoted JSON path property must be followed by ].".to_string());
                }
                return Ok((JsonPathSegment::Key(output), close + 1));
            }
            output.push(character);
        }
        return Err("JSON path contains an unterminated quoted property.".to_string());
    }
    let closing = path[inner_start..]
        .find(']')
        .ok_or_else(|| "JSON path is missing a closing ].".to_string())?;
    let closing = inner_start + closing;
    let item = &path[inner_start..closing];
    if item.is_empty() || !item.chars().all(|character| character.is_ascii_digit()) {
        return Err("Bracket JSON path segment must be an array index or *.".to_string());
    }
    let index = item
        .parse::<usize>()
        .map_err(|_| "JSON path array index is too large.".to_string())?;
    Ok((JsonPathSegment::Index(index), closing + 1))
}

pub(crate) fn extract_json_path(value: &Value, path: &str, segments: &[JsonPathSegment]) -> Value {
    let matches = extract_matches(value, segments);
    if matches.is_empty() {
        return json!({
            "path": path,
            "found": false,
            "value": Value::Null,
            "valueType": "missing",
            "matchCount": 0,
            "truncated": false,
        });
    }

    let contains_wildcard = segments
        .iter()
        .any(|segment| matches!(segment, JsonPathSegment::Wildcard));
    let value_type = matches
        .first()
        .map(|value| json_type_name(value))
        .unwrap_or("missing");
    let mut truncated = false;
    let value = if contains_wildcard || matches.len() > 1 {
        let values = matches
            .into_iter()
            .map(|value| {
                let (value, value_truncated) = bounded_json_value(value);
                truncated |= value_truncated;
                value
            })
            .collect::<Vec<_>>();
        Value::Array(values)
    } else {
        let (value, value_truncated) = bounded_json_value(matches[0]);
        truncated = value_truncated;
        value
    };
    json!({
        "path": path,
        "found": true,
        "value": value,
        "valueType": if contains_wildcard { "array" } else { value_type },
        "matchCount": if contains_wildcard { matches_len(&value) } else { 1 },
        "truncated": truncated,
    })
}

fn matches_len(value: &Value) -> usize {
    value.as_array().map_or(1, Vec::len)
}

fn extract_matches<'a>(value: &'a Value, segments: &[JsonPathSegment]) -> Vec<&'a Value> {
    let Some((segment, rest)) = segments.split_first() else {
        return vec![value];
    };
    match (segment, value) {
        (JsonPathSegment::Key(key), Value::Object(object)) => object
            .get(key)
            .map(|value| extract_matches(value, rest))
            .unwrap_or_default(),
        (JsonPathSegment::Index(index), Value::Array(items)) => items
            .get(*index)
            .map(|value| extract_matches(value, rest))
            .unwrap_or_default(),
        (JsonPathSegment::Wildcard, Value::Array(items)) => items
            .iter()
            .flat_map(|value| extract_matches(value, rest))
            .collect(),
        (JsonPathSegment::Wildcard, Value::Object(object)) => object
            .values()
            .flat_map(|value| extract_matches(value, rest))
            .collect(),
        _ => Vec::new(),
    }
}

fn bounded_json_value(value: &Value) -> (Value, bool) {
    let serialized = serde_json::to_vec(value).unwrap_or_default();
    if serialized.len() <= MAX_EXTRACTED_VALUE_BYTES {
        return (value.clone(), false);
    }
    if let Value::String(text) = value {
        let mut end = MAX_EXTRACTED_VALUE_BYTES.min(text.len());
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        return (Value::String(format!("{}…[truncated]", &text[..end])), true);
    }
    let mut end = MAX_EXTRACTED_VALUE_BYTES.min(serialized.len());
    while end > 0 && std::str::from_utf8(&serialized[..end]).is_err() {
        end -= 1;
    }
    (
        Value::String(format!(
            "{}…[truncated JSON value: {} bytes]",
            String::from_utf8_lossy(&serialized[..end]),
            serialized.len()
        )),
        true,
    )
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

fn render_json_path(segments: &[JsonPathSegment]) -> String {
    let mut path = "$".to_string();
    for segment in segments {
        match segment {
            JsonPathSegment::Key(key)
                if key.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                }) =>
            {
                path.push('.');
                path.push_str(key);
            }
            JsonPathSegment::Key(key) => {
                path.push_str("['");
                path.push_str(&key.replace('\\', "\\\\").replace('\'', "\\'"));
                path.push_str("']");
            }
            JsonPathSegment::Index(index) => {
                path.push('[');
                path.push_str(&index.to_string());
                path.push(']');
            }
            JsonPathSegment::Wildcard => path.push_str("[*]"),
        }
    }
    path
}

fn text_matches(text: &str, query: &str, context_bytes: usize) -> (Vec<Value>, bool) {
    let Ok(regex) = RegexBuilder::new(&regex::escape(query))
        .case_insensitive(true)
        .build()
    else {
        return (Vec::new(), false);
    };
    let mut matches = Vec::new();
    let mut limited = false;
    for found in regex.find_iter(text) {
        if matches.len() >= MAX_TEXT_QUERY_HITS {
            limited = true;
            break;
        }
        let mut start = found.start().saturating_sub(context_bytes);
        while start > 0 && !text.is_char_boundary(start) {
            start -= 1;
        }
        let mut end = found.end().saturating_add(context_bytes).min(text.len());
        while end < text.len() && !text.is_char_boundary(end) {
            end += 1;
        }
        matches.push(json!({
            "offsetBytes": found.start(),
            "snippet": &text[start..end],
            "match": found.as_str(),
        }));
    }
    (matches, limited)
}

fn body_truncation_reasons(
    capture_truncated: bool,
    scan_truncated: bool,
    page_has_more: bool,
    result_limited: bool,
) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if capture_truncated {
        reasons.push("captureLimit");
    }
    if scan_truncated {
        reasons.push("scanLimit");
    }
    if page_has_more {
        reasons.push("pageLimit");
    }
    if result_limited {
        reasons.push("resultLimit");
    }
    reasons
}

fn body_error(code: &'static str, message: &str, reason: &str, part: BodyPart) -> ToolError {
    ToolError::new(code, message).with_details(json!({
        "reason": reason,
        "part": part_label(part),
    }))
}

fn field_item_error(requested: &str, session_id: Option<&str>, code: &str, message: &str) -> Value {
    json!({
        "requestedSessionId": requested,
        "sessionId": session_id,
        "error": { "code": code, "message": message },
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

    fn reference(inline_text: &str) -> StoredBodyReference {
        StoredBodyReference {
            file_path: None,
            inline_text: Some(inline_text.to_string()),
            base64_text: None,
            mime_type: Some("application/json".to_string()),
            encoding: None,
            size_bytes: inline_text.len() as u64,
            truncated: false,
        }
    }

    #[test]
    fn parses_supported_json_paths() {
        assert_eq!(parse_json_path("$").unwrap(), Vec::new());
        assert_eq!(
            parse_json_path("$.ab.ab_test").unwrap(),
            vec![
                JsonPathSegment::Key("ab".to_string()),
                JsonPathSegment::Key("ab_test".to_string())
            ]
        );
        assert_eq!(
            parse_json_path("$['ab']['ab_test']").unwrap(),
            vec![
                JsonPathSegment::Key("ab".to_string()),
                JsonPathSegment::Key("ab_test".to_string())
            ]
        );
        assert_eq!(
            parse_json_path("$[0].name").unwrap(),
            vec![
                JsonPathSegment::Index(0),
                JsonPathSegment::Key("name".to_string())
            ]
        );
        assert_eq!(
            parse_json_path("$[*].name").unwrap(),
            vec![
                JsonPathSegment::Wildcard,
                JsonPathSegment::Key("name".to_string())
            ]
        );
    }

    #[test]
    fn rejects_unsupported_json_paths() {
        for path in ["ab.ab_test", "$.", "$[-1]", "$[name]", "$['ab'", "$..ab"] {
            assert!(parse_json_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn extracts_nested_values_and_wildcards() {
        let value =
            json!({ "ab": { "ab_test": "B" }, "items": [{ "name": "a" }, { "name": "b" }] });
        let segments = parse_json_path("$.ab.ab_test").unwrap();
        let result = extract_json_path(&value, "$.ab.ab_test", &segments);
        assert_eq!(result["value"], "B");
        assert_eq!(result["found"], true);

        let segments = parse_json_path("$.items[*].name").unwrap();
        let result = extract_json_path(&value, "$.items[*].name", &segments);
        assert_eq!(result["value"], json!(["a", "b"]));
    }

    #[test]
    fn text_query_returns_context() {
        let (matches, limited) = text_matches("alpha beta gamma", "beta", 3);
        assert!(!limited);
        assert_eq!(matches[0]["match"], "beta");
        assert!(matches[0]["snippet"].as_str().unwrap().contains("beta"));
    }

    #[test]
    fn reads_inline_body_range() {
        let reference = reference("hello world");
        let store = BodyStore::new(std::env::temp_dir());
        let range = read_body_bytes(&store, &reference, 6, 4).unwrap();
        assert_eq!(range.bytes, b"worl");
        assert!(range.has_more);
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
            size_bytes: 5,
            truncated: false,
        };
        let range = read_body_bytes(&store, &reference, 3, 4).unwrap();
        assert_eq!(range.bytes, b"3456");
        assert_eq!(range.wire_size_bytes, 5);
        assert_eq!(range.decoded_size_bytes, 10);
        assert!(range.has_more);
    }
}
