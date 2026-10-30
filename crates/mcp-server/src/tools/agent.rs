use std::collections::BTreeMap;

use aiproxy_agent_control::{
    AgentRuleAction, ControlOperation, CreateAgentRuleParams, HeaderOverride, QueryParamOverride,
    RemoveAgentRulesParams, ReplaySessionParams,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use url::Url;

use crate::context::AppContext;
use crate::control_client::{call_control, ControlCaller};
use crate::protocol::{ToolError, ToolMeta};
use crate::tools::control::{ensure_audit, ensure_permission, ToolResult};

const MAX_HEADER_VALUE_BYTES: usize = 8192;
const MAX_OVERRIDE_ENTRIES: usize = 100;
const MAX_JSON_SET_FIELDS: usize = 50;
const MAX_JSON_SET_PATH_BYTES: usize = 512;
const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_PATTERN_BYTES: usize = 2048;
const MAX_AGENT_RULES: usize = 20;
const MAX_METHODS: usize = 16;
const MAX_TTL_SECONDS: u64 = 3600;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaySessionRequest {
    /// Exact id of a captured HTTP session. Connection-only failures cannot be replayed.
    pub session_id: String,
    /// Optional HTTP method override. Defaults to the captured method.
    pub method: Option<String>,
    /// Headers to set or replace, matched case-insensitively by name. Host, pseudo, and hop-by-hop headers are ignored by the sender.
    #[serde(default)]
    pub set_headers: Vec<HeaderOverrideRequest>,
    /// Header names to remove case-insensitively. The Host header cannot be removed from the target lock.
    #[serde(default)]
    pub remove_headers: Vec<String>,
    /// Query parameters to set or replace by exact, case-sensitive name. Entries not listed are preserved.
    #[serde(default)]
    pub set_query_params: Vec<QueryParamRequest>,
    /// Complete UTF-8 request body override. Omit to replay the captured bytes, including binary payloads.
    pub body: Option<String>,
    /// JSON fields to set in the request body, addressed as data.items[0].id. Requires a JSON body after `body` or the original body is applied.
    #[serde(default)]
    pub json_set: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeaderOverrideRequest {
    /// Case-insensitive header name; must not be Host or an HTTP/2 pseudo-header.
    pub name: String,
    /// Header value without CR/LF.
    pub value: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryParamRequest {
    /// Exact case-sensitive query parameter name.
    pub name: String,
    /// Replacement value; the sender URL-encodes it.
    pub value: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAgentRuleRequest {
    /// URL pattern that must contain an exact host, for example https://api.example.com/v1/*. Wildcard hosts and regex matching are rejected.
    pub url_pattern: String,
    /// Optional uppercase-normalized HTTP methods. Empty means all methods.
    #[serde(default)]
    pub methods: Vec<String>,
    /// Optional rule label shown in the AIProxy rules page.
    pub name: Option<String>,
    /// Lifetime in seconds, default 600, maximum 3600.
    pub ttl_seconds: Option<u64>,
    /// Matching mode: wildcard (default) or exact. Contains and regex are unavailable to Agent rules.
    pub match_type: Option<String>,
    /// Whitelisted temporary rule action.
    pub action: AgentRuleActionRequest,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentRuleActionRequest {
    /// Set a request header.
    SetRequestHeader {
        /// Header name; Host and pseudo-headers are rejected.
        name: String,
        /// Header value without CR/LF.
        value: String,
    },
    /// Remove a request header by case-insensitive name.
    RemoveRequestHeader {
        /// Header name to remove; Host and pseudo-headers are rejected.
        name: String,
    },
    /// Set a request query parameter.
    SetQueryParam {
        /// Exact case-sensitive query parameter name.
        name: String,
        /// Replacement value.
        value: String,
    },
    /// Remove a request query parameter by exact case-sensitive name.
    RemoveQueryParam {
        /// Query parameter name to remove.
        name: String,
    },
    /// Set a response header.
    SetResponseHeader {
        /// Response header name.
        name: String,
        /// Response header value without CR/LF.
        value: String,
    },
    /// Remove a response header by case-insensitive name.
    RemoveResponseHeader {
        /// Response header name to remove.
        name: String,
    },
    /// Replace the complete response body.
    ReplaceResponseBody {
        /// Response MIME type, for example application/json.
        content_type: String,
        /// Replacement UTF-8 body, maximum 256 KiB.
        body: String,
    },
    /// Set fields in a JSON response body using data.items[0].id paths.
    SetResponseJsonFields {
        /// JSON path to value pairs, at most 100 entries.
        fields: BTreeMap<String, Value>,
    },
    /// Map to another URL on the same exact host.
    MapRemote {
        /// Absolute http/https target URL whose host must match urlPattern.
        target_url: String,
        /// Preserve the original request path beneath the target base path.
        preserve_path: bool,
        /// Preserve the original query string.
        preserve_query: bool,
    },
    /// Serve a temporary local response body.
    MockResponseBody {
        /// UTF-8 mock body, maximum 256 KiB.
        body: String,
        /// Optional response MIME type applied with a companion response-header rule.
        content_type: Option<String>,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveAgentRulesRequest {
    /// One to twenty temporary Agent rule ids to remove. Unknown ids are reported, not errors.
    pub rule_ids: Vec<String>,
}

pub async fn replay_session(
    state: &AppContext,
    request: ReplaySessionRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let params = validate_replay_request(request)?;
    let operation = ControlOperation::ReplaySession(params);
    ensure_control_permission(state, &operation)?;
    ensure_audit(state)?;
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn create_agent_rule(
    state: &AppContext,
    request: CreateAgentRuleRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let params = validate_create_rule_request(request)?;
    let operation = ControlOperation::CreateAgentRule(params);
    ensure_control_permission(state, &operation)?;
    ensure_audit(state)?;
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn list_agent_rules(state: &AppContext, caller: ControlCaller<'_>) -> ToolResult {
    let operation = ControlOperation::ListAgentRules;
    ensure_control_permission(state, &operation)?;
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

pub async fn remove_agent_rules(
    state: &AppContext,
    request: RemoveAgentRulesRequest,
    caller: ControlCaller<'_>,
) -> ToolResult {
    let rule_ids = validate_rule_ids(request.rule_ids)?;
    let operation = ControlOperation::RemoveAgentRules(RemoveAgentRulesParams { rule_ids });
    ensure_control_permission(state, &operation)?;
    ensure_audit(state)?;
    let value = call_control(&state.paths, operation, true, caller).await?;
    Ok((value, ToolMeta::new(false, false, None)))
}

fn ensure_control_permission(
    state: &AppContext,
    operation: &ControlOperation,
) -> Result<(), ToolError> {
    let config = state.config()?;
    ensure_permission(&config, operation)
}

fn validate_replay_request(
    request: ReplaySessionRequest,
) -> Result<ReplaySessionParams, ToolError> {
    let session_id = validate_trimmed("sessionId", request.session_id, 256)?;
    let method = request
        .method
        .map(|method| {
            let method = method.trim().to_ascii_uppercase();
            if method.is_empty() || method.len() > 32 || !is_http_token(&method) {
                return Err(ToolError::invalid("method must be a valid HTTP method."));
            }
            Ok(method)
        })
        .transpose()?;
    if request.set_headers.len() > MAX_OVERRIDE_ENTRIES
        || request.remove_headers.len() > MAX_OVERRIDE_ENTRIES
        || request.set_query_params.len() > MAX_OVERRIDE_ENTRIES
    {
        return Err(ToolError::invalid(format!(
            "Each replay override list accepts at most {MAX_OVERRIDE_ENTRIES} entries."
        )));
    }
    let set_headers = request
        .set_headers
        .into_iter()
        .map(|header| {
            Ok(HeaderOverride {
                name: validate_header_name(&header.name)?,
                value: validate_header_value(&header.value, "Header")?,
            })
        })
        .collect::<Result<Vec<_>, ToolError>>()?;
    let remove_headers = request
        .remove_headers
        .into_iter()
        .map(|name| validate_header_name(&name))
        .collect::<Result<Vec<_>, ToolError>>()?;
    let set_query_params = request
        .set_query_params
        .into_iter()
        .map(|entry| {
            Ok(QueryParamOverride {
                name: validate_query_name(&entry.name)?,
                value: validate_query_value(&entry.value)?,
            })
        })
        .collect::<Result<Vec<_>, ToolError>>()?;
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > 1024 * 1024)
    {
        return Err(ToolError::invalid("body override must be at most 1 MiB."));
    }
    if request.json_set.len() > MAX_JSON_SET_FIELDS {
        return Err(ToolError::invalid(format!(
            "jsonSet accepts at most {MAX_JSON_SET_FIELDS} fields."
        )));
    }
    for path in request.json_set.keys() {
        if path.trim().is_empty() || path.len() > MAX_JSON_SET_PATH_BYTES {
            return Err(ToolError::invalid(format!(
                "jsonSet paths must be 1-{MAX_JSON_SET_PATH_BYTES} bytes."
            )));
        }
    }
    Ok(ReplaySessionParams {
        session_id,
        method,
        set_headers,
        remove_headers,
        set_query_params,
        body: request.body,
        json_set: request.json_set,
    })
}

fn validate_create_rule_request(
    request: CreateAgentRuleRequest,
) -> Result<CreateAgentRuleParams, ToolError> {
    let url_pattern = request.url_pattern.trim().to_string();
    if url_pattern.is_empty() || url_pattern.len() > MAX_PATTERN_BYTES {
        return Err(ToolError::invalid(format!(
            "urlPattern must be 1-{MAX_PATTERN_BYTES} bytes."
        )));
    }
    if url_pattern.chars().any(char::is_control) || url_pattern.chars().any(char::is_whitespace) {
        return Err(ToolError::invalid(
            "urlPattern must not contain whitespace or control characters.",
        ));
    }
    let source_host = pattern_host(&url_pattern)?;
    if request.methods.len() > MAX_METHODS {
        return Err(ToolError::invalid(format!(
            "methods accepts at most {MAX_METHODS} entries."
        )));
    }
    let mut methods = request
        .methods
        .into_iter()
        .map(|method| method.trim().to_ascii_uppercase())
        .collect::<Vec<_>>();
    methods.sort_unstable();
    methods.dedup();
    if methods
        .iter()
        .any(|method| method.is_empty() || method.len() > 32 || !is_http_token(method))
    {
        return Err(ToolError::invalid(
            "methods must contain valid HTTP method names.",
        ));
    }
    let name = request.name.map(|name| name.trim().to_string());
    if name
        .as_ref()
        .is_some_and(|name| name.is_empty() || name.len() > 128)
    {
        return Err(ToolError::invalid(
            "name must be 1-128 bytes when supplied.",
        ));
    }
    if let Some(ttl_seconds) = request.ttl_seconds {
        if ttl_seconds == 0 || ttl_seconds > MAX_TTL_SECONDS {
            return Err(ToolError::invalid(format!(
                "ttlSeconds must be between 1 and {MAX_TTL_SECONDS}."
            )));
        }
    }
    let match_type = match request.match_type.as_deref().map(str::trim) {
        None | Some("") | Some("wildcard") => Some("wildcard".to_string()),
        Some("exact") => Some("exact".to_string()),
        Some("contains") => {
            return Err(ToolError::invalid(
                "matchType=contains is not available to Agent rules. Use wildcard or exact.",
            ))
        }
        Some("regex") => {
            return Err(ToolError::invalid(
                "matchType=regex is not available because Agent rules must pin an exact host.",
            ))
        }
        Some(_) => return Err(ToolError::invalid("matchType must be wildcard or exact.")),
    };
    let action = validate_action(request.action, &source_host)?;
    Ok(CreateAgentRuleParams {
        url_pattern,
        methods,
        match_type,
        name,
        ttl_seconds: request.ttl_seconds,
        action,
    })
}

fn validate_action(
    action: AgentRuleActionRequest,
    source_host: &str,
) -> Result<AgentRuleAction, ToolError> {
    match action {
        AgentRuleActionRequest::SetRequestHeader { name, value } => {
            Ok(AgentRuleAction::SetRequestHeader {
                name: validate_header_name(&name)?,
                value: validate_header_value(&value, "Header")?,
            })
        }
        AgentRuleActionRequest::RemoveRequestHeader { name } => {
            Ok(AgentRuleAction::RemoveRequestHeader {
                name: validate_header_name(&name)?,
            })
        }
        AgentRuleActionRequest::SetQueryParam { name, value } => {
            Ok(AgentRuleAction::SetQueryParam {
                name: validate_query_name(&name)?,
                value: validate_query_value(&value)?,
            })
        }
        AgentRuleActionRequest::RemoveQueryParam { name } => {
            Ok(AgentRuleAction::RemoveQueryParam {
                name: validate_query_name(&name)?,
            })
        }
        AgentRuleActionRequest::SetResponseHeader { name, value } => {
            Ok(AgentRuleAction::SetResponseHeader {
                name: validate_header_name(&name)?,
                value: validate_header_value(&value, "Header")?,
            })
        }
        AgentRuleActionRequest::RemoveResponseHeader { name } => {
            Ok(AgentRuleAction::RemoveResponseHeader {
                name: validate_header_name(&name)?,
            })
        }
        AgentRuleActionRequest::ReplaceResponseBody { content_type, body } => {
            validate_content_type(&content_type)?;
            validate_body_size(&body)?;
            Ok(AgentRuleAction::ReplaceResponseBody { content_type, body })
        }
        AgentRuleActionRequest::SetResponseJsonFields { fields } => {
            if fields.is_empty() || fields.len() > 100 {
                return Err(ToolError::invalid(
                    "setResponseJsonFields requires 1-100 fields.",
                ));
            }
            for path in fields.keys() {
                if path.trim().is_empty() || path.len() > MAX_JSON_SET_PATH_BYTES {
                    return Err(ToolError::invalid(format!(
                        "JSON field paths must be 1-{MAX_JSON_SET_PATH_BYTES} bytes."
                    )));
                }
            }
            Ok(AgentRuleAction::SetResponseJsonFields { fields })
        }
        AgentRuleActionRequest::MapRemote {
            target_url,
            preserve_path,
            preserve_query,
        } => {
            if target_url.len() > MAX_PATTERN_BYTES {
                return Err(ToolError::invalid(format!(
                    "targetUrl must be at most {MAX_PATTERN_BYTES} bytes."
                )));
            }
            let target = Url::parse(&target_url)
                .map_err(|error| ToolError::invalid(format!("targetUrl is invalid: {error}")))?;
            if !matches!(target.scheme(), "http" | "https") {
                return Err(ToolError::invalid("targetUrl must use http or https."));
            }
            let target_host = target
                .host_str()
                .ok_or_else(|| ToolError::invalid("targetUrl must include a host."))?;
            if !target_host.eq_ignore_ascii_case(source_host) {
                return Err(ToolError::invalid(format!(
                    "mapRemote may only target the matched host '{source_host}', not '{target_host}'."
                )));
            }
            Ok(AgentRuleAction::MapRemote {
                target_url,
                preserve_path,
                preserve_query,
            })
        }
        AgentRuleActionRequest::MockResponseBody { body, content_type } => {
            validate_body_size(&body)?;
            if let Some(content_type) = content_type.as_deref() {
                validate_content_type(content_type)?;
            }
            Ok(AgentRuleAction::MockResponseBody { body, content_type })
        }
    }
}

fn validate_rule_ids(rule_ids: Vec<String>) -> Result<Vec<String>, ToolError> {
    if rule_ids.is_empty() || rule_ids.len() > MAX_AGENT_RULES {
        return Err(ToolError::invalid(format!(
            "remove_agent_rules accepts 1-{MAX_AGENT_RULES} rule ids per call."
        )));
    }
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::with_capacity(rule_ids.len());
    for rule_id in rule_ids {
        let rule_id = validate_trimmed("ruleId", rule_id, 256)?;
        if seen.insert(rule_id.clone()) {
            ids.push(rule_id);
        }
    }
    Ok(ids)
}

fn pattern_host(pattern: &str) -> Result<String, ToolError> {
    let target = if pattern.contains("://") {
        pattern.to_string()
    } else {
        format!("https://{pattern}")
    };
    let url = Url::parse(&target)
        .map_err(|error| ToolError::invalid(format!("urlPattern is invalid: {error}")))?;
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
        return Err(ToolError::invalid(
            "urlPattern must use http, https, ws, or wss.",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ToolError::invalid("urlPattern must include an exact host."))?
        .to_ascii_lowercase();
    if host.contains('*') {
        return Err(ToolError::invalid(
            "urlPattern must contain an exact host; wildcard hosts are not allowed.",
        ));
    }
    Ok(host)
}

fn validate_trimmed(field: &str, value: String, max_bytes: usize) -> Result<String, ToolError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.len() > max_bytes {
        return Err(ToolError::invalid(format!(
            "{field} must be 1-{max_bytes} bytes."
        )));
    }
    Ok(value)
}

fn validate_header_name(value: &str) -> Result<String, ToolError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || value.starts_with(':')
        || !is_http_token(value)
        || value.eq_ignore_ascii_case("host")
    {
        return Err(ToolError::invalid(
            "Header names must be valid non-pseudo header names and cannot be Host.",
        ));
    }
    Ok(value.to_string())
}

fn validate_header_value(value: &str, label: &str) -> Result<String, ToolError> {
    if value.len() > MAX_HEADER_VALUE_BYTES || value.contains('\r') || value.contains('\n') {
        return Err(ToolError::invalid(format!(
            "{label} values must be at most {MAX_HEADER_VALUE_BYTES} bytes without CR/LF."
        )));
    }
    Ok(value.to_string())
}

fn validate_query_name(value: &str) -> Result<String, ToolError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(ToolError::invalid(
            "Query parameter names must be 1-256 bytes without control characters.",
        ));
    }
    Ok(value.to_string())
}

fn validate_query_value(value: &str) -> Result<String, ToolError> {
    if value.len() > MAX_HEADER_VALUE_BYTES || value.chars().any(char::is_control) {
        return Err(ToolError::invalid(format!(
            "Query parameter values must be at most {MAX_HEADER_VALUE_BYTES} bytes without control characters."
        )));
    }
    Ok(value.to_string())
}

fn validate_content_type(value: &str) -> Result<(), ToolError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || value.contains('\r')
        || value.contains('\n')
        || !value.contains('/')
    {
        return Err(ToolError::invalid("contentType must be a valid MIME type."));
    }
    Ok(())
}

fn validate_body_size(value: &str) -> Result<(), ToolError> {
    if value.len() > MAX_BODY_BYTES {
        return Err(ToolError::invalid(format!(
            "Body content must be at most {MAX_BODY_BYTES} bytes."
        )));
    }
    Ok(())
}

fn is_http_token(value: &str) -> bool {
    value.bytes().all(|byte| {
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replay_validation_rejects_header_injection_and_unknown_paths_are_bounded() {
        let request = ReplaySessionRequest {
            session_id: "session-1".to_string(),
            method: None,
            set_headers: vec![HeaderOverrideRequest {
                name: "x-test".to_string(),
                value: "ok\r\nInjected: 1".to_string(),
            }],
            remove_headers: Vec::new(),
            set_query_params: Vec::new(),
            body: None,
            json_set: BTreeMap::new(),
        };
        assert_eq!(
            validate_replay_request(request).unwrap_err().code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn create_rule_rejects_cross_host_map_targets_and_regex() {
        let request = CreateAgentRuleRequest {
            url_pattern: "https://api.example.com/v1/*".to_string(),
            methods: vec!["post".to_string()],
            name: None,
            ttl_seconds: Some(60),
            match_type: None,
            action: AgentRuleActionRequest::MapRemote {
                target_url: "https://staging.example.com/v1".to_string(),
                preserve_path: true,
                preserve_query: true,
            },
        };
        assert!(validate_create_rule_request(request).is_err());

        let request = CreateAgentRuleRequest {
            url_pattern: "https://api.example.com/v1/*".to_string(),
            methods: Vec::new(),
            name: None,
            ttl_seconds: Some(60),
            match_type: Some("regex".to_string()),
            action: AgentRuleActionRequest::RemoveRequestHeader {
                name: "x-test".to_string(),
            },
        };
        assert!(validate_create_rule_request(request).is_err());
    }

    #[test]
    fn create_rule_defaults_to_wildcard_and_rejects_contains() {
        let mut request = CreateAgentRuleRequest {
            url_pattern: "https://api.example.com/v1/*".to_string(),
            methods: Vec::new(),
            name: None,
            ttl_seconds: Some(60),
            match_type: None,
            action: AgentRuleActionRequest::RemoveRequestHeader {
                name: "x-test".to_string(),
            },
        };
        assert_eq!(
            validate_create_rule_request(request)
                .unwrap()
                .match_type
                .as_deref(),
            Some("wildcard")
        );

        request = CreateAgentRuleRequest {
            url_pattern: "https://api.example.com/v1/*".to_string(),
            methods: Vec::new(),
            name: None,
            ttl_seconds: Some(60),
            match_type: Some("contains".to_string()),
            action: AgentRuleActionRequest::RemoveRequestHeader {
                name: "x-test".to_string(),
            },
        };
        let error = validate_create_rule_request(request).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("wildcard or exact"));
    }

    #[test]
    fn action_summary_does_not_include_override_values() {
        let params = ReplaySessionParams {
            session_id: "session-1".to_string(),
            method: Some("POST".to_string()),
            set_headers: vec![HeaderOverride {
                name: "Authorization".to_string(),
                value: "Bearer secret".to_string(),
            }],
            remove_headers: vec!["Cookie".to_string()],
            set_query_params: vec![QueryParamOverride {
                name: "token".to_string(),
                value: "secret".to_string(),
            }],
            body: Some("secret".to_string()),
            json_set: BTreeMap::from([("secret".to_string(), json!("secret"))]),
        };
        let summary = ControlOperation::ReplaySession(params).action_summary();
        assert!(summary.contains("setHeaders"));
        assert!(!summary.contains("Bearer secret"));
        assert!(!summary.contains("secret"));
    }
}
