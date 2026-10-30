use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration as StdDuration, Instant};

use aiproxy_db::rusqlite::OptionalExtension;
use aiproxy_db::session_search::{
    latest_completed_session_rowid, search_sessions as db_search_sessions, SessionSearchField,
    SessionSearchFilter, SessionSortField, SortOrder, MAX_SESSION_SEARCH_LIMIT,
};
use aiproxy_db::sessions::{load_session_detail, load_session_summary, SessionSummaryRow};
use chrono::{Duration, SecondsFormat, Utc};
use rmcp::model::{ProgressNotificationParam, ProgressToken};
use rmcp::service::Peer;
use rmcp::RoleServer;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::{HeaderEntry, RedactionOutput, Redactor};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SearchField {
    /// Search the full URL, including scheme, host, path, and query.
    #[default]
    Url,
    /// Search the host name only.
    Host,
    /// Search the URL path only.
    Path,
    /// Search the HTTP method only.
    Method,
    /// Search raw request and response header JSON.
    Headers,
    /// Search persisted query parameter JSON.
    Query,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionSortBy {
    /// Sort by session start time. This is the default.
    #[default]
    StartedAt,
    /// Sort by total duration in milliseconds.
    DurationMs,
    /// Sort by captured response size in bytes.
    SizeBytes,
    /// Sort by HTTP status code.
    StatusCode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionSortDirection {
    /// Newest, largest, or highest first. This is the default.
    #[default]
    Desc,
    /// Oldest, smallest, or lowest first.
    Asc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SummaryField {
    /// Stable session identifier.
    SessionId,
    /// HTTP method.
    Method,
    /// Request host without scheme.
    Host,
    /// URL path without query parameters.
    Path,
    /// Captured protocol label, for example HTTP/2.
    Protocol,
    /// URL scheme, for example https.
    Scheme,
    /// HTTP version string, for example 2.
    HttpVersion,
    /// RFC 3339 capture start timestamp.
    StartedAt,
    /// RFC 3339 capture finish timestamp.
    FinishedAt,
    /// Total duration in milliseconds.
    DurationMs,
    /// Captured response size in bytes.
    SizeBytes,
    /// HTTP status code; 0 means no response was captured.
    StatusCode,
    /// Full request URL. Redacted unless raw mode is authorized.
    Url,
    /// Response MIME type when captured.
    ResponseMimeType,
    /// Application protocol label, for example http or websocket.
    ApplicationProtocol,
    /// Transport protocol label, for example tcp.
    TransportProtocol,
    /// Structured failure metadata, omitted when the session succeeded.
    Failure,
}

impl SummaryField {
    fn key(self) -> &'static str {
        match self {
            Self::SessionId => "sessionId",
            Self::Method => "method",
            Self::Host => "host",
            Self::Path => "path",
            Self::Protocol => "protocol",
            Self::Scheme => "scheme",
            Self::HttpVersion => "httpVersion",
            Self::StartedAt => "startedAt",
            Self::FinishedAt => "finishedAt",
            Self::DurationMs => "durationMs",
            Self::SizeBytes => "sizeBytes",
            Self::StatusCode => "statusCode",
            Self::Url => "url",
            Self::ResponseMimeType => "responseMimeType",
            Self::ApplicationProtocol => "applicationProtocol",
            Self::TransportProtocol => "transportProtocol",
            Self::Failure => "failure",
        }
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SearchSessionsRequest {
    /// Exact host match, case-insensitive. Do not include a scheme or path.
    pub host: Option<String>,
    /// Case-insensitive host substring match.
    pub host_contains: Option<String>,
    /// Case-sensitive URL path substring match.
    pub path_contains: Option<String>,
    /// Query parameters that must all exist with these exact, case-sensitive values.
    #[serde(default)]
    pub query_params: BTreeMap<String, String>,
    /// Exact HTTP method match, case-insensitive, for example GET or POST.
    pub method: Option<String>,
    /// Inclusive minimum HTTP status code (0-65535).
    pub status_min: Option<u16>,
    /// Inclusive maximum HTTP status code (0-65535).
    pub status_max: Option<u16>,
    /// Exact protocol match across scheme, protocol, and HTTP version, case-insensitive.
    pub protocol: Option<String>,
    /// Case-insensitive response MIME substring; "json" matches "application/json".
    pub mime: Option<String>,
    /// Inclusive RFC 3339 UTC lower bound on startedAt.
    pub started_after: Option<String>,
    /// Inclusive RFC 3339 UTC upper bound on startedAt.
    pub started_before: Option<String>,
    /// Relative lookback such as 30m, 2h, or 7d. Use instead of startedAfter.
    pub since: Option<String>,
    /// Inclusive minimum duration in milliseconds.
    pub min_duration_ms: Option<u64>,
    /// Inclusive maximum duration in milliseconds.
    pub max_duration_ms: Option<u64>,
    /// Return only sessions with a recorded failure.
    #[serde(default)]
    pub failed_only: bool,
    /// Exact failure kind, for example connect_refused or upstream_timeout.
    pub failure_kind: Option<String>,
    /// Exact failure origin: client, proxy, or upstream.
    pub failure_origin: Option<String>,
    /// Case-insensitive substring searched in searchIn fields; defaults to url, host, path, and method.
    pub keyword: Option<String>,
    /// Fields searched by keyword. Empty uses url, host, path, and method.
    #[serde(default)]
    pub search_in: Vec<SearchField>,
    /// Sort field. Default startedAt.
    #[serde(default)]
    pub sort_by: SessionSortBy,
    /// Sort direction. Default desc.
    #[serde(default)]
    pub sort_order: SessionSortDirection,
    /// Return only sessionId, method, host, path, statusCode, durationMs, sizeBytes, and startedAt.
    #[serde(default)]
    pub compact: bool,
    /// Explicit summary field projection. Takes precedence over compact.
    #[serde(default)]
    pub fields: Vec<SummaryField>,
    /// Page size, 1-100; default 20 and further capped by Agent Access maxSessions.
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<usize>,
    /// Opaque nextCursor returned by a previous call with the same sort settings.
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionInclude {
    /// Session summary fields.
    Summary,
    /// Request and response headers.
    Headers,
    /// Persisted query parameters.
    Query,
    /// Persisted cookies.
    Cookies,
    /// Timing breakdown.
    Timing,
    /// TLS protocol, cipher, addresses, and upstream-proxy status.
    Tls,
    /// HTTP/2 stream id and trailers.
    Http2,
    /// Rewrite, script, map, and throttle rule traces.
    RuleTraces,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetSessionRequest {
    /// Exact session id or a unique prefix of at least 8 characters.
    pub session_id: String,
    /// Sections to include. Empty includes only summary. Bodies are never included.
    #[serde(default)]
    pub include: Vec<SessionInclude>,
    /// redactedText redacts sensitive values; raw requires readRawBodies.
    #[serde(default)]
    pub redaction_mode: RedactionMode,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WaitForSessionsRequest {
    /// Exact host match, case-insensitive. Do not include a scheme or path.
    pub host: Option<String>,
    /// Case-insensitive host substring match.
    pub host_contains: Option<String>,
    /// Case-sensitive URL path substring match.
    pub path_contains: Option<String>,
    /// Query parameters that must all exist with these exact, case-sensitive values.
    #[serde(default)]
    pub query_params: BTreeMap<String, String>,
    /// Exact HTTP method match, case-insensitive.
    pub method: Option<String>,
    /// Inclusive minimum HTTP status code.
    pub status_min: Option<u16>,
    /// Inclusive maximum HTTP status code.
    pub status_max: Option<u16>,
    /// Case-insensitive response MIME substring; "json" matches "application/json".
    pub mime: Option<String>,
    /// Case-insensitive substring searched in url, host, path, and method.
    pub keyword: Option<String>,
    /// Return only sessions with a recorded failure.
    #[serde(default)]
    pub failed_only: bool,
    /// Exact failure kind, for example client_tls_rejected.
    pub failure_kind: Option<String>,
    /// Exact failure origin: client, proxy, or upstream.
    pub failure_origin: Option<String>,
    /// Watermark returned by search_sessions or a previous wait_for_sessions call.
    /// Omit to start from the latest completed session at call time.
    pub after_watermark: Option<String>,
    /// Minimum number of matching completed sessions before returning, 1-100.
    #[schemars(range(min = 1, max = 100))]
    pub min_count: Option<usize>,
    /// Maximum wait in milliseconds, 1000-30000; default 15000.
    #[schemars(range(min = 1000, max = 30000))]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone)]
pub struct WaitNotifier {
    peer: Peer<RoleServer>,
    token: ProgressToken,
}

impl WaitNotifier {
    pub fn from_context(context: &rmcp::service::RequestContext<RoleServer>) -> Option<Self> {
        context.meta.get_progress_token().map(|token| Self {
            peer: context.peer.clone(),
            token,
        })
    }

    async fn notify(&self, found: usize, requested: usize) {
        let _ = self
            .peer
            .notify_progress(
                ProgressNotificationParam::new(self.token.clone(), found as f64)
                    .with_total(requested as f64)
                    .with_message(format!(
                        "Waiting for completed sessions ({found}/{requested})"
                    )),
            )
            .await;
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RedactionMode {
    /// Replace configured and detected sensitive values. This is the default.
    #[default]
    RedactedText,
    /// Return stored values unchanged. Requires readRawBodies.
    Raw,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionIdLookup {
    Found(String),
    NotFound,
    Ambiguous(Vec<String>),
}

pub(crate) fn lookup_session_id(
    connection: &aiproxy_db::rusqlite::Connection,
    requested: &str,
) -> Result<SessionIdLookup, aiproxy_db::DbError> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Ok(SessionIdLookup::NotFound);
    }

    let exact = connection
        .query_row(
            "SELECT id FROM session_summaries WHERE id = ?1 LIMIT 1",
            [requested],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| aiproxy_db::DbError::query("resolve exact session id", error))?;
    if let Some(id) = exact {
        return Ok(SessionIdLookup::Found(id));
    }

    if requested.len() < 8 {
        return Ok(SessionIdLookup::NotFound);
    }

    let prefix = format!("{}%", escape_like_pattern(requested));
    let mut statement = connection
        .prepare(
            "SELECT id FROM session_summaries
             WHERE id LIKE ?1 ESCAPE '\\'
             ORDER BY started_at DESC, id DESC
             LIMIT 6",
        )
        .map_err(|error| aiproxy_db::DbError::query("prepare session id prefix lookup", error))?;
    let rows = statement
        .query_map([prefix], |row| row.get::<_, String>(0))
        .map_err(|error| aiproxy_db::DbError::query("query session id prefix", error))?;
    let mut candidates = rows
        .map(|row| {
            row.map_err(|error| aiproxy_db::DbError::query("decode session id prefix", error))
        })
        .collect::<Result<Vec<_>, _>>()?;

    match candidates.len() {
        0 => Ok(SessionIdLookup::NotFound),
        1 => Ok(SessionIdLookup::Found(candidates.remove(0))),
        _ => {
            candidates.truncate(5);
            Ok(SessionIdLookup::Ambiguous(candidates))
        }
    }
}

pub(crate) async fn require_session_id(
    state: &AppContext,
    requested: &str,
) -> Result<String, ToolError> {
    let requested_owned = requested.trim().to_string();
    let lookup = state
        .with_db(move |connection| lookup_session_id(connection, &requested_owned))
        .await?;
    match lookup {
        SessionIdLookup::Found(id) => Ok(id),
        SessionIdLookup::NotFound => Err(ToolError::new(
            "SESSION_NOT_FOUND",
            format!("Session not found: {}", requested.trim()),
        )),
        SessionIdLookup::Ambiguous(candidates) => Err(ToolError::new(
            "SESSION_ID_AMBIGUOUS",
            "The sessionId prefix matches more than one session.",
        )
        .with_details(json!({
            "requested": requested.trim(),
            "candidates": candidates,
        }))),
    }
}

pub async fn search(
    state: &AppContext,
    request: SearchSessionsRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled. Enable readSessions in AIProxy Settings > Agent Access.",
        ));
    }
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;

    if request.since.is_some() && request.started_after.is_some() {
        return Err(ToolError::invalid(
            "Use either since or startedAfter, not both.",
        ));
    }
    let started_after = match request.since.as_deref() {
        Some(value) => Some(parse_since(value)?),
        None => request.started_after,
    };

    let filter = SessionSearchFilter {
        host: request.host,
        host_contains: request.host_contains,
        path_contains: request.path_contains,
        query_params: request.query_params.into_iter().collect(),
        method: request.method,
        status_min: request.status_min,
        status_max: request.status_max,
        protocol: request.protocol,
        mime: request.mime,
        started_after,
        started_before: request.started_before,
        min_duration_ms: request.min_duration_ms,
        max_duration_ms: request.max_duration_ms,
        keyword: request.keyword,
        search_in: request
            .search_in
            .into_iter()
            .map(SessionSearchField::from)
            .collect(),
        sort_by: request.sort_by.into(),
        sort_order: request.sort_order.into(),
        after_rowid: None,
        completed_only: false,
        failed_only: request.failed_only,
        failure_kind: request.failure_kind,
        failure_origin: request.failure_origin,
    };
    let compact = request.compact;
    let fields = request.fields;
    let limit = request
        .limit
        .unwrap_or(20)
        .clamp(1, MAX_SESSION_SEARCH_LIMIT)
        .min(config.limits.max_sessions);
    let cursor = request.cursor;
    let (page, watermark) = state
        .with_db(move |connection| {
            let page = db_search_sessions(connection, &filter, limit, cursor.as_deref())?;
            let watermark = latest_completed_session_rowid(connection)?;
            Ok((page, watermark))
        })
        .await?;
    let items = page
        .items
        .iter()
        .map(|summary| summary_to_json(summary, &redactor, false, compact, &fields))
        .collect::<Vec<Value>>();
    let meta = ToolMeta::new(page.truncated, true, page.next_cursor)
        .with_watermark(encode_watermark(watermark));
    Ok((json!({ "items": items }), meta))
}

/// Long-poll persisted sessions until the requested number of completed
/// matches appears or the bounded timeout expires. This intentionally uses
/// SQLite polling instead of pretending to provide a real-time stream.
pub async fn wait_for_sessions(
    state: &AppContext,
    request: WaitForSessionsRequest,
    notifier: Option<WaitNotifier>,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled. Enable readSessions in AIProxy Settings > Agent Access.",
        ));
    }
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;
    let min_count = request.min_count.unwrap_or(1);
    if !(1..=100).contains(&min_count) {
        return Err(ToolError::invalid("minCount must be between 1 and 100."));
    }
    if min_count > config.limits.max_sessions {
        return Err(ToolError::invalid(format!(
            "minCount cannot exceed the configured maxSessions limit ({}).",
            config.limits.max_sessions
        )));
    }
    let timeout_ms = request.timeout_ms.unwrap_or(15_000);
    if !(1_000..=30_000).contains(&timeout_ms) {
        return Err(ToolError::invalid(
            "timeoutMs must be between 1000 and 30000.",
        ));
    }

    let initial_watermark = match request.after_watermark.as_deref() {
        Some(value) => parse_watermark(value)?,
        None => state.with_db(latest_completed_session_rowid).await?,
    };
    let filter = SessionSearchFilter {
        host: request.host,
        host_contains: request.host_contains,
        path_contains: request.path_contains,
        query_params: request.query_params.into_iter().collect(),
        method: request.method,
        status_min: request.status_min,
        status_max: request.status_max,
        mime: request.mime,
        keyword: request.keyword,
        after_rowid: Some(initial_watermark),
        completed_only: true,
        failed_only: request.failed_only,
        failure_kind: request.failure_kind,
        failure_origin: request.failure_origin,
        ..SessionSearchFilter::default()
    };
    let limit = min_count.min(config.limits.max_sessions).clamp(1, 100);
    let started = Instant::now();
    let deadline = StdDuration::from_millis(timeout_ms);
    let capture = state.freshness();
    let mut notes = Vec::new();
    if capture.capture_status != "running" {
        notes.push("Capture is not running, so no new traffic may arrive.".to_string());
    }

    loop {
        let filter_for_query = filter.clone();
        let page = state
            .with_db(move |connection| {
                db_search_sessions(connection, &filter_for_query, limit, None)
            })
            .await?;
        let watermark = state.with_db(latest_completed_session_rowid).await?;
        let satisfied = page.items.len() >= min_count;
        if satisfied || started.elapsed() >= deadline {
            let items = page
                .items
                .iter()
                .map(|summary| summary_to_json(summary, &redactor, false, true, &[]))
                .collect::<Vec<_>>();
            let data = json!({
                "satisfied": satisfied,
                "timedOut": !satisfied,
                "items": items,
                "watermark": encode_watermark(watermark),
                "notes": notes,
            });
            let mut meta =
                ToolMeta::new(false, true, None).with_watermark(encode_watermark(watermark));
            if !satisfied {
                meta = meta.with_truncated_reason(format!(
                    "wait_for_sessions timed out after {timeout_ms}ms with {} of {} required matches",
                    page.items.len(),
                    min_count
                ));
            }
            return Ok((data, meta));
        }
        if let Some(notifier) = &notifier {
            notifier.notify(page.items.len(), min_count).await;
        }
        tokio::time::sleep(StdDuration::from_millis(300)).await;
    }
}

pub(crate) fn encode_watermark(rowid: i64) -> String {
    format!("w1:{}", rowid.max(0))
}

pub(crate) fn parse_watermark(value: &str) -> Result<i64, ToolError> {
    let value = value.trim();
    let Some(rowid) = value.strip_prefix("w1:") else {
        return Err(ToolError::invalid(
            "afterWatermark must be a watermark returned by an AIProxy tool (format w1:<rowid>).",
        ));
    };
    let rowid = rowid
        .parse::<i64>()
        .map_err(|_| ToolError::invalid("afterWatermark contains an invalid rowid."))?;
    if rowid < 0 {
        return Err(ToolError::invalid(
            "afterWatermark must not contain a negative rowid.",
        ));
    }
    Ok(rowid)
}

pub async fn get_session(
    state: &AppContext,
    request: GetSessionRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled. Enable readSessions in AIProxy Settings > Agent Access.",
        ));
    }
    if request.redaction_mode == RedactionMode::Raw && !config.permissions.read_raw_bodies {
        return Err(ToolError::permission_denied(
            "Raw session metadata requires the readRawBodies permission. Enable it in AIProxy Settings > Agent Access.",
        ));
    }
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;
    let session_id = require_session_id(state, &request.session_id).await?;

    let include = if request.include.is_empty() {
        vec![SessionInclude::Summary]
    } else {
        request.include
    };
    let needs_details = include
        .iter()
        .any(|item| !matches!(item, SessionInclude::Summary));
    let details_available = state
        .capabilities
        .is_some_and(|capabilities| capabilities.session_details);
    if needs_details && !details_available {
        return Err(ToolError::new(
            "SCHEMA_INCOMPATIBLE",
            "Session details are unavailable until AIProxy migrates the database. Open AIProxy once, then retry.",
        ));
    }
    let raw = request.redaction_mode == RedactionMode::Raw;
    let rule_traces_available = state
        .capabilities
        .map(|capabilities| capabilities.rule_traces)
        .unwrap_or(false);
    let session_id_for_query = session_id.clone();
    let data = state
        .with_db(move |connection| {
            let summary = load_session_summary(connection, &session_id_for_query)?
                .ok_or_else(|| aiproxy_db::DbError::not_found("session", &session_id_for_query))?;
            let detail = if details_available {
                load_session_detail(connection, &session_id_for_query)?
            } else {
                None
            };
            let mut output = Map::new();
            let mut redacted_fields = BTreeSet::new();

            output.insert("sessionId".to_string(), json!(summary.id));
            if include.contains(&SessionInclude::Summary) {
                output.insert(
                    "summary".to_string(),
                    summary_to_json(&summary, &redactor, raw, false, &[]),
                );
            }
            if include.contains(&SessionInclude::Headers) {
                if let Some(detail) = &detail {
                    let request_headers = header_entries(&redactor, &detail.request_headers, raw);
                    let response_headers = header_entries(&redactor, &detail.response_headers, raw);
                    redacted_fields.extend(request_headers.fields);
                    redacted_fields.extend(response_headers.fields);
                    output.insert(
                        "requestHeaders".to_string(),
                        serde_json::to_value(request_headers.value).unwrap_or(Value::Null),
                    );
                    output.insert(
                        "responseHeaders".to_string(),
                        serde_json::to_value(response_headers.value).unwrap_or(Value::Null),
                    );
                }
            }
            if include.contains(&SessionInclude::Query) {
                if let Some(detail) = &detail {
                    let query = if raw {
                        parse_entries(&detail.query_params)
                    } else {
                        redactor.redact_key_value_json(&detail.query_params)
                    };
                    redacted_fields.extend(query.fields);
                    output.insert(
                        "queryParams".to_string(),
                        serde_json::to_value(query.value).unwrap_or(Value::Null),
                    );
                }
            }
            if include.contains(&SessionInclude::Cookies) {
                if let Some(detail) = &detail {
                    let cookies = if raw {
                        parse_entries(&detail.cookies)
                    } else {
                        redactor.redact_cookie_headers(parse_entries(&detail.cookies).value)
                    };
                    redacted_fields.extend(cookies.fields);
                    output.insert(
                        "cookies".to_string(),
                        serde_json::to_value(cookies.value).unwrap_or(Value::Null),
                    );
                }
            }
            if include.contains(&SessionInclude::Timing) {
                if let Some(detail) = &detail {
                    output.insert(
                        "timing".to_string(),
                        detail
                            .timing
                            .as_deref()
                            .and_then(parse_timing_json)
                            .unwrap_or(Value::Null),
                    );
                }
            }
            if include.contains(&SessionInclude::Tls) {
                if let Some(detail) = &detail {
                    output.insert(
                        "tls".to_string(),
                        json!({
                            "protocol": detail.tls_protocol,
                            "cipherSuite": detail.tls_cipher_suite,
                            "serverIp": detail.server_ip,
                            "clientAddress": detail.client_address,
                            "viaUpstreamProxy": detail.via_upstream_proxy,
                        }),
                    );
                }
            }
            if include.contains(&SessionInclude::Http2) {
                if let Some(detail) = &detail {
                    let trailers = detail
                        .trailers
                        .as_deref()
                        .map(|value| header_entries(&redactor, value, raw));
                    if let Some(trailers) = &trailers {
                        redacted_fields.extend(trailers.fields.clone());
                    }
                    output.insert(
                        "http2".to_string(),
                        json!({
                            "streamId": detail.h2_stream_id,
                            "trailers": trailers.map(|value| value.value),
                        }),
                    );
                }
            }
            if include.contains(&SessionInclude::RuleTraces) && rule_traces_available {
                let (traces, trace_fields) =
                    load_rule_traces(connection, &session_id_for_query, raw, &redactor)?;
                redacted_fields.extend(trace_fields);
                output.insert("ruleTraces".to_string(), traces);
            }
            if detail.is_none() {
                output.insert("detailAvailable".to_string(), Value::Bool(false));
            }
            output.insert(
                "redactedFields".to_string(),
                serde_json::to_value(redacted_fields.iter().collect::<Vec<_>>())
                    .unwrap_or(Value::Null),
            );
            Ok((Value::Object(output), !redacted_fields.is_empty()))
        })
        .await?;
    Ok((data.0, ToolMeta::new(false, data.1, None)))
}

pub(crate) fn parse_timing_json(value: &str) -> Option<Value> {
    serde_json::from_str::<Value>(value)
        .ok()
        .map(normalize_timing_value)
}

/// Persisted timing uses snake_case, while public MCP fields use camelCase.
/// Normalize recursively so timing and nested snapshots share one contract.
pub(crate) fn normalize_timing_value(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (snake_to_camel(&key), normalize_timing_value(value)))
                .collect(),
        ),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(normalize_timing_value).collect())
        }
        other => other,
    }
}

fn snake_to_camel(key: &str) -> String {
    let mut output = String::with_capacity(key.len());
    let mut uppercase_next = false;
    for character in key.chars() {
        if character == '_' {
            uppercase_next = true;
            continue;
        }
        if uppercase_next {
            output.extend(character.to_uppercase());
            uppercase_next = false;
        } else {
            output.push(character);
        }
    }
    output
}

pub(crate) fn summary_to_json(
    summary: &SessionSummaryRow,
    redactor: &Redactor,
    raw: bool,
    compact: bool,
    fields: &[SummaryField],
) -> Value {
    let mut full = json!({
        "sessionId": summary.id,
        "method": summary.method,
        "host": summary.host,
        "path": summary.path,
        "protocol": summary.protocol,
        "scheme": summary.scheme,
        "httpVersion": summary.http_version,
        "transportProtocol": summary.transport_protocol,
        "applicationProtocol": summary.application_protocol,
        "startedAt": summary.started_at,
        "finishedAt": summary.finished_at,
        "durationMs": summary.duration_ms,
        "sizeBytes": summary.size_bytes,
        "statusCode": summary.status_code,
        "url": if raw { summary.url.clone() } else { redactor.redact_url(&summary.url) },
        "responseMimeType": summary.response_mime_type,
    });
    if let Some(failure) = failure_to_json(summary, redactor, raw) {
        if let Some(object) = full.as_object_mut() {
            object.insert("failure".to_string(), failure);
        }
    }

    let fields = if !fields.is_empty() {
        fields.to_vec()
    } else if compact {
        vec![
            SummaryField::SessionId,
            SummaryField::Method,
            SummaryField::Host,
            SummaryField::Path,
            SummaryField::StatusCode,
            SummaryField::DurationMs,
            SummaryField::SizeBytes,
            SummaryField::StartedAt,
            SummaryField::Failure,
        ]
    } else {
        return full;
    };

    let mut projected = Map::new();
    for field in fields {
        if let Some(value) = full.get(field.key()) {
            projected.insert(field.key().to_string(), value.clone());
        }
    }
    Value::Object(projected)
}

fn failure_to_json(summary: &SessionSummaryRow, redactor: &Redactor, raw: bool) -> Option<Value> {
    let origin = summary.failure_origin.as_deref()?;
    let kind = summary.failure_kind.as_deref()?;
    let message = if raw {
        summary.failure_message.clone().unwrap_or_default()
    } else {
        redactor
            .redact_text(summary.failure_message.as_deref().unwrap_or_default())
            .value
    };
    Some(json!({
        "origin": origin,
        "kind": kind,
        "message": message,
    }))
}

pub(crate) fn parse_since(value: &str) -> Result<String, ToolError> {
    let value = value.trim();
    if value.len() < 2 {
        return Err(ToolError::invalid(
            "since must use a relative duration such as 30m, 2h, or 7d.",
        ));
    }
    let split = value
        .find(|character: char| !character.is_ascii_digit())
        .ok_or_else(|| ToolError::invalid("since must include a unit such as s, m, h, or d."))?;
    let amount = value[..split]
        .parse::<i64>()
        .map_err(|_| ToolError::invalid("since contains an invalid duration."))?;
    if amount <= 0 {
        return Err(ToolError::invalid("since must be greater than zero."));
    }
    let unit = &value[split..];
    let duration = match unit {
        "s" => Duration::seconds(amount),
        "m" => Duration::minutes(amount),
        "h" => Duration::hours(amount),
        "d" => Duration::days(amount),
        _ => {
            return Err(ToolError::invalid(
                "since unit must be one of s, m, h, or d.",
            ))
        }
    };
    Ok((Utc::now() - duration).to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn escape_like_pattern(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '%' | '_' | '\\') {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

fn parse_entries(json: &str) -> RedactionOutput<Vec<HeaderEntry>> {
    RedactionOutput {
        value: serde_json::from_str(json).unwrap_or_default(),
        fields: Vec::new(),
        records: Vec::new(),
    }
}

fn header_entries(redactor: &Redactor, json: &str, raw: bool) -> RedactionOutput<Vec<HeaderEntry>> {
    if raw {
        parse_entries(json)
    } else {
        redactor.redact_headers_json(json)
    }
}

fn load_rule_traces(
    connection: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    raw: bool,
    redactor: &Redactor,
) -> Result<(Value, BTreeSet<String>), aiproxy_db::DbError> {
    use aiproxy_db::rules;

    let rewrite_runs = rules::load_rewrite_runs_for_session(connection, session_id)?;
    let rewrite_ids = rewrite_runs
        .iter()
        .map(|run| run.id.clone())
        .collect::<Vec<_>>();
    let rewrite_entries = rules::load_rewrite_run_entries(connection, &rewrite_ids)?;
    let script_runs = rules::load_script_runs_for_session(connection, session_id)?;
    let script_ids = script_runs
        .iter()
        .map(|run| run.id.clone())
        .collect::<Vec<_>>();
    let script_entries = rules::load_script_run_entries(connection, &script_ids)?;
    let map_runs = rules::load_map_runs_for_session(connection, session_id)?;
    let throttle_runs = rules::load_throttle_runs_for_session(connection, session_id)?;

    let mut rule_redactor = RuleTraceRedactor::new(raw, redactor);
    let rewrite = rewrite_runs
        .iter()
        .map(|run| {
            let entries = rewrite_entries
                .iter()
                .filter(|entry| entry.run_id == run.id)
                .map(|entry| {
                    json!({
                        "kind": entry.kind,
                        "key": entry.key,
                        "before": rule_redactor.optional_text(entry.key.as_deref(), &entry.before_value),
                        "after": rule_redactor.optional_text(entry.key.as_deref(), &entry.after_value),
                        "message": rule_redactor.optional_text(entry.key.as_deref(), &entry.message),
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": run.id,
                "ruleName": run.rule_name,
                "type": run.rewrite_type,
                "stage": run.stage,
                "outcome": run.outcome,
                "durationMs": run.duration_ms,
                "entries": entries,
            })
        })
        .collect::<Vec<_>>();
    let script = script_runs
        .iter()
        .map(|run| {
            let entries = script_entries
                .iter()
                .filter(|entry| entry.run_id == run.id)
                .map(|entry| {
                    json!({
                        "kind": entry.kind,
                        "level": entry.level,
                        "key": entry.key,
                        "message": rule_redactor.optional_text(entry.key.as_deref(), &entry.message),
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": run.id,
                "ruleId": run.rule_id,
                "stage": run.stage,
                "outcome": run.outcome,
                "durationMs": run.duration_ms,
                "entries": entries,
            })
        })
        .collect::<Vec<_>>();
    let map = map_runs
        .iter()
        .map(|run| {
            json!({
                "ruleName": run.rule_name,
                "mode": run.mode,
                "outcome": run.outcome,
                "sourcePattern": rule_redactor.url(&run.source_pattern),
                "mappedUrl": run.mapped_url.as_deref().map(|url| rule_redactor.url(url)),
                "durationMs": run.duration_ms,
            })
        })
        .collect::<Vec<_>>();
    let throttle = throttle_runs
        .iter()
        .map(|run| {
            json!({
                "profileName": run.profile_name,
                "ruleName": run.rule_name,
                "stage": run.stage,
                "outcome": run.outcome,
                "delayMs": run.delay_ms,
                "latencyMs": run.latency_ms,
                "transferDelayMs": run.transfer_delay_ms,
            })
        })
        .collect::<Vec<_>>();

    Ok((
        json!({
            "rewrite": rewrite,
            "script": script,
            "map": map,
            "throttle": throttle,
        }),
        rule_redactor.fields,
    ))
}

struct RuleTraceRedactor<'a> {
    raw: bool,
    redactor: &'a Redactor,
    fields: BTreeSet<String>,
}

impl<'a> RuleTraceRedactor<'a> {
    fn new(raw: bool, redactor: &'a Redactor) -> Self {
        Self {
            raw,
            redactor,
            fields: BTreeSet::new(),
        }
    }

    fn optional_text(&mut self, key: Option<&str>, value: &Option<String>) -> Option<String> {
        value.as_deref().map(|text| self.text(key, text))
    }

    fn text(&mut self, key: Option<&str>, value: &str) -> String {
        if self.raw {
            return value.to_string();
        }
        let output = match key {
            Some(key) => self.redactor.redact_named_value(key, value),
            None => self.redactor.redact_text(value),
        };
        self.fields.extend(output.fields);
        output.value
    }

    fn url(&mut self, value: &str) -> String {
        if self.raw {
            return value.to_string();
        }
        self.fields.insert("url".to_string());
        self.redactor.redact_url(value)
    }
}

impl From<SearchField> for SessionSearchField {
    fn from(value: SearchField) -> Self {
        match value {
            SearchField::Url => Self::Url,
            SearchField::Host => Self::Host,
            SearchField::Path => Self::Path,
            SearchField::Method => Self::Method,
            SearchField::Headers => Self::Headers,
            SearchField::Query => Self::Query,
        }
    }
}

impl From<SessionSortBy> for SessionSortField {
    fn from(value: SessionSortBy) -> Self {
        match value {
            SessionSortBy::StartedAt => Self::StartedAt,
            SessionSortBy::DurationMs => Self::DurationMs,
            SessionSortBy::SizeBytes => Self::SizeBytes,
            SessionSortBy::StatusCode => Self::StatusCode,
        }
    }
}

impl From<SessionSortDirection> for SortOrder {
    fn from(value: SessionSortDirection) -> Self {
        match value {
            SessionSortDirection::Desc => Self::Desc,
            SessionSortDirection::Asc => Self::Asc,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiproxy_db::rusqlite::Connection;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        aiproxy_db::schema::run_migrations(&connection).unwrap();
        for (id, started_at) in [
            ("prefix-aaaa-1111", "2026-10-17T10:00:00Z"),
            ("prefix-aaaa-2222", "2026-10-17T10:01:00Z"),
            ("unique-bbbb-3333", "2026-10-17T10:02:00Z"),
        ] {
            connection
                .execute(
                    "INSERT INTO session_summaries
                        (id, method, host, path, protocol, scheme, http_version,
                         transport_protocol, application_protocol, started_at, finished_at,
                         duration_ms, size_bytes, status_code, url)
                     VALUES (?1, 'GET', 'api.example.com', '/', 'HTTP/1.1', 'https', '1.1',
                             'tcp', 'http', ?2, ?2, 10, 10, 200, 'https://api.example.com/')",
                    [id, started_at],
                )
                .unwrap();
        }
        connection
    }

    #[test]
    fn since_accepts_relative_durations() {
        for value in ["5s", "30m", "2h", "7d"] {
            assert!(parse_since(value).is_ok(), "{value}");
        }
        for value in ["", "10", "0m", "1w", "-5m"] {
            assert!(parse_since(value).is_err(), "{value}");
        }
    }

    #[test]
    fn compact_summary_projects_the_default_fields() {
        let redactor = Redactor::from_config(
            &crate::config::AgentAccessConfig::default(),
            std::path::Path::new("/tmp/aiproxy-compact-test"),
        )
        .unwrap();
        let summary = SessionSummaryRow {
            id: "s1".to_string(),
            method: "GET".to_string(),
            host: "api.example.com".to_string(),
            path: "/v1".to_string(),
            protocol: "HTTP/2".to_string(),
            scheme: "https".to_string(),
            http_version: "2".to_string(),
            transport_protocol: "tcp".to_string(),
            application_protocol: "http".to_string(),
            started_at: "2026-10-17T10:00:00Z".to_string(),
            finished_at: "2026-10-17T10:00:01Z".to_string(),
            duration_ms: 12,
            size_bytes: 34,
            status_code: 200,
            url: "https://api.example.com/v1?token=secret".to_string(),
            response_mime_type: Some("application/json".to_string()),
            failure_origin: None,
            failure_kind: None,
            failure_message: None,
        };
        let value = summary_to_json(&summary, &redactor, false, true, &[]);
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["method"], "GET");
        assert_eq!(value["path"], "/v1");
        assert_eq!(value["statusCode"], 200);
        assert!(value.get("url").is_none());
    }

    #[test]
    fn session_ids_accept_exact_matches_and_unique_prefixes() {
        let connection = test_connection();
        assert_eq!(
            lookup_session_id(&connection, "unique-bbbb-3333").unwrap(),
            SessionIdLookup::Found("unique-bbbb-3333".to_string())
        );
        assert_eq!(
            lookup_session_id(&connection, "unique-bbbb").unwrap(),
            SessionIdLookup::Found("unique-bbbb-3333".to_string())
        );
    }

    #[test]
    fn session_id_prefixes_reject_short_or_ambiguous_values() {
        let connection = test_connection();
        assert_eq!(
            lookup_session_id(&connection, "prefix").unwrap(),
            SessionIdLookup::NotFound
        );
        assert_eq!(
            lookup_session_id(&connection, "prefix-aaaa").unwrap(),
            SessionIdLookup::Ambiguous(vec![
                "prefix-aaaa-2222".to_string(),
                "prefix-aaaa-1111".to_string()
            ])
        );
    }
}
