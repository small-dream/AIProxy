use aiproxy_agent_control::{
    AgentCapability, AgentGrantScope, ControlOperation, CreateSessionJsonRewriteParams,
    ExtendSessionJsonRewriteParams, SessionJsonRewriteMode, WaitForSessionJsonRewriteParams,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

use crate::context::AppContext;
use crate::control_client::{call_control, ControlCaller};
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::Redactor;

use super::automation::redact_automation_value;
use super::body::{
    json_type_name, load_required_body_reference, parse_json_paths, read_body_bytes,
    render_json_path, require_session_details, BodyPart, JsonPathSegment,
};
use super::control::{ensure_audit, ensure_permission, get_app_status, ToolResult};
use super::sessions::{parse_watermark, require_session_id};

const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_VALUE_BYTES: usize = 64 * 1024;
const MAX_CANDIDATES: usize = 10;
const MAX_PREVIEW_VALUE_BYTES: usize = 1024;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
pub enum SessionJsonRewriteTarget {
    Key {
        key: String,
    },
    Path {
        #[serde(rename = "jsonPath")]
        json_path: String,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSessionJsonRewriteRequest {
    /// Preview is read-only and is the default. Create publishes a temporary rule.
    #[serde(default)]
    pub mode: SessionJsonRewriteMode,
    /// Exact session ID or a unique prefix of at least 8 characters.
    pub session_id: String,
    /// One exact field name or a JSON path to one field.
    pub target: SessionJsonRewriteTarget,
    /// Replacement JSON scalar. The JSON type is preserved.
    pub value: Value,
    /// Pick query keys from the capture. Defaults to the single _method key.
    /// An explicit empty array confirms matching by path without query constraints.
    pub match_query_keys: Option<Vec<String>>,
    /// Temporary rule lifetime, 60–3600 seconds. Defaults to 600.
    #[schemars(range(min = 60, max = 3600))]
    pub ttl_seconds: Option<u64>,
    /// Required for create, 16–128 bytes. Reuse the key when retrying.
    pub idempotency_key: Option<String>,
}

pub async fn create_session_json_rewrite(
    state: &AppContext,
    request: CreateSessionJsonRewriteRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    validate_request(&request)?;
    require_session_details(state)?;
    let config = state
        .ensure_capability(
            AgentCapability::ReadBodies,
            "Read the JSON response field for a temporary rewrite".into(),
            AgentGrantScope {
                session_ids: vec![request.session_id.clone()],
                ..AgentGrantScope::default()
            },
            "Resolving the selected field requires response body access.".into(),
            caller,
        )
        .await?;
    ensure_audit(state)?;
    let session_id = require_session_id(state, &request.session_id).await?;
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|error| ToolError::new("INVALID_REDACTION_CONFIG", error))?;
    ensure_safe_query_scope(
        state,
        &session_id,
        request.match_query_keys.as_deref(),
        &redactor,
    )
    .await?;
    let mut params = CreateSessionJsonRewriteParams {
        mode: request.mode,
        session_id: session_id.clone(),
        json_path: String::new(),
        value: request.value,
        match_query_keys: request.match_query_keys,
        ttl_seconds: request.ttl_seconds.unwrap_or(600),
        idempotency_key: request.idempotency_key,
    };
    ensure_permission(
        &config,
        &ControlOperation::CreateSessionJsonRewrite(params.clone()),
    )?;
    let reference = load_required_body_reference(state, &session_id, BodyPart::Response).await?;
    let store = state.body_store.clone();
    let target = request.target;
    let result = tokio::task::spawn_blocking(move || {
        let body = read_body_bytes(&store, &reference, 0, MAX_BODY_BYTES)?;
        if body.capture_truncated {
            return Err(ToolError::new(
                "BODY_CAPTURE_TRUNCATED",
                "The complete response JSON is required. Capture the response again.",
            ));
        }
        if body.has_more {
            return Err(ToolError::new(
                "BODY_TOO_LARGE",
                "The response JSON exceeds 8 MiB.",
            ));
        }
        let document: Value = serde_json::from_slice(&body.bytes).map_err(|_| {
            ToolError::new("BODY_NOT_JSON", "The captured response is not valid JSON.")
        })?;
        resolve_target(&document, &target, &redactor)
    })
    .await
    .map_err(|_| ToolError::new("INTERNAL_ERROR", "The JSON field resolution task failed."))??;

    let (candidate, redacted) = match result {
        ResolvedTarget::Unique(candidate, redacted) => (candidate, redacted),
        ResolvedTarget::Ambiguous(candidates, has_more, redacted) => {
            let mut meta = ToolMeta::new(has_more, redacted, None);
            meta.audit_recorded_remotely = Some(false);
            return Ok((
                json!({
                    "status": "needs_input", "code": "JSON_FIELD_AMBIGUOUS",
                    "sessionId": session_id, "candidates": candidates, "hasMore": has_more,
                }),
                meta,
            ));
        }
    };
    params.json_path = candidate["jsonPath"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let operation = ControlOperation::CreateSessionJsonRewrite(params);
    let mut meta = ToolMeta::new(false, redacted, None);
    meta.audit_recorded_remotely = Some(false);
    let mut data = match call_control(&state.paths, operation, false, caller).await {
        Ok(data) => {
            meta.audit_recorded_remotely = Some(request.mode == SessionJsonRewriteMode::Create);
            data
        }
        Err(error) if error.code == "CONTROL_UNAVAILABLE" => {
            let (status, _) = get_app_status(state).await?;
            if status["controlAvailable"] == true {
                return Err(error);
            }
            json!({
                "status": "blocked",
                "preflight": {
                    "code": error.code, "appRunning": status["appRunning"],
                    "controlAvailable": false, "message": status["controlError"]["message"],
                    "recommendedAction": if status["appRunning"] == true {
                        "Restart AIProxy to restore the local Agent control channel."
                    } else {
                        "Open AIProxy and start capture."
                    },
                },
            })
        }
        Err(error) => return Err(error),
    };
    data["sessionId"] = json!(session_id);
    data["jsonPath"] = candidate["jsonPath"].clone();
    data["baseline"] = candidate;
    Ok((data, meta))
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitForSessionJsonRewriteRequest {
    /// Change ID returned by create_session_json_rewrite.
    pub change_id: String,
    /// Optional session watermark (w2 or legacy w1). Omit to consider captures since activation.
    pub after_watermark: Option<String>,
    /// Wait between 1000 and 30000 ms. Defaults to 15000.
    #[schemars(range(min = 1000, max = 30000))]
    pub timeout_ms: Option<u64>,
}

pub async fn extend_session_json_rewrite(
    state: &AppContext,
    request: ExtendSessionJsonRewriteParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    session_rewrite_control(
        state,
        ControlOperation::ExtendSessionJsonRewrite(request),
        caller,
    )
    .await
}

pub async fn wait_for_session_json_rewrite(
    state: &AppContext,
    request: WaitForSessionJsonRewriteRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let timeout_ms = request.timeout_ms.unwrap_or(15_000);
    if request.change_id.is_empty()
        || request.change_id.len() > 128
        || !request
            .change_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        || !(1000..=30_000).contains(&timeout_ms)
    {
        return Err(ToolError::invalid("changeId or timeoutMs is invalid."));
    }
    if let Some(watermark) = request.after_watermark.as_deref() {
        parse_watermark(watermark)?;
    }
    let operation = ControlOperation::WaitForSessionJsonRewrite(WaitForSessionJsonRewriteParams {
        change_id: request.change_id.clone(),
        after_watermark: request.after_watermark,
        after_rowid: None,
        timeout_ms,
    });
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled. Enable readSessions in AIProxy Settings > Agent Access.",
        ));
    }
    ensure_permission(&config, &operation)?;
    require_session_details(state)?;
    state
        .ensure_capability(
            AgentCapability::ReadBodies,
            format!(
                "Read one matching captured response for rewrite change {}",
                request.change_id
            ),
            AgentGrantScope::default(),
            "Verify the JSON field rewritten by this change using a real client capture.".into(),
            caller,
        )
        .await?;
    session_rewrite_control(state, operation, caller).await
}

async fn session_rewrite_control(
    state: &AppContext,
    operation: ControlOperation,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let config = state.config()?;
    ensure_permission(&config, &operation)?;
    ensure_audit(state)?;
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|error| ToolError::new("INVALID_REDACTION_CONFIG", error))?;
    let mut value = call_control(&state.paths, operation, false, caller).await?;
    let mut records = Vec::new();
    redact_automation_value(&mut value, "$", &redactor, &mut records);
    let mut meta = ToolMeta::new(false, !records.is_empty(), None);
    if let Some(watermark) = value["watermark"].as_str() {
        meta = meta.with_watermark(watermark.to_owned());
    }
    Ok((value, meta))
}

fn validate_request(request: &CreateSessionJsonRewriteRequest) -> Result<(), ToolError> {
    if request.value.is_object()
        || request.value.is_array()
        || request
            .value
            .as_str()
            .is_some_and(|text| text.len() > MAX_VALUE_BYTES)
    {
        return Err(ToolError::invalid(
            "value must be a JSON scalar of at most 64 KiB.",
        ));
    }
    if !matches!(request.ttl_seconds.unwrap_or(600), 60..=3600) {
        return Err(ToolError::invalid(
            "ttlSeconds must be between 60 and 3600.",
        ));
    }
    if request.mode == SessionJsonRewriteMode::Create
        && !request
            .idempotency_key
            .as_ref()
            .is_some_and(|key| (16..=128).contains(&key.len()))
    {
        return Err(ToolError::invalid(
            "create requires an idempotencyKey of 16–128 bytes.",
        ));
    }
    Ok(())
}

async fn ensure_safe_query_scope(
    state: &AppContext,
    session_id: &str,
    keys: Option<&[String]>,
    redactor: &Redactor,
) -> Result<(), ToolError> {
    let session_id = session_id.to_owned();
    let session = state
        .with_db(move |conn| aiproxy_db::sessions::load_session_summary(conn, &session_id))
        .await?
        .ok_or_else(|| ToolError::new("SESSION_NOT_FOUND", "The source session is unavailable."))?;
    let url = Url::parse(&session.url)
        .map_err(|_| ToolError::invalid("The source session must have an HTTP or HTTPS URL."))?;
    for (key, value) in url.query_pairs() {
        let selected = keys
            .map(|names| names.iter().any(|name| name == &key))
            .unwrap_or(key == "_method");
        if selected && !redactor.redact_named_value(&key, &value).records.is_empty() {
            return Err(ToolError::permission_denied(
                "Sensitive query parameters cannot be used as rewrite match criteria.",
            ));
        }
    }
    Ok(())
}

enum ResolvedTarget {
    Unique(Value, bool),
    Ambiguous(Vec<Value>, bool, bool),
}

fn resolve_target(
    body: &Value,
    target: &SessionJsonRewriteTarget,
    redactor: &Redactor,
) -> Result<ResolvedTarget, ToolError> {
    let mut matches = Vec::new();
    match target {
        SessionJsonRewriteTarget::Key { key } => {
            if key.len() > 256 || key.chars().any(char::is_control) {
                return Err(ToolError::invalid(
                    "key must be at most 256 bytes and contain no control characters.",
                ));
            }
            if redactor.is_sensitive_name(key) {
                return Err(ToolError::permission_denied(
                    "This JSON field is sensitive.",
                ));
            }
            find_key(body, key, redactor, &mut Vec::new(), &mut matches);
        }
        SessionJsonRewriteTarget::Path { json_path } => {
            let segments = parse_json_paths(std::slice::from_ref(json_path))?.remove(0);
            if segments.is_empty() || segments.contains(&JsonPathSegment::Wildcard) {
                return Err(ToolError::invalid(
                    "jsonPath must select a single existing JSON field.",
                ));
            }
            let mut selected = Some(body);
            for segment in &segments {
                match segment {
                    JsonPathSegment::Key(key) => {
                        if redactor.is_sensitive_name(key) {
                            return Err(ToolError::permission_denied(
                                "This JSON field is sensitive.",
                            ));
                        }
                        selected = selected.and_then(|value| value.as_object()?.get(key));
                    }
                    JsonPathSegment::Index(index) => {
                        selected = selected.and_then(|value| value.get(*index));
                    }
                    JsonPathSegment::Wildcard => unreachable!(),
                }
            }
            if let Some(value) = selected {
                matches.push((render_json_path(&segments), value));
            }
        }
    }
    if matches.is_empty() {
        return Err(ToolError::new(
            "JSON_FIELD_NOT_FOUND",
            "The response does not contain the selected JSON field.",
        ));
    }
    if matches.len() == 1 && (matches[0].1.is_array() || matches[0].1.is_object()) {
        return Err(ToolError::invalid(
            "The selected response field must be a JSON scalar.",
        ));
    }
    let has_more = matches.len() > MAX_CANDIDATES;
    let mut redacted = false;
    let mut candidates = Vec::new();
    for (path, value) in matches.into_iter().take(MAX_CANDIDATES) {
        if path.len() > 1024 || path.chars().any(char::is_control) {
            return Err(ToolError::invalid(
                "A matching JSON path is too long or contains a control character.",
            ));
        }
        let mut candidate = json!({ "jsonPath": path, "valueType": json_type_name(value) });
        if value.is_object()
            || value.is_array()
            || value
                .as_str()
                .is_some_and(|text| text.len() > MAX_PREVIEW_VALUE_BYTES)
        {
            candidate["valueOmitted"] = json!(true);
        } else {
            let mut value = value.clone();
            let mut records = Vec::new();
            redactor.redact_json_value(&mut value, &path, &mut records);
            redacted |= !records.is_empty();
            candidate["value"] = value;
        }
        candidates.push(candidate);
    }
    if candidates.len() == 1 && !has_more {
        return Ok(ResolvedTarget::Unique(candidates.remove(0), redacted));
    }
    Ok(ResolvedTarget::Ambiguous(candidates, has_more, redacted))
}

fn find_key<'a>(
    body: &'a Value,
    target: &str,
    redactor: &Redactor,
    path: &mut Vec<JsonPathSegment>,
    matches: &mut Vec<(String, &'a Value)>,
) {
    match body {
        Value::Object(fields) => {
            for (key, value) in fields {
                if matches.len() > MAX_CANDIDATES {
                    return;
                }
                if redactor.is_sensitive_name(key) {
                    continue;
                }
                path.push(JsonPathSegment::Key(key.clone()));
                if key == target {
                    matches.push((render_json_path(path), value));
                }
                find_key(value, target, redactor, path, matches);
                path.pop();
            }
        }
        Value::Array(items) => {
            for (index, value) in items.iter().enumerate() {
                if matches.len() > MAX_CANDIDATES {
                    return;
                }
                path.push(JsonPathSegment::Index(index));
                find_key(value, target, redactor, path, matches);
                path.pop();
            }
        }
        _ => {}
    }
}
