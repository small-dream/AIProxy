use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use aiproxy_agent_control::{ControlError, ReplaySessionParams};
use aiproxy_proxy_core::{
    send_direct_request_bytes, set_json_path_from_str, ProxyHeaderEntry, ProxySessionDetail,
    SessionFailure,
};
use serde::Serialize;
use url::Url;

use crate::bootstrap::AppState;

const REPLAY_WINDOW: Duration = Duration::from_secs(60);
const MAX_REPLAYS_PER_WINDOW: usize = 10;
const MAX_HEADER_VALUE_BYTES: usize = 8192;
const MAX_OVERRIDE_ENTRIES: usize = 100;
const MAX_JSON_SET_FIELDS: usize = 50;
const MAX_JSON_SET_PATH_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySessionResult {
    pub new_session_id: String,
    pub status_code: u16,
    pub duration_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<SessionFailure>,
}

#[derive(Default)]
struct ReplayGate {
    in_flight: bool,
    attempts: VecDeque<Instant>,
}

static REPLAY_GATE: OnceLock<Mutex<ReplayGate>> = OnceLock::new();

struct ReplayPermit;

impl ReplayGate {
    fn begin(&mut self, now: Instant) -> Result<(), ControlError> {
        while self
            .attempts
            .front()
            .is_some_and(|attempt| now.duration_since(*attempt) >= REPLAY_WINDOW)
        {
            self.attempts.pop_front();
        }
        if self.in_flight {
            return Err(ControlError::new(
                "RATE_LIMITED",
                "Another Agent replay is already running. Wait for it to finish before retrying.",
            )
            .retryable(true));
        }
        if self.attempts.len() >= MAX_REPLAYS_PER_WINDOW {
            return Err(ControlError::new(
                "RATE_LIMITED",
                format!(
                    "Agent replay is limited to {MAX_REPLAYS_PER_WINDOW} requests per 60 seconds. Wait before retrying."
                ),
            )
            .retryable(true));
        }
        self.in_flight = true;
        self.attempts.push_back(now);
        Ok(())
    }

    fn finish(&mut self) {
        self.in_flight = false;
    }
}

impl Drop for ReplayPermit {
    fn drop(&mut self) {
        let mut gate = replay_gate()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        gate.finish();
    }
}

fn replay_gate() -> &'static Mutex<ReplayGate> {
    REPLAY_GATE.get_or_init(|| Mutex::new(ReplayGate::default()))
}

fn acquire_replay_permit() -> Result<ReplayPermit, ControlError> {
    let mut gate = replay_gate()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    gate.begin(Instant::now())?;
    Ok(ReplayPermit)
}

pub async fn replay_session(
    state: Arc<AppState>,
    params: ReplaySessionParams,
) -> Result<ReplaySessionResult, ControlError> {
    let session_id = validate_session_id(&params.session_id)?;
    let state_for_read = Arc::clone(&state);
    let detail = tauri::async_runtime::spawn_blocking(move || {
        state_for_read.read_session_detail(&session_id)
    })
    .await
    .map_err(|error| {
        ControlError::new(
            "INTERNAL_ERROR",
            format!("Load original session for replay: {error}"),
        )
    })?
    .map_err(|error| ControlError::new("DB_ERROR", format!("Load original session: {error}")))?
    .ok_or_else(|| {
        ControlError::new(
            "SESSION_NOT_FOUND",
            format!("Session '{}' was not found.", params.session_id),
        )
    })?;

    let prepared = prepare_replay(&detail, &params)?;
    let _permit = acquire_replay_permit()?;
    let mut replayed = send_direct_request_bytes(
        prepared.method,
        prepared.url,
        prepared.headers,
        prepared.body,
    )
    .await
    .map_err(|message| {
        ControlError::new(
            "REPLAY_FAILED",
            format!("Replay request failed before a response was captured: {message}"),
        )
        .with_details(serde_json::json!({
            "originalSessionId": detail.id,
            "host": prepared_host(&detail.summary.url),
        }))
    })?;
    replayed.timing_source = Some("agentReplay".to_string());
    let result = ReplaySessionResult {
        new_session_id: replayed.id.clone(),
        status_code: replayed.summary.status_code,
        duration_ms: replayed.summary.duration_ms,
        failure: replayed.failure.clone(),
    };
    state.upsert_session_async(replayed).await;
    Ok(result)
}

#[derive(Debug)]
struct PreparedReplay {
    method: String,
    url: String,
    headers: Vec<ProxyHeaderEntry>,
    body: Option<Vec<u8>>,
}

fn prepare_replay(
    detail: &ProxySessionDetail,
    params: &ReplaySessionParams,
) -> Result<PreparedReplay, ControlError> {
    if detail.summary.method.eq_ignore_ascii_case("CONNECT") || detail.summary.status_code == 0 {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            "Connection and TLS failures cannot be replayed because no complete HTTP request was captured.",
        ));
    }

    let original_url = Url::parse(&detail.summary.url).map_err(|error| {
        ControlError::new(
            "INVALID_ARGUMENT",
            format!("The captured session URL is invalid: {error}"),
        )
    })?;
    if !matches!(original_url.scheme(), "http" | "https") {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            "Only captured HTTP and HTTPS requests can be replayed.",
        ));
    }
    let original_host = original_url
        .host_str()
        .ok_or_else(|| {
            ControlError::new(
                "INVALID_ARGUMENT",
                "The captured session URL does not include a host.",
            )
        })?
        .to_string();

    let method = params
        .method
        .as_deref()
        .map(str::trim)
        .filter(|method| !method.is_empty())
        .unwrap_or(&detail.summary.method)
        .to_ascii_uppercase();
    validate_method(&method)?;

    let mut headers = detail.request_headers.clone();
    if params.set_headers.len() > MAX_OVERRIDE_ENTRIES
        || params.remove_headers.len() > MAX_OVERRIDE_ENTRIES
        || params.set_query_params.len() > MAX_OVERRIDE_ENTRIES
    {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            format!("Each replay override list accepts at most {MAX_OVERRIDE_ENTRIES} entries."),
        ));
    }

    for name in &params.remove_headers {
        let name = validate_header_name(name)?;
        headers.retain(|header| !header.name.eq_ignore_ascii_case(&name));
    }
    for override_header in &params.set_headers {
        let name = validate_header_name(&override_header.name)?;
        let value = validate_header_value(&override_header.value)?;
        headers.retain(|header| !header.name.eq_ignore_ascii_case(&name));
        headers.push(ProxyHeaderEntry {
            name,
            value,
            is_pseudo: None,
        });
    }

    let mut url = original_url;
    if !params.set_query_params.is_empty() {
        let pairs = params
            .set_query_params
            .iter()
            .map(|entry| {
                let name = validate_query_name(&entry.name)?;
                let value = validate_query_value(&entry.value)?;
                Ok((name, value))
            })
            .collect::<Result<Vec<_>, ControlError>>()?;
        let existing_pairs = url
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .filter(|(name, _)| !pairs.iter().any(|(override_name, _)| override_name == name))
            .collect::<Vec<_>>();
        url.set_query(None);
        if !existing_pairs.is_empty() || !pairs.is_empty() {
            let mut query = url.query_pairs_mut();
            for (name, value) in existing_pairs {
                query.append_pair(&name, &value);
            }
            for (name, value) in pairs {
                query.append_pair(&name, &value);
            }
        }
    }

    let final_host = url.host_str().ok_or_else(|| {
        ControlError::new(
            "INVALID_ARGUMENT",
            "The replay URL does not include a host.",
        )
    })?;
    if !final_host.eq_ignore_ascii_case(&original_host) {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            format!(
                "Replay is locked to the original host '{original_host}'; it cannot target '{final_host}'."
            ),
        ));
    }

    let mut body = match params.body.as_ref() {
        Some(body) => Some(body.as_bytes().to_vec()),
        None => match &detail.request_body {
            Some(body) if body.truncated => {
                return Err(ControlError::new(
                    "INVALID_ARGUMENT",
                    "The captured request body was truncated, so it cannot be replayed faithfully. Provide a complete body override or capture the request again with a larger body limit.",
                ));
            }
            Some(body) => Some(body.read_bytes().map_err(|error| {
                ControlError::new(
                    "BODY_UNAVAILABLE",
                    format!("Read the captured request body: {error}"),
                )
            })?),
            None => None,
        },
    };

    if !params.json_set.is_empty() {
        if params.json_set.len() > MAX_JSON_SET_FIELDS {
            return Err(ControlError::new(
                "INVALID_ARGUMENT",
                format!("jsonSet accepts at most {MAX_JSON_SET_FIELDS} fields."),
            ));
        }
        let bytes = body.as_deref().unwrap_or_default();
        if bytes.is_empty() {
            return Err(ControlError::new(
                "INVALID_ARGUMENT",
                "jsonSet requires a JSON request body.",
            ));
        }
        let mut json_body: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| {
            ControlError::new(
                "INVALID_ARGUMENT",
                format!("jsonSet requires the replay body to be valid JSON: {error}"),
            )
        })?;
        for (path, value) in &params.json_set {
            if path.is_empty() || path.len() > MAX_JSON_SET_PATH_BYTES {
                return Err(ControlError::new(
                    "INVALID_ARGUMENT",
                    format!("jsonSet paths must be 1-{MAX_JSON_SET_PATH_BYTES} bytes."),
                ));
            }
            set_json_path_from_str(&mut json_body, path, value.clone()).map_err(|error| {
                ControlError::new(
                    "INVALID_ARGUMENT",
                    format!("Apply jsonSet path '{path}': {error}"),
                )
            })?;
        }
        body = Some(serde_json::to_vec(&json_body).map_err(|error| {
            ControlError::new(
                "INVALID_ARGUMENT",
                format!("Serialize replay JSON body: {error}"),
            )
        })?);
        if !headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case("content-type"))
        {
            headers.push(ProxyHeaderEntry {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
                is_pseudo: None,
            });
        }
    }

    Ok(PreparedReplay {
        method,
        url: url.to_string(),
        headers,
        body,
    })
}

fn validate_session_id(value: &str) -> Result<String, ControlError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            "sessionId must be 1-256 bytes.",
        ));
    }
    Ok(value.to_string())
}

fn validate_method(value: &str) -> Result<(), ControlError> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(is_http_token_byte) {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            "method must be a valid HTTP method.",
        ));
    }
    Ok(())
}

fn validate_header_name(value: &str) -> Result<String, ControlError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || value.starts_with(':')
        || !value.bytes().all(is_http_token_byte)
        || value.eq_ignore_ascii_case("host")
    {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            "Header names must be valid non-pseudo header names and cannot change Host.",
        ));
    }
    Ok(value.to_string())
}

fn validate_header_value(value: &str) -> Result<String, ControlError> {
    if value.len() > MAX_HEADER_VALUE_BYTES || value.contains('\r') || value.contains('\n') {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            format!("Header values must be at most {MAX_HEADER_VALUE_BYTES} bytes without CR/LF."),
        ));
    }
    Ok(value.to_string())
}

fn validate_query_name(value: &str) -> Result<String, ControlError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            "Query parameter names must be 1-256 bytes without control characters.",
        ));
    }
    Ok(value.to_string())
}

fn validate_query_value(value: &str) -> Result<String, ControlError> {
    if value.len() > MAX_HEADER_VALUE_BYTES || value.chars().any(char::is_control) {
        return Err(ControlError::new(
            "INVALID_ARGUMENT",
            format!(
                "Query parameter values must be at most {MAX_HEADER_VALUE_BYTES} bytes without control characters."
            ),
        ));
    }
    Ok(value.to_string())
}

fn is_http_token_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
    ) || byte.is_ascii_alphanumeric()
}

fn prepared_host(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiproxy_proxy_core::{ProxyBodyReference, ProxySessionSummary, ProxyTimingBreakdown};
    use std::collections::BTreeMap;

    fn detail(body: Option<&[u8]>) -> ProxySessionDetail {
        ProxySessionDetail {
            client_address: None,
            cookies: Vec::new(),
            id: "session-1".to_string(),
            query_params: Vec::new(),
            raw_request_head: None,
            raw_response_head: None,
            request_body: body.map(|bytes| {
                ProxyBodyReference::from_decoded_bytes(
                    bytes.to_vec(),
                    None,
                    bytes.len(),
                    false,
                    false,
                )
            }),
            request_headers: vec![
                ProxyHeaderEntry {
                    name: "Host".to_string(),
                    value: "api.example.com".to_string(),
                    is_pseudo: None,
                },
                ProxyHeaderEntry {
                    name: "Authorization".to_string(),
                    value: "Bearer secret".to_string(),
                    is_pseudo: None,
                },
            ],
            response_body: None,
            response_headers: Vec::new(),
            map_traces: Vec::new(),
            rewrite_traces: Vec::new(),
            server_ip: None,
            tls_cipher_suite: None,
            tls_protocol: None,
            summary: ProxySessionSummary {
                id: "session-1".to_string(),
                method: "POST".to_string(),
                host: "api.example.com".to_string(),
                path: "/v1/items?keep=1".to_string(),
                protocol: "HTTP/1.1".to_string(),
                scheme: "https".to_string(),
                http_version: "1.1".to_string(),
                transport_protocol: "tcp".to_string(),
                application_protocol: "http".to_string(),
                started_at: "2026-10-30T00:00:00Z".to_string(),
                finished_at: "2026-10-30T00:00:01Z".to_string(),
                duration_ms: 1000,
                size_bytes: 100,
                status_code: 200,
                url: "https://api.example.com/v1/items?keep=1".to_string(),
                response_mime_type: Some("application/json".to_string()),
                failure: None,
            },
            script_traces: Vec::new(),
            throttle_traces: Vec::new(),
            timing: Some(ProxyTimingBreakdown {
                connect_ms: None,
                connection_reused: None,
                connection_wait_ms: None,
                dns_ms: None,
                request_send_ms: None,
                response_read_ms: None,
                tls_ms: None,
                total_ms: None,
                waiting_ms: None,
            }),
            timing_source: Some("proxy".to_string()),
            trailers: None,
            h2_stream_id: None,
            via_upstream_proxy: None,
            failure: None,
        }
    }

    fn params() -> ReplaySessionParams {
        ReplaySessionParams {
            session_id: "session-1".to_string(),
            method: None,
            set_headers: Vec::new(),
            remove_headers: Vec::new(),
            set_query_params: Vec::new(),
            body: None,
            json_set: BTreeMap::new(),
        }
    }

    #[test]
    fn preserves_binary_body_and_replaces_query_parameters() {
        let bytes = vec![0, 1, 2, 255];
        let mut params = params();
        params.set_query_params = vec![
            aiproxy_agent_control::QueryParamOverride {
                name: "keep".to_string(),
                value: "2".to_string(),
            },
            aiproxy_agent_control::QueryParamOverride {
                name: "new".to_string(),
                value: "a b".to_string(),
            },
        ];
        let prepared = prepare_replay(&detail(Some(&bytes)), &params).unwrap();
        assert_eq!(prepared.body, Some(bytes));
        let url = Url::parse(&prepared.url).unwrap();
        let pairs = url.query_pairs().collect::<Vec<_>>();
        assert!(pairs.contains(&("keep".into(), "2".into())));
        assert!(pairs.contains(&("new".into(), "a b".into())));
    }

    #[test]
    fn applies_json_set_with_the_rule_engine_path_grammar() {
        let mut params = params();
        params
            .json_set
            .insert("items[0].enabled".to_string(), true.into());
        params
            .json_set
            .insert("items[0].count".to_string(), 3.into());
        let prepared = prepare_replay(
            &detail(Some(br#"{"items":[{"enabled":false,"count":1}]}"#)),
            &params,
        )
        .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&prepared.body.unwrap()).unwrap();
        assert_eq!(body["items"][0]["enabled"], true);
        assert_eq!(body["items"][0]["count"], 3);
    }

    #[test]
    fn rejects_host_header_and_truncated_bodies() {
        let mut host_override = params();
        host_override.set_headers = vec![aiproxy_agent_control::HeaderOverride {
            name: "Host".to_string(),
            value: "evil.example.com".to_string(),
        }];
        assert_eq!(
            prepare_replay(&detail(None), &host_override)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );

        let mut original = detail(Some(b"partial"));
        original.request_body.as_mut().unwrap().truncated = true;
        assert_eq!(
            prepare_replay(&original, &params()).unwrap_err().code,
            "INVALID_ARGUMENT"
        );

        let mut complete = params();
        complete.body = Some("complete".to_string());
        assert_eq!(
            prepare_replay(&original, &complete).unwrap().body,
            Some(b"complete".to_vec())
        );
    }

    #[test]
    fn body_override_supports_json_set_without_original_body() {
        let mut params = params();
        params.body = Some("{}".to_string());
        params.json_set.insert("ok".to_string(), true.into());
        let prepared = prepare_replay(&detail(None), &params).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&prepared.body.unwrap()).unwrap()["ok"],
            true
        );
    }

    #[test]
    fn replay_gate_allows_one_in_flight_request_and_ten_per_minute() {
        let mut gate = ReplayGate::default();
        let start = Instant::now();

        gate.begin(start).unwrap();
        assert_eq!(gate.begin(start).unwrap_err().code, "RATE_LIMITED");
        gate.finish();

        for offset in 1..MAX_REPLAYS_PER_WINDOW {
            gate.begin(start + Duration::from_millis(offset as u64))
                .unwrap();
            gate.finish();
        }

        let limited = gate.begin(start + Duration::from_secs(59)).unwrap_err();
        assert_eq!(limited.code, "RATE_LIMITED");
        gate.begin(start + REPLAY_WINDOW).unwrap();
    }
}
