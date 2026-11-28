use std::io::{Cursor, Read};

use aiproxy_agent_control::{AgentCapability, AgentGrantScope};
use aiproxy_db::body_store::BodyStore;
use aiproxy_db::session_completion::{read_completion_watermark, CompletionCursor};
use aiproxy_db::session_search::{
    search_completion_snapshot, CompletedSessionPage, SessionSearchFilter, MAX_SESSION_SEARCH_LIMIT,
};
use aiproxy_db::DbError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use hmac::Mac;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::context::AppContext;
use crate::control_client::ControlCaller;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::Redactor;

use super::body::{
    decode_inline_reference, load_body_reference, parse_json_paths, render_json_path,
    require_session_details, BodyPart, StoredBodyReference, MAX_BATCH_JSON_SCAN_BYTES,
};
use super::body_stream::MAX_JSON_PATH_SCAN_BYTES;
use super::field_search_stream::{
    scan_json, FieldCondition, FieldTarget, JsonMatches, MAX_MATCHES_PER_SESSION,
    MAX_SEARCH_STRING_BYTES,
};
use super::sessions::parse_since_duration;

const MAX_CANDIDATES: usize = 100;
const MAX_TARGET_BYTES: usize = 1024;
const DEFAULT_LOOKBACK: &str = "10m";
const CURSOR_VERSION: &str = "sf1";

#[derive(Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldSearchFilter {
    /// Exact host (case-insensitive).
    host: Option<String>,
    /// Host substring (case-insensitive).
    host_contains: Option<String>,
    /// URL path substring (case-sensitive).
    path_contains: Option<String>,
    /// Query parameters with exact, case-sensitive, non-sensitive values.
    #[serde(default)]
    query_params: std::collections::BTreeMap<String, String>,
    /// Exact HTTP method (case-insensitive).
    method: Option<String>,
    /// Inclusive minimum HTTP status.
    status_min: Option<u16>,
    /// Inclusive maximum HTTP status.
    status_max: Option<u16>,
    /// Exact scheme, protocol, or HTTP version (case-insensitive).
    protocol: Option<String>,
    /// Response MIME substring (case-insensitive).
    mime: Option<String>,
    /// Inclusive RFC 3339 lower bound; use instead of since.
    started_after: Option<String>,
    /// Inclusive RFC 3339 upper bound.
    started_before: Option<String>,
    /// Relative lookback such as 10m. Defaults to 10m when no time bounds are supplied.
    since: Option<String>,
    /// Inclusive minimum request duration in milliseconds.
    min_duration_ms: Option<u64>,
    /// Inclusive maximum request duration in milliseconds.
    max_duration_ms: Option<u64>,
    /// Return only sessions with a recorded failure.
    #[serde(default)]
    failed_only: bool,
    /// Exact failure kind.
    failure_kind: Option<String>,
    /// Exact failure origin.
    failure_origin: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
pub enum FieldSearchTarget {
    Key {
        /// Exact case-sensitive property name to discover at any depth.
        key: String,
    },
    Path {
        /// JSONPath starting with $, supporting property, index and array wildcard selectors.
        #[serde(rename = "jsonPath")]
        json_path: String,
    },
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "operator", rename_all = "camelCase", deny_unknown_fields)]
pub enum FieldSearchCondition {
    Exists,
    Equals {
        /// A JSON number, string, boolean, or explicit null.
        value: Value,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchSessionFieldsRequest {
    /// Metadata filters from search_sessions, with a 10-minute default lookback.
    #[serde(default)]
    filter: FieldSearchFilter,
    /// The captured request or response body to scan.
    part: BodyPart,
    /// Exactly one of key or jsonPath.
    target: FieldSearchTarget,
    /// Use exists or typed scalar equals. Redacted values cannot match.
    condition: FieldSearchCondition,
    /// Maximum matching sessions per page, 1-100. Defaults to 20.
    #[schemars(range(min = 1, max = 100))]
    limit: Option<usize>,
    /// The opaque meta.nextCursor from the same field search.
    cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct FieldSearchCursor {
    watermark: String,
    started_after: Option<String>,
    started_before: String,
    before_sequence: i64,
}

impl FieldSearchCursor {
    fn encode(&self, query: &[u8], redactor: &Redactor) -> String {
        let payload = serde_json::to_vec(self).expect("cursor fields are serializable");
        let tag = redactor
            .field_search_cursor_mac(&payload, query)
            .finalize()
            .into_bytes();
        format!(
            "{CURSOR_VERSION}.{}.{}",
            URL_SAFE_NO_PAD.encode(payload),
            URL_SAFE_NO_PAD.encode(tag)
        )
    }

    fn decode(token: &str, query: &[u8], redactor: &Redactor) -> Result<Self, ToolError> {
        let invalid = || {
            ToolError::new(
            "CURSOR_INVALID",
            "Use meta.nextCursor from this field search with the same filter, part, target, and condition.",
        )
        };
        if token.len() > 1024 {
            return Err(invalid());
        }
        let (payload, tag) = token
            .strip_prefix(CURSOR_VERSION)
            .and_then(|tail| tail.strip_prefix('.'))
            .and_then(|tail| tail.split_once('.'))
            .ok_or_else(invalid)?;
        let payload = URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?;
        let tag = URL_SAFE_NO_PAD.decode(tag).map_err(|_| invalid())?;
        redactor
            .field_search_cursor_mac(&payload, query)
            .verify_slice(&tag)
            .map_err(|_| invalid())?;
        serde_json::from_slice(&payload).map_err(|_| invalid())
    }
}

pub async fn search_session_fields(
    state: &AppContext,
    mut request: SearchSessionFieldsRequest,
    caller: ControlCaller<'_>,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled. Enable readSessions in AIProxy Settings > Agent Access.",
        ));
    }
    require_session_details(state)?;
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;

    let (target, target_key) = match request.target {
        FieldSearchTarget::Key { key } => {
            validate_target_length(&key)?;
            (FieldTarget::Key(key.clone()), json!({ "key": key }))
        }
        FieldSearchTarget::Path { json_path } => {
            validate_target_length(&json_path)?;
            let mut parsed = parse_json_paths(&[json_path])?;
            let path = parsed.pop().expect("one JSONPath was provided");
            let canonical = render_json_path(&path);
            (FieldTarget::Path(path), json!({ "jsonPath": canonical }))
        }
    };
    let lookback = request.filter.normalize(&redactor)?;
    // Bind the normalized query without including its raw inputs in the cursor.
    let query = json!([request.filter, request.part, target_key, request.condition])
        .to_string()
        .into_bytes();
    let condition = match request.condition {
        FieldSearchCondition::Exists => FieldCondition::Exists,
        FieldSearchCondition::Equals { value } => {
            if value.is_array()
                || value.is_object()
                || value
                    .as_str()
                    .is_some_and(|text| text.len() > MAX_SEARCH_STRING_BYTES)
            {
                return Err(ToolError::invalid(
                    "equals requires a JSON scalar no larger than 64 KiB.",
                ));
            }
            FieldCondition::Equals(value)
        }
    };
    let prior = request
        .cursor
        .as_deref()
        .map(|token| FieldSearchCursor::decode(token, &query, &redactor))
        .transpose()?;
    let before_sequence = prior.as_ref().map(|cursor| cursor.before_sequence);
    let now = Utc::now();
    let mut bounds = match prior {
        Some(cursor) => cursor,
        None => FieldSearchCursor {
            watermark: String::new(),
            started_after: lookback
                .map(|duration| timestamp(now - duration))
                .or_else(|| request.filter.started_after.clone()),
            started_before: request
                .filter
                .started_before
                .clone()
                .unwrap_or_else(|| timestamp(now)),
            before_sequence: 0,
        },
    };
    let mut filter = SessionSearchFilter::from(request.filter);
    filter.started_after.clone_from(&bounds.started_after);
    filter.started_before = Some(bounds.started_before.clone());

    let (snapshot, page) = state
        .with_db(move |connection| {
            let tx = connection
                .unchecked_transaction()
                .map_err(|error| DbError::query("begin field search snapshot", error))?;
            let Some(latest) = read_completion_watermark(&tx)? else {
                return Ok(None);
            };
            let snapshot = if bounds.watermark.is_empty() {
                latest
            } else {
                CompletionCursor::parse(&bounds.watermark)?.resolve(&latest)?
            };
            let page = search_completion_snapshot(
                &tx,
                &filter,
                MAX_CANDIDATES,
                snapshot.sequence(),
                before_sequence,
            )?;
            Ok(Some((snapshot, page)))
        })
        .await?
        .ok_or_else(|| {
            ToolError::new(
                "SCHEMA_INCOMPATIBLE",
                "Open the current AIProxy desktop app to upgrade session completion storage.",
            )
        })?;
    bounds.watermark = snapshot.encode();

    // The temporary read grant covers only the concrete candidates on this page.
    let session_ids = page
        .items
        .iter()
        .map(|row| row.summary.id.clone())
        .collect::<Vec<_>>();
    let config = state
        .ensure_capability(
            AgentCapability::ReadBodies,
            format!("Search JSON fields in {} session bodies", session_ids.len()),
            AgentGrantScope {
                session_ids,
                ..Default::default()
            },
            "Field search reads captured bodies and returns only visible matching fields."
                .to_string(),
            caller,
        )
        .await?;
    let part = request.part;
    let limit = request
        .limit
        .unwrap_or(20)
        .clamp(1, MAX_SESSION_SEARCH_LIMIT)
        .min(config.limits.max_sessions);
    let store = state.body_store.clone();
    let response_budget = config.limits.max_response_bytes;
    state
        .with_db(move |connection| {
            let (data, mut meta) = scan_page(
                page,
                |id, remaining| {
                    let reference = load_body_reference(connection, id, part)?;
                    Ok(reference
                        .as_ref()
                        .map_or(BodyOutcome::Unavailable, |reference| {
                            scan_body(&store, reference, remaining, &target, &condition, &redactor)
                        }))
                },
                limit,
                MAX_BATCH_JSON_SCAN_BYTES,
                response_budget,
            )?;
            if let Some(sequence) = data.resume_after {
                bounds.before_sequence = sequence;
                meta.next_cursor = Some(bounds.encode(&query, &redactor));
            }
            Ok((data.payload, meta))
        })
        .await
}

fn validate_target_length(target: &str) -> Result<(), ToolError> {
    if target.len() > MAX_TARGET_BYTES {
        return Err(ToolError::invalid(
            "The field target is limited to 1024 bytes.",
        ));
    }
    Ok(())
}

fn timestamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

impl FieldSearchFilter {
    fn normalize(&mut self, redactor: &Redactor) -> Result<Option<chrono::Duration>, ToolError> {
        for value in [
            &mut self.host,
            &mut self.host_contains,
            &mut self.protocol,
            &mut self.mime,
        ] {
            *value = normalize_text(value.take()).map(|text| text.to_lowercase());
        }
        self.method = normalize_text(self.method.take()).map(|text| text.to_uppercase());
        for value in [
            &mut self.path_contains,
            &mut self.failure_kind,
            &mut self.failure_origin,
        ] {
            *value = normalize_text(value.take());
        }
        let mut parameters = std::collections::BTreeMap::new();
        for (key, value) in std::mem::take(&mut self.query_params) {
            let key = key.trim();
            if key.is_empty()
                || redactor.is_sensitive_name(key)
                || !redactor.redact_text(key).records.is_empty()
                || !redactor.redact_text(&value).records.is_empty()
                || parameters.insert(key.to_string(), value).is_some()
            {
                return Err(ToolError::invalid(
                    "queryParams requires unique, non-sensitive parameter names and values.",
                ));
            }
        }
        self.query_params = parameters;

        self.started_after = normalize_time(self.started_after.as_deref())?;
        self.started_before = normalize_time(self.started_before.as_deref())?;
        if self.since.is_some() && self.started_after.is_some() {
            return Err(ToolError::invalid(
                "Use either since or startedAfter, not both.",
            ));
        }
        let lookback = if self.started_after.is_none() && self.started_before.is_none() {
            self.since.as_deref().or(Some(DEFAULT_LOOKBACK))
        } else {
            self.since.as_deref()
        }
        .map(parse_since_duration)
        .transpose()?;
        self.since = lookback.map(|duration| format!("{}s", duration.num_seconds()));
        Ok(lookback)
    }
}

fn normalize_time(value: Option<&str>) -> Result<Option<String>, ToolError> {
    value
        .map(|value| {
            DateTime::parse_from_rfc3339(value.trim())
                .map(|time| timestamp(time.with_timezone(&Utc)))
                .map_err(|_| {
                    ToolError::invalid(
                        "startedAfter and startedBefore must use RFC 3339 timestamps.",
                    )
                })
        })
        .transpose()
}

fn normalize_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

impl From<FieldSearchFilter> for SessionSearchFilter {
    fn from(filter: FieldSearchFilter) -> Self {
        Self {
            host: filter.host,
            host_contains: filter.host_contains,
            path_contains: filter.path_contains,
            query_params: filter.query_params.into_iter().collect(),
            method: filter.method,
            status_min: filter.status_min,
            status_max: filter.status_max,
            protocol: filter.protocol,
            mime: filter.mime,
            min_duration_ms: filter.min_duration_ms,
            max_duration_ms: filter.max_duration_ms,
            failed_only: filter.failed_only,
            failure_kind: filter.failure_kind,
            failure_origin: filter.failure_origin,
            ..Default::default()
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Skipped {
    body_unavailable: usize,
    non_json: usize,
    capture_truncated: usize,
    body_too_large: usize,
    depth_limit: usize,
    redacted: usize,
}

enum BodyOutcome {
    Unavailable,
    CaptureTruncated,
    TooLarge,
    Deferred,
    Scanned(Result<JsonMatches, serde_json::Error>, u64),
}

fn scan_body(
    store: &BodyStore,
    reference: &StoredBodyReference,
    remaining: u64,
    target: &FieldTarget,
    condition: &FieldCondition,
    redactor: &Redactor,
) -> BodyOutcome {
    if reference.truncated {
        return BodyOutcome::CaptureTruncated;
    }
    if let Some(path) = &reference.file_path {
        let Ok(file) = store.open_body_reader(path) else {
            return BodyOutcome::Unavailable;
        };
        let Ok(metadata) = file.get_ref().metadata() else {
            return BodyOutcome::Unavailable;
        };
        let size = metadata.len();
        if let Some(outcome) = check_body_budget(size, remaining) {
            return outcome;
        }
        let mut reader = file.take(size);
        let result = scan_json(&mut reader, target, condition, redactor);
        return BodyOutcome::Scanned(result, size - reader.limit());
    }

    let declared_size = if let Some(text) = &reference.base64_text {
        let padding = text
            .as_bytes()
            .iter()
            .rev()
            .take(2)
            .take_while(|byte| **byte == b'=')
            .count();
        (text.len() / 4 * 3).saturating_sub(padding)
    } else {
        reference.inline_text.as_ref().map_or(0, String::len)
    } as u64;
    if let Some(outcome) = check_body_budget(declared_size, remaining) {
        return outcome;
    }
    let Ok(bytes) = decode_inline_reference(reference) else {
        return BodyOutcome::Unavailable;
    };
    let size = bytes.len() as u64;
    if let Some(outcome) = check_body_budget(size, remaining) {
        return outcome;
    }
    BodyOutcome::Scanned(
        scan_json(Cursor::new(bytes), target, condition, redactor),
        size,
    )
}

fn check_body_budget(size: u64, remaining: u64) -> Option<BodyOutcome> {
    if size > MAX_JSON_PATH_SCAN_BYTES as u64 {
        Some(BodyOutcome::TooLarge)
    } else if size > remaining {
        Some(BodyOutcome::Deferred)
    } else {
        None
    }
}

struct ScannedPage {
    payload: Value,
    resume_after: Option<i64>,
}

fn scan_page(
    page: CompletedSessionPage,
    mut scan: impl FnMut(&str, u64) -> Result<BodyOutcome, DbError>,
    limit: usize,
    byte_budget: u64,
    response_budget: usize,
) -> Result<(ScannedPage, ToolMeta), DbError> {
    let candidate_count = page.items.len();
    let mut items = Vec::new();
    let mut skipped = Skipped::default();
    let mut scanned_bytes = 0;
    let mut scanned_sessions = 0;
    let mut processed = 0;
    let mut last_processed = None;
    let mut stop_reason = None;
    let mut matches_limited = false;
    let mut item_bytes = 0;
    // Reserve space for the fixed scan information around the items.
    let items_budget = response_budget.saturating_sub(1024);
    for row in page.items {
        if items.len() == limit {
            stop_reason = Some("resultLimit");
            break;
        }
        let remaining = byte_budget - scanned_bytes;
        let outcome = scan(&row.summary.id, remaining)?;
        match outcome {
            BodyOutcome::Unavailable => skipped.body_unavailable += 1,
            BodyOutcome::CaptureTruncated => skipped.capture_truncated += 1,
            BodyOutcome::TooLarge => skipped.body_too_large += 1,
            BodyOutcome::Deferred => {
                stop_reason = Some("byteBudget");
                break;
            }
            BodyOutcome::Scanned(result, bytes) => {
                scanned_sessions += 1;
                scanned_bytes += bytes;
                match result {
                    Err(error) if error.is_io() => skipped.body_unavailable += 1,
                    Err(error) if error.to_string().starts_with("recursion limit exceeded") => {
                        skipped.depth_limit += 1
                    }
                    Err(_) => skipped.non_json += 1,
                    Ok(matches) => {
                        let mut limited = matches.limited;
                        if !matches.items.is_empty() {
                            let mut item = json!({
                                "sessionId": row.summary.id,
                                "statusCode": row.summary.status_code,
                                "startedAt": row.summary.started_at,
                                "finishedAt": row.summary.finished_at,
                                "matches": matches.items,
                                "matchesTruncated": matches.limited,
                            });
                            let bytes = item.to_string().len() + 1;
                            if !items.is_empty() && item_bytes + bytes > items_budget {
                                stop_reason = Some("responseBudget");
                                break;
                            }
                            // A single session can always advance the cursor; trim excess
                            // matches when the app's response budget is especially small.
                            if bytes > items_budget {
                                let mut bytes = bytes;
                                item["matchesTruncated"] = json!(true);
                                limited = true;
                                let matches =
                                    item["matches"].as_array_mut().expect("matches is an array");
                                while bytes > items_budget && matches.len() > 1 {
                                    bytes -=
                                        matches.pop().expect("there is a match").to_string().len()
                                            + 1;
                                }
                            }
                            item_bytes += item.to_string().len() + 1;
                            items.push(item);
                        }
                        skipped.redacted += usize::from(matches.redacted);
                        matches_limited |= limited;
                    }
                }
            }
        }
        processed += 1;
        last_processed = Some(row.sequence);
    }
    if stop_reason.is_none() && page.has_more {
        stop_reason = Some("candidateBudget");
    }
    let has_more = page.has_more || processed < candidate_count;
    let status = if has_more {
        "partial"
    } else if processed == 0 {
        "noCandidates"
    } else if items.is_empty() {
        "noMatch"
    } else {
        "matched"
    };
    let mut meta = ToolMeta::new(has_more || matches_limited, true, None);
    if let Some(reason) = stop_reason.or(matches_limited.then_some("matchLimit")) {
        meta = meta.with_truncated_reason(reason);
    }
    Ok((
        ScannedPage {
            payload: json!({
                "items": items,
                "scan": {
                    "status": status,
                    "hasMore": has_more,
                    "stopReason": stop_reason,
                    "processedSessions": processed,
                    "scannedSessions": scanned_sessions,
                    "scannedBytes": scanned_bytes,
                    "skipped": skipped,
                    "candidateLimit": MAX_CANDIDATES,
                    "bodyLimitBytes": MAX_JSON_PATH_SCAN_BYTES,
                    "byteBudget": byte_budget,
                    "matchesPerSessionLimit": MAX_MATCHES_PER_SESSION,
                },
            }),
            resume_after: has_more.then_some(last_processed).flatten(),
        },
        meta,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiproxy_db::rusqlite::Connection;
    use tempfile::tempdir;

    #[test]
    fn a_body_that_does_not_fit_the_remaining_budget_is_resumed_unscanned() {
        let directory = tempdir().unwrap();
        let store = BodyStore::new(directory.path().into());
        store.ensure_dir().unwrap();
        let redactor = Redactor::from_config(&Default::default(), directory.path()).unwrap();
        let target = FieldTarget::Key("flag".to_owned());
        let condition = FieldCondition::Exists;
        let writer = Connection::open_in_memory().unwrap();
        aiproxy_db::schema::run_migrations(&writer).unwrap();
        for id in ["1", "2"] {
            writer
                .execute(
                    "INSERT INTO session_summaries
                   (id, method, host, path, protocol, started_at, finished_at, status_code, url)
                 VALUES (?1, 'GET', 'example.test', '/', 'https', '2026-01-01T00:00:00Z',
                         '2026-01-01T00:00:01Z', 200, 'https://example.test/')",
                    [id],
                )
                .unwrap();
        }
        let read_page = |before_sequence| {
            search_completion_snapshot(
                &writer,
                &SessionSearchFilter::default(),
                20,
                2,
                before_sequence,
            )
            .unwrap()
        };
        let make_reference = |value: &str| StoredBodyReference {
            file_path: None,
            inline_text: Some(value.to_owned()),
            base64_text: None,
            mime_type: Some("application/json".to_owned()),
            encoding: None,
            size_bytes: 1,
            truncated: false,
        };
        let first = r#"{"flag":true}"#;
        let second = r#"{"flag":false}"#;
        let scan = |id: &str, remaining| {
            let reference = make_reference(if id == "2" { first } else { second });
            Ok(scan_body(
                &store, &reference, remaining, &target, &condition, &redactor,
            ))
        };
        let budget = 16;
        let (page, _) = scan_page(read_page(None), scan, 20, budget, 10000).unwrap();
        assert_eq!(page.resume_after, Some(2));
        assert_eq!(page.payload["scan"]["scannedBytes"], first.len());
        assert_eq!(page.payload["scan"]["scannedSessions"], 1);
        assert_eq!(page.payload["scan"]["stopReason"], "byteBudget");
        assert_eq!(page.payload["items"][0]["sessionId"], "2");

        let (page, _) = scan_page(read_page(page.resume_after), scan, 20, budget, 10000).unwrap();
        assert_eq!(page.payload["items"][0]["sessionId"], "1");
        assert_eq!(page.payload["scan"]["scannedBytes"], second.len());
        assert_eq!(page.resume_after, None);
    }
}
