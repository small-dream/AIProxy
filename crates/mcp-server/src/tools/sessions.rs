use std::collections::BTreeSet;

use aiproxy_db::session_search::{
    search_sessions as db_search_sessions, SessionSearchField, SessionSearchFilter,
    MAX_SESSION_SEARCH_LIMIT,
};
use aiproxy_db::sessions::{load_session_detail, load_session_summary, SessionSummaryRow};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::{
    is_sensitive_name, redact_cookie_headers, redact_headers_json, redact_key_value_json,
    redact_text, redact_url, REDACTED_VALUE,
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SearchSessionsRequest {
    pub host: Option<String>,
    pub host_contains: Option<String>,
    pub method: Option<String>,
    pub status_min: Option<u16>,
    pub status_max: Option<u16>,
    pub protocol: Option<String>,
    pub mime: Option<String>,
    pub started_after: Option<String>,
    pub started_before: Option<String>,
    pub min_duration_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
    pub keyword: Option<String>,
    #[serde(default)]
    pub search_in: Vec<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionInclude {
    Summary,
    Headers,
    Query,
    Cookies,
    Timing,
    Tls,
    Http2,
    RuleTraces,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetSessionRequest {
    pub session_id: String,
    #[serde(default)]
    pub include: Vec<SessionInclude>,
    #[serde(default)]
    pub redaction_mode: RedactionMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RedactionMode {
    #[default]
    RedactedText,
    Raw,
}

pub async fn search(
    state: &AppContext,
    request: SearchSessionsRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled in Agent Access.",
        ));
    }
    let search_in = parse_search_fields(&request.search_in)?;
    let filter = SessionSearchFilter {
        host: request.host,
        host_contains: request.host_contains,
        method: request.method,
        status_min: request.status_min,
        status_max: request.status_max,
        protocol: request.protocol,
        mime: request.mime,
        started_after: request.started_after,
        started_before: request.started_before,
        min_duration_ms: request.min_duration_ms,
        max_duration_ms: request.max_duration_ms,
        keyword: request.keyword,
        search_in,
    };
    let limit = request
        .limit
        .unwrap_or(20)
        .clamp(1, MAX_SESSION_SEARCH_LIMIT)
        .min(config.limits.max_sessions);
    let cursor = request.cursor;
    let page = state
        .with_db(move |connection| {
            db_search_sessions(connection, &filter, limit, cursor.as_deref())
        })
        .await?;
    let items = page
        .items
        .iter()
        .map(summary_to_json)
        .collect::<Vec<Value>>();
    let meta = ToolMeta::new(page.truncated, true, page.next_cursor);
    Ok((json!({ "items": items }), meta))
}

pub async fn get_session(
    state: &AppContext,
    request: GetSessionRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled in Agent Access.",
        ));
    }
    if request.redaction_mode == RedactionMode::Raw && !config.permissions.read_raw_bodies {
        return Err(ToolError::permission_denied(
            "Raw session metadata requires the readRawBodies permission.",
        ));
    }

    let include = if request.include.is_empty() {
        vec![SessionInclude::Summary]
    } else {
        request.include
    };
    let raw = request.redaction_mode == RedactionMode::Raw;
    let rule_traces_available = state
        .capabilities
        .map(|capabilities| capabilities.rule_traces)
        .unwrap_or(false);
    let session_id = request.session_id;
    let data = state
        .with_db(move |connection| {
            let summary = load_session_summary(connection, &session_id)?
                .ok_or_else(|| aiproxy_db::DbError::not_found("session", &session_id))?;
            let detail = load_session_detail(connection, &session_id)?;
            let mut output = serde_json::Map::new();
            let mut redacted_fields = Vec::new();
            let mut redacted = false;

            if include.contains(&SessionInclude::Summary) {
                output.insert(
                    "summary".to_string(),
                    summary_to_json_with_redaction(&summary, raw),
                );
            }
            if include.contains(&SessionInclude::Headers) {
                if let Some(detail) = &detail {
                    let request_headers = header_entries(&detail.request_headers, raw);
                    let response_headers = header_entries(&detail.response_headers, raw);
                    redacted |= !raw;
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
                        redact_key_value_json(&detail.query_params)
                    };
                    redacted |= !raw;
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
                        redact_cookie_headers(parse_entries(&detail.cookies).value)
                    };
                    redacted |= !raw;
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
                            .and_then(|value| serde_json::from_str(value).ok())
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
                        .map(|value| header_entries(value, raw));
                    if let Some(trailers) = &trailers {
                        redacted |= !raw;
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
                let (traces, trace_fields) = load_rule_traces(connection, &session_id, raw)?;
                redacted |= !raw;
                redacted_fields.extend(trace_fields);
                output.insert("ruleTraces".to_string(), traces);
            }
            if detail.is_none() {
                output.insert("detailAvailable".to_string(), Value::Bool(false));
            }
            redacted_fields.sort();
            redacted_fields.dedup();
            output.insert(
                "redactedFields".to_string(),
                serde_json::to_value(redacted_fields).unwrap_or(Value::Null),
            );
            Ok((Value::Object(output), redacted))
        })
        .await?;
    Ok((data.0, ToolMeta::new(false, data.1, None)))
}

pub fn summary_to_json(summary: &SessionSummaryRow) -> Value {
    summary_to_json_with_redaction(summary, false)
}

fn summary_to_json_with_redaction(summary: &SessionSummaryRow, raw: bool) -> Value {
    json!({
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
        "url": if raw { summary.url.clone() } else { redact_url(&summary.url) },
        "responseMimeType": summary.response_mime_type,
    })
}

fn parse_search_fields(values: &[String]) -> Result<Vec<SessionSearchField>, ToolError> {
    values
        .iter()
        .map(|value| match value.trim().to_lowercase().as_str() {
            "url" => Ok(SessionSearchField::Url),
            "host" => Ok(SessionSearchField::Host),
            "path" => Ok(SessionSearchField::Path),
            "method" => Ok(SessionSearchField::Method),
            "headers" => Ok(SessionSearchField::Headers),
            "query" => Ok(SessionSearchField::Query),
            other => Err(ToolError::invalid(format!(
                "Unsupported searchIn value: {other}"
            ))),
        })
        .collect()
}

fn parse_entries(
    json: &str,
) -> crate::redaction::RedactionOutput<Vec<crate::redaction::HeaderEntry>> {
    crate::redaction::RedactionOutput {
        value: serde_json::from_str(json).unwrap_or_default(),
        fields: Vec::new(),
    }
}

fn header_entries(
    json: &str,
    raw: bool,
) -> crate::redaction::RedactionOutput<Vec<crate::redaction::HeaderEntry>> {
    if raw {
        parse_entries(json)
    } else {
        redact_headers_json(json)
    }
}

fn load_rule_traces(
    connection: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    raw: bool,
) -> Result<(Value, Vec<String>), aiproxy_db::DbError> {
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

    let mut redactor = RuleTraceRedactor::new(raw);
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
                        "before": redactor.optional_text(entry.key.as_deref(), &entry.before_value),
                        "after": redactor.optional_text(entry.key.as_deref(), &entry.after_value),
                        "message": redactor.optional_text(entry.key.as_deref(), &entry.message),
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
                        "message": redactor.optional_text(entry.key.as_deref(), &entry.message),
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
                "sourcePattern": redactor.url(&run.source_pattern),
                "mappedUrl": run.mapped_url.as_deref().map(|url| redactor.url(url)),
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
        redactor.fields.into_iter().collect(),
    ))
}

struct RuleTraceRedactor {
    raw: bool,
    fields: BTreeSet<String>,
}

impl RuleTraceRedactor {
    fn new(raw: bool) -> Self {
        Self {
            raw,
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
        if let Some(key) = key.filter(|key| is_sensitive_name(key)) {
            self.fields.insert(key.to_lowercase());
            return REDACTED_VALUE.to_string();
        }
        let output = redact_text(value);
        self.fields.extend(output.fields);
        output.value
    }

    fn url(&mut self, value: &str) -> String {
        if self.raw {
            return value.to_string();
        }
        let output = redact_text(value);
        self.fields.extend(output.fields);
        redact_url(&output.value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_fields_are_strict() {
        assert!(parse_search_fields(&["url".to_string(), "headers".to_string()]).is_ok());
        assert!(parse_search_fields(&["body".to_string()]).is_err());
    }
}
