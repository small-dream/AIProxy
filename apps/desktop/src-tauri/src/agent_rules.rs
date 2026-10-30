use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aiproxy_agent_control::{AgentRuleAction, CreateAgentRuleParams};
use aiproxy_proxy_core::{MapManager, MapRule, RewriteManager, RewriteRule, RewriteRuleMatch};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

const DEFAULT_TTL_SECONDS: u64 = 600;
const MAX_TTL_SECONDS: u64 = 3600;
const MAX_AGENT_RULES: usize = 20;
const MAX_MOCK_BODY_BYTES: usize = 256 * 1024;
const MAX_RULE_TEXT_BYTES: usize = 256 * 1024;
const MAX_PATTERN_BYTES: usize = 2048;
const MAX_HEADER_VALUE_BYTES: usize = 8192;
const MAX_METHODS: usize = 16;
const CLEANUP_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct AgentRuleError {
    pub code: &'static str,
    pub message: String,
}

impl AgentRuleError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_ARGUMENT",
            message: message.into(),
        }
    }

    fn limit(message: impl Into<String>) -> Self {
        Self {
            code: "RULE_LIMIT_EXCEEDED",
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuleInfo {
    pub rule_id: String,
    pub kind: String,
    pub action: String,
    pub name: String,
    pub url_pattern: String,
    pub methods: Vec<String>,
    pub workspace_id: String,
    pub created_by: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveAgentRulesResult {
    pub removed_count: usize,
    pub missing_rule_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearAgentRulesResult {
    pub removed_count: usize,
}

#[derive(Debug, Clone, Default)]
pub struct AgentRuleSnapshot {
    pub by_rule_id: HashMap<String, AgentRuleInfo>,
    pub auxiliary_rule_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
struct AgentRuleRecord {
    info: AgentRuleInfo,
    auxiliary_rule_id: Option<String>,
    mock_file: Option<PathBuf>,
}

#[derive(Debug)]
pub struct AgentRuleRegistry {
    rules: Mutex<Vec<AgentRuleRecord>>,
    data_dir: PathBuf,
    rewrite_manager: Arc<RewriteManager>,
    map_manager: Arc<MapManager>,
}

impl AgentRuleRegistry {
    pub fn new(
        rewrite_manager: Arc<RewriteManager>,
        map_manager: Arc<MapManager>,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            rules: Mutex::new(Vec::new()),
            data_dir,
            rewrite_manager,
            map_manager,
        }
    }

    pub fn spawn_cleanup(self: &Arc<Self>) {
        let registry = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(CLEANUP_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                registry.cleanup_expired();
            }
        });
    }

    pub fn create(
        &self,
        params: CreateAgentRuleParams,
        workspace_id: &str,
        created_by: &str,
    ) -> Result<AgentRuleInfo, AgentRuleError> {
        self.create_at(params, workspace_id, created_by, Utc::now())
    }

    fn create_at(
        &self,
        params: CreateAgentRuleParams,
        workspace_id: &str,
        created_by: &str,
        now: DateTime<Utc>,
    ) -> Result<AgentRuleInfo, AgentRuleError> {
        let pattern = validate_url_pattern(&params.url_pattern)?;
        let methods = normalize_methods(params.methods)?;
        let match_type = normalize_match_type(params.match_type.as_deref())?;
        let ttl_seconds = params.ttl_seconds.unwrap_or(DEFAULT_TTL_SECONDS);
        if ttl_seconds == 0 || ttl_seconds > MAX_TTL_SECONDS {
            return Err(AgentRuleError::invalid(format!(
                "ttlSeconds must be between 1 and {MAX_TTL_SECONDS}."
            )));
        }
        let name = normalize_name(params.name, &params.action, &pattern.host)?;
        let expires_at = now + chrono::Duration::seconds(ttl_seconds as i64);

        let mut rules = self.rules.lock().unwrap_or_else(|error| error.into_inner());
        self.cleanup_expired_locked(&mut rules, now);
        if rules.len() >= MAX_AGENT_RULES {
            return Err(AgentRuleError::limit(format!(
                "At most {MAX_AGENT_RULES} temporary Agent rules may be active. Remove one before creating another."
            )));
        }

        let rule_id = format!("agent-{}", uuid::Uuid::new_v4().simple());
        let auxiliary_rule_id = params
            .action
            .needs_content_type_rule()
            .then(|| format!("agent-meta-{}", uuid::Uuid::new_v4().simple()));
        let priority = u32::MAX.saturating_sub(rules.len() as u32);
        let mut prepared = self.prepare_action(
            &params.action,
            &rule_id,
            auxiliary_rule_id.as_deref(),
            priority,
            workspace_id,
            &pattern.raw,
            &methods,
            match_type.as_deref(),
        )?;
        if let Some(rule) = prepared.rewrite_rule.as_mut() {
            rule.name = name.clone();
        }
        if let Some(rule) = prepared.map_rule.as_mut() {
            rule.name = name.clone();
        }
        if let Some(rule) = prepared.auxiliary_rewrite_rule.as_mut() {
            rule.name = format!("{name} (Content-Type)");
        }

        if let Some(body) = prepared.mock_body.as_deref() {
            self.write_mock_file(&rule_id, body)?;
        }
        if let Some(rule) = prepared.rewrite_rule {
            self.rewrite_manager
                .save_rule_with_host_lock(rule, pattern.host.clone());
        }
        if let Some(rule) = prepared.map_rule {
            self.map_manager
                .save_rule_with_host_lock(rule, pattern.host.clone());
        }
        if let Some(rule) = prepared.auxiliary_rewrite_rule {
            self.rewrite_manager
                .save_rule_with_host_lock(rule, pattern.host.clone());
        }

        let info = AgentRuleInfo {
            rule_id: rule_id.clone(),
            kind: prepared.kind.to_string(),
            action: params.action.kind().to_string(),
            name,
            url_pattern: pattern.raw,
            methods,
            workspace_id: workspace_id.to_string(),
            created_by: created_by.to_string(),
            created_at: now.to_rfc3339(),
            expires_at: expires_at.to_rfc3339(),
        };
        rules.push(AgentRuleRecord {
            info: info.clone(),
            auxiliary_rule_id,
            mock_file: prepared.mock_body.map(|_| self.mock_file_path(&rule_id)),
        });
        Ok(info)
    }

    pub fn list(&self) -> Vec<AgentRuleInfo> {
        let mut rules = self.rules.lock().unwrap_or_else(|error| error.into_inner());
        self.cleanup_expired_locked(&mut rules, Utc::now());
        rules
            .iter()
            .map(|record| record.info.clone())
            .collect::<Vec<_>>()
    }

    pub fn snapshot(&self) -> AgentRuleSnapshot {
        let mut rules = self.rules.lock().unwrap_or_else(|error| error.into_inner());
        self.cleanup_expired_locked(&mut rules, Utc::now());
        let mut snapshot = AgentRuleSnapshot::default();
        for record in rules.iter() {
            snapshot
                .by_rule_id
                .insert(record.info.rule_id.clone(), record.info.clone());
            if let Some(id) = &record.auxiliary_rule_id {
                snapshot.auxiliary_rule_ids.insert(id.clone());
            }
        }
        snapshot
    }

    pub fn remove(&self, rule_ids: Vec<String>) -> RemoveAgentRulesResult {
        self.remove_at(rule_ids, Utc::now())
    }

    fn remove_at(&self, rule_ids: Vec<String>, now: DateTime<Utc>) -> RemoveAgentRulesResult {
        let mut rules = self.rules.lock().unwrap_or_else(|error| error.into_inner());
        self.cleanup_expired_locked(&mut rules, now);
        let mut requested = rule_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        requested.sort_unstable();
        requested.dedup();

        let mut found = HashSet::new();
        let mut kept = Vec::with_capacity(rules.len());
        for record in rules.drain(..) {
            if requested.iter().any(|id| id == &record.info.rule_id) {
                found.insert(record.info.rule_id.clone());
                self.remove_record_side_effects(&record, true);
            } else {
                kept.push(record);
            }
        }
        *rules = kept;
        RemoveAgentRulesResult {
            removed_count: found.len(),
            missing_rule_ids: requested
                .into_iter()
                .filter(|id| !found.contains(id))
                .collect(),
        }
    }

    pub fn clear(&self) -> ClearAgentRulesResult {
        let mut rules = self.rules.lock().unwrap_or_else(|error| error.into_inner());
        self.cleanup_expired_locked(&mut rules, Utc::now());
        let removed_count = rules.len();
        for record in rules.drain(..) {
            self.remove_record_side_effects(&record, true);
        }
        ClearAgentRulesResult { removed_count }
    }

    /// Forget metadata after another command has already deleted the primary
    /// rule from its manager. Auxiliary rules and mock files still belong to us.
    pub fn forget_deleted_rule(&self, rule_id: &str) {
        let mut rules = self.rules.lock().unwrap_or_else(|error| error.into_inner());
        let Some(index) = rules
            .iter()
            .position(|record| record.info.rule_id == rule_id)
        else {
            return;
        };
        let record = rules.remove(index);
        self.remove_record_side_effects(&record, false);
    }

    pub fn cleanup_expired(&self) -> usize {
        let mut rules = self.rules.lock().unwrap_or_else(|error| error.into_inner());
        self.cleanup_expired_locked(&mut rules, Utc::now())
    }

    pub fn contains_rule(&self, rule_id: &str) -> bool {
        self.rules
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .any(|record| record.info.rule_id == rule_id)
    }

    fn cleanup_expired_locked(
        &self,
        rules: &mut Vec<AgentRuleRecord>,
        now: DateTime<Utc>,
    ) -> usize {
        let mut expired = Vec::new();
        rules.retain(|record| {
            let keep = DateTime::parse_from_rfc3339(&record.info.expires_at)
                .map(|expires_at| expires_at.with_timezone(&Utc) > now)
                .unwrap_or(false);
            if !keep {
                expired.push(record.clone());
            }
            keep
        });
        for record in &expired {
            self.remove_record_side_effects(record, true);
        }
        expired.len()
    }

    fn remove_record_side_effects(&self, record: &AgentRuleRecord, delete_primary: bool) {
        if delete_primary {
            self.rewrite_manager.delete_rule(&record.info.rule_id);
            self.map_manager.delete_rule(&record.info.rule_id);
        }
        if let Some(rule_id) = &record.auxiliary_rule_id {
            self.rewrite_manager.delete_rule(rule_id);
        }
        if let Some(path) = &record.mock_file {
            if let Err(error) = fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        component = "desktop.agent_rules",
                        event = "agent_mock_file_remove_failed",
                        rule_id = %record.info.rule_id,
                        path = %path.display(),
                        error = %error,
                        "agent_mock_file_remove_failed"
                    );
                }
            }
        }
    }

    fn mock_file_path(&self, rule_id: &str) -> PathBuf {
        self.data_dir
            .join("agent-rules")
            .join(format!("{rule_id}.body"))
    }

    fn write_mock_file(&self, rule_id: &str, body: &[u8]) -> Result<(), AgentRuleError> {
        let directory = self.data_dir.join("agent-rules");
        fs::create_dir_all(&directory).map_err(|error| {
            AgentRuleError::invalid(format!(
                "Create Agent rule directory {}: {error}",
                directory.display()
            ))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
        }
        let path = self.mock_file_path(rule_id);
        fs::write(&path, body).map_err(|error| {
            AgentRuleError::invalid(format!("Write Agent mock body {}: {error}", path.display()))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_action(
        &self,
        action: &AgentRuleAction,
        rule_id: &str,
        auxiliary_rule_id: Option<&str>,
        priority: u32,
        workspace_id: &str,
        url_pattern: &str,
        methods: &[String],
        match_type: Option<&str>,
    ) -> Result<PreparedRule, AgentRuleError> {
        let rewrite_context = RewriteRuleSpec {
            id: rule_id,
            workspace_id,
            url_pattern,
            methods,
            match_type,
            priority,
        };
        let make_rewrite =
            |rewrite_type: &str, action: Value| rewrite_rule(rewrite_context, rewrite_type, action);
        match action {
            AgentRuleAction::SetRequestHeader { name, value } => {
                let name = validate_header_name(name)?;
                let value = validate_header_value(value)?;
                Ok(PreparedRule::rewrite(
                    make_rewrite(
                        "header",
                        json!({
                            "rewriteType": "header",
                            "payload": {
                                "headerName": name,
                                "operation": "set",
                                "target": "request",
                                "value": value,
                            }
                        }),
                    ),
                    "rewrite",
                ))
            }
            AgentRuleAction::RemoveRequestHeader { name } => {
                let name = validate_header_name(name)?;
                Ok(PreparedRule::rewrite(
                    make_rewrite(
                        "header",
                        json!({
                            "rewriteType": "header",
                            "payload": {
                                "headerName": name,
                                "operation": "remove",
                                "target": "request",
                            }
                        }),
                    ),
                    "rewrite",
                ))
            }
            AgentRuleAction::SetQueryParam { name, value } => {
                let name = validate_query_name(name)?;
                let value = validate_query_value(value)?;
                Ok(PreparedRule::rewrite(
                    make_rewrite(
                        "query",
                        json!({
                            "rewriteType": "query",
                            "payload": {
                                "operation": "set",
                                "paramName": name,
                                "value": value,
                            }
                        }),
                    ),
                    "rewrite",
                ))
            }
            AgentRuleAction::RemoveQueryParam { name } => {
                let name = validate_query_name(name)?;
                Ok(PreparedRule::rewrite(
                    make_rewrite(
                        "query",
                        json!({
                            "rewriteType": "query",
                            "payload": {
                                "operation": "remove",
                                "paramName": name,
                            }
                        }),
                    ),
                    "rewrite",
                ))
            }
            AgentRuleAction::SetResponseHeader { name, value } => {
                let name = validate_header_name(name)?;
                let value = validate_header_value(value)?;
                Ok(PreparedRule::rewrite(
                    make_rewrite(
                        "header",
                        json!({
                            "rewriteType": "header",
                            "payload": {
                                "headerName": name,
                                "operation": "set",
                                "target": "response",
                                "value": value,
                            }
                        }),
                    ),
                    "rewrite",
                ))
            }
            AgentRuleAction::RemoveResponseHeader { name } => {
                let name = validate_header_name(name)?;
                Ok(PreparedRule::rewrite(
                    make_rewrite(
                        "header",
                        json!({
                            "rewriteType": "header",
                            "payload": {
                                "headerName": name,
                                "operation": "remove",
                                "target": "response",
                            }
                        }),
                    ),
                    "rewrite",
                ))
            }
            AgentRuleAction::ReplaceResponseBody { content_type, body } => {
                let content_type = validate_content_type(content_type)?;
                validate_text_size("response body", body, MAX_RULE_TEXT_BYTES)?;
                Ok(PreparedRule::rewrite(
                    make_rewrite(
                        "body",
                        json!({
                            "rewriteType": "body",
                            "payload": {
                                "contentType": content_type,
                                "mode": "replace",
                                "target": "response",
                                "text": body,
                            }
                        }),
                    ),
                    "rewrite",
                ))
            }
            AgentRuleAction::SetResponseJsonFields { fields } => {
                if fields.is_empty() {
                    return Err(AgentRuleError::invalid(
                        "setResponseJsonFields requires at least one field.",
                    ));
                }
                if fields.len() > 100 {
                    return Err(AgentRuleError::invalid(
                        "setResponseJsonFields accepts at most 100 fields.",
                    ));
                }
                let mut edits = Vec::with_capacity(fields.len());
                for (path, value) in fields {
                    validate_json_path(path)?;
                    edits.push(json!({
                        "operation": "set",
                        "path": path,
                        "value": serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
                        "valueType": "json",
                    }));
                }
                Ok(PreparedRule::rewrite(
                    make_rewrite(
                        "body",
                        json!({
                            "rewriteType": "body",
                            "payload": {
                                "contentType": "application/json",
                                "fields": edits,
                                "mode": "fields",
                                "target": "response",
                            }
                        }),
                    ),
                    "rewrite",
                ))
            }
            AgentRuleAction::MapRemote {
                target_url,
                preserve_path,
                preserve_query,
            } => {
                let source = validate_url_pattern(url_pattern)?;
                let target = Url::parse(target_url).map_err(|error| {
                    AgentRuleError::invalid(format!("mapRemote targetUrl is invalid: {error}"))
                })?;
                if !matches!(target.scheme(), "http" | "https") {
                    return Err(AgentRuleError::invalid(
                        "mapRemote targetUrl must use http or https.",
                    ));
                }
                let target_host = target.host_str().ok_or_else(|| {
                    AgentRuleError::invalid("mapRemote targetUrl must include a host.")
                })?;
                if !target_host.eq_ignore_ascii_case(&source.host) {
                    return Err(AgentRuleError::invalid(format!(
                        "mapRemote may only target the matched host '{}'; it cannot rewrite to '{}'.",
                        source.host, target_host
                    )));
                }
                Ok(PreparedRule {
                    kind: "map",
                    rewrite_rule: None,
                    map_rule: Some(MapRule {
                        id: rule_id.to_string(),
                        enabled: true,
                        mode: "remote".to_string(),
                        name: rule_id.to_string(),
                        note: Some("Temporary Agent rule".to_string()),
                        preserve_path: *preserve_path,
                        preserve_query: *preserve_query,
                        priority,
                        source_pattern: url_pattern.to_string(),
                        target_value: target.to_string(),
                        match_type: match_type.map(str::to_string),
                        workspace_id: workspace_id.to_string(),
                    }),
                    auxiliary_rewrite_rule: None,
                    mock_body: None,
                })
            }
            AgentRuleAction::MockResponseBody { body, content_type } => {
                validate_text_size("mock body", body, MAX_MOCK_BODY_BYTES)?;
                let content_type = content_type
                    .as_deref()
                    .map(validate_content_type)
                    .transpose()?;
                let auxiliary = match (auxiliary_rule_id, content_type.as_deref()) {
                    (Some(id), Some(content_type)) => Some(rewrite_rule(
                        RewriteRuleSpec {
                            id,
                            workspace_id,
                            url_pattern,
                            methods,
                            match_type,
                            priority,
                        },
                        "header",
                        json!({
                            "rewriteType": "header",
                            "payload": {
                                "headerName": "content-type",
                                "operation": "set",
                                "target": "response",
                                "value": content_type,
                            }
                        }),
                    )),
                    _ => None,
                };
                Ok(PreparedRule {
                    kind: "map",
                    rewrite_rule: None,
                    map_rule: Some(MapRule {
                        id: rule_id.to_string(),
                        enabled: true,
                        mode: "local".to_string(),
                        name: rule_id.to_string(),
                        note: Some("Temporary Agent rule".to_string()),
                        preserve_path: false,
                        preserve_query: false,
                        priority,
                        source_pattern: url_pattern.to_string(),
                        target_value: self.mock_file_path(rule_id).to_string_lossy().into_owned(),
                        match_type: match_type.map(str::to_string),
                        workspace_id: workspace_id.to_string(),
                    }),
                    auxiliary_rewrite_rule: auxiliary,
                    mock_body: Some(body.as_bytes().to_vec()),
                })
            }
        }
    }
}

struct PreparedRule {
    kind: &'static str,
    rewrite_rule: Option<RewriteRule>,
    map_rule: Option<MapRule>,
    auxiliary_rewrite_rule: Option<RewriteRule>,
    mock_body: Option<Vec<u8>>,
}

impl PreparedRule {
    fn rewrite(rule: RewriteRule, kind: &'static str) -> Self {
        Self {
            kind,
            rewrite_rule: Some(rule),
            map_rule: None,
            auxiliary_rewrite_rule: None,
            mock_body: None,
        }
    }
}

#[derive(Debug)]
struct HostPattern {
    raw: String,
    host: String,
}

fn validate_url_pattern(pattern: &str) -> Result<HostPattern, AgentRuleError> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.len() > MAX_PATTERN_BYTES {
        return Err(AgentRuleError::invalid(format!(
            "urlPattern must be 1-{MAX_PATTERN_BYTES} bytes."
        )));
    }
    if pattern.chars().any(char::is_control) || pattern.chars().any(char::is_whitespace) {
        return Err(AgentRuleError::invalid(
            "urlPattern must not contain whitespace or control characters.",
        ));
    }
    let parse_target = if pattern.contains("://") {
        pattern.to_string()
    } else {
        format!("https://{pattern}")
    };
    let url = Url::parse(&parse_target)
        .map_err(|error| AgentRuleError::invalid(format!("urlPattern is invalid: {error}")))?;
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
        return Err(AgentRuleError::invalid(
            "urlPattern must use http, https, ws, or wss.",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AgentRuleError::invalid("urlPattern must include an exact host."))?
        .to_ascii_lowercase();
    if host.contains('*') {
        return Err(AgentRuleError::invalid(
            "urlPattern must contain an exact host; wildcard hosts are not allowed.",
        ));
    }
    Ok(HostPattern {
        raw: url.to_string(),
        host,
    })
}

fn normalize_match_type(value: Option<&str>) -> Result<Option<String>, AgentRuleError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Some("wildcard".to_string()));
    };
    match value {
        "contains" => Err(AgentRuleError::invalid(
            "matchType=contains is not available to Agent rules. Use wildcard or exact.",
        )),
        "exact" | "wildcard" => Ok(Some(value.to_string())),
        "regex" => Err(AgentRuleError::invalid(
            "matchType=regex is not available to Agent rules because the exact host cannot be audited safely.",
        )),
        _ => Err(AgentRuleError::invalid(
            "matchType must be wildcard or exact.",
        )),
    }
}

fn normalize_methods(methods: Vec<String>) -> Result<Vec<String>, AgentRuleError> {
    if methods.len() > MAX_METHODS {
        return Err(AgentRuleError::invalid(format!(
            "methods accepts at most {MAX_METHODS} entries."
        )));
    }
    let mut methods = methods
        .into_iter()
        .map(|method| method.trim().to_ascii_uppercase())
        .collect::<Vec<_>>();
    methods.sort_unstable();
    methods.dedup();
    if methods.iter().any(|method| {
        method.is_empty()
            || method.len() > 32
            || !method.bytes().all(is_http_token_byte)
            || method == "*"
    }) {
        return Err(AgentRuleError::invalid(
            "methods must contain valid HTTP method names.",
        ));
    }
    Ok(methods)
}

fn normalize_name(
    name: Option<String>,
    action: &AgentRuleAction,
    host: &str,
) -> Result<String, AgentRuleError> {
    let name = name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("Agent {} {}", action.kind(), host));
    if name.len() > 128 || name.chars().any(char::is_control) {
        return Err(AgentRuleError::invalid(
            "name must be 1-128 bytes without control characters.",
        ));
    }
    Ok(name)
}

fn validate_header_name(value: &str) -> Result<String, AgentRuleError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || value.starts_with(':')
        || !value.bytes().all(is_http_token_byte)
        || value.eq_ignore_ascii_case("host")
    {
        return Err(AgentRuleError::invalid(
            "Header names must be valid non-pseudo header names and cannot change Host.",
        ));
    }
    Ok(value.to_string())
}

fn validate_header_value(value: &str) -> Result<String, AgentRuleError> {
    if value.len() > MAX_HEADER_VALUE_BYTES || value.contains('\r') || value.contains('\n') {
        return Err(AgentRuleError::invalid(format!(
            "Header values must be at most {MAX_HEADER_VALUE_BYTES} bytes without CR/LF."
        )));
    }
    Ok(value.to_string())
}

fn validate_query_name(value: &str) -> Result<String, AgentRuleError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(AgentRuleError::invalid(
            "Query parameter names must be 1-256 bytes without control characters.",
        ));
    }
    Ok(value.to_string())
}

fn validate_query_value(value: &str) -> Result<String, AgentRuleError> {
    if value.len() > MAX_HEADER_VALUE_BYTES || value.chars().any(char::is_control) {
        return Err(AgentRuleError::invalid(format!(
            "Query parameter values must be at most {MAX_HEADER_VALUE_BYTES} bytes without control characters."
        )));
    }
    Ok(value.to_string())
}

fn validate_content_type(value: &str) -> Result<String, AgentRuleError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 256
        || value.contains('\r')
        || value.contains('\n')
        || !value.contains('/')
    {
        return Err(AgentRuleError::invalid(
            "contentType must be a valid MIME type.",
        ));
    }
    Ok(value.to_string())
}

fn validate_json_path(path: &str) -> Result<(), AgentRuleError> {
    let path = path.trim();
    if path.is_empty() || path.len() > 512 || path.chars().any(char::is_control) {
        return Err(AgentRuleError::invalid(
            "jsonSet paths must be 1-512 bytes without control characters.",
        ));
    }
    Ok(())
}

fn validate_text_size(label: &str, value: &str, max_bytes: usize) -> Result<(), AgentRuleError> {
    if value.len() > max_bytes {
        return Err(AgentRuleError::invalid(format!(
            "{label} must be at most {max_bytes} bytes."
        )));
    }
    Ok(())
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

#[derive(Clone, Copy)]
struct RewriteRuleSpec<'a> {
    id: &'a str,
    workspace_id: &'a str,
    url_pattern: &'a str,
    methods: &'a [String],
    match_type: Option<&'a str>,
    priority: u32,
}

fn rewrite_rule(spec: RewriteRuleSpec<'_>, rewrite_type: &str, action: Value) -> RewriteRule {
    let RewriteRuleSpec {
        id,
        workspace_id,
        url_pattern,
        methods,
        match_type,
        priority,
    } = spec;
    let stage = if rewrite_type == "query" {
        "request".to_string()
    } else {
        action_stage(&action)
    };
    RewriteRule {
        actions: Some(vec![action]),
        id: id.to_string(),
        enabled: true,
        name: id.to_string(),
        note: Some("Temporary Agent rule".to_string()),
        priority,
        r#match: RewriteRuleMatch {
            methods: methods.to_vec(),
            stage,
            url_pattern: url_pattern.to_string(),
            match_type: match_type.map(str::to_string),
        },
        rewrite_type: rewrite_type.to_string(),
        workspace_id: workspace_id.to_string(),
        payload: Value::Null,
    }
}

fn action_stage(action: &Value) -> String {
    action
        .get("payload")
        .and_then(|payload| payload.get("target"))
        .and_then(Value::as_str)
        .unwrap_or("request")
        .to_string()
}

trait AgentRuleActionExt {
    fn needs_content_type_rule(&self) -> bool;
}

impl AgentRuleActionExt for AgentRuleAction {
    fn needs_content_type_rule(&self) -> bool {
        matches!(
            self,
            AgentRuleAction::MockResponseBody {
                content_type: Some(_),
                ..
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn registry() -> (tempfile::TempDir, AgentRuleRegistry) {
        let directory = tempfile::tempdir().unwrap();
        let rewrite = Arc::new(RewriteManager::new());
        let map = Arc::new(MapManager::new());
        let registry = AgentRuleRegistry::new(rewrite, map, directory.path().to_path_buf());
        (directory, registry)
    }

    fn params(action: AgentRuleAction) -> CreateAgentRuleParams {
        CreateAgentRuleParams {
            url_pattern: "https://api.example.com/v1/*".to_string(),
            methods: vec!["post".to_string()],
            name: None,
            ttl_seconds: Some(60),
            match_type: None,
            action,
        }
    }

    #[test]
    fn creates_rewrite_rule_and_lists_only_registered_agent_rules() {
        let (_directory, registry) = registry();
        registry.rewrite_manager.save_rule(RewriteRule {
            actions: Some(Vec::new()),
            id: "user-rule".to_string(),
            enabled: true,
            name: "User rule".to_string(),
            note: None,
            priority: 1,
            r#match: RewriteRuleMatch {
                methods: Vec::new(),
                stage: "request".to_string(),
                url_pattern: "example.com".to_string(),
                match_type: None,
            },
            rewrite_type: "header".to_string(),
            workspace_id: "default".to_string(),
            payload: Value::Null,
        });

        let info = registry
            .create(
                params(AgentRuleAction::SetRequestHeader {
                    name: "x-agent".to_string(),
                    value: "1".to_string(),
                }),
                "default",
                "test-agent",
            )
            .unwrap();

        assert_eq!(info.kind, "rewrite");
        assert_eq!(info.methods, vec!["POST"]);
        assert_eq!(registry.list().len(), 1);
        assert!(registry
            .rewrite_manager
            .list_rules()
            .iter()
            .any(|rule| rule.id == "user-rule"));
        assert!(registry
            .rewrite_manager
            .list_rules()
            .iter()
            .any(|rule| rule.id == info.rule_id));
    }

    #[test]
    fn rejects_wildcard_host_regex_and_cross_host_map_targets() {
        let (_directory, registry) = registry();
        let mut wildcard = params(AgentRuleAction::RemoveRequestHeader {
            name: "x-test".to_string(),
        });
        wildcard.url_pattern = "https://*.example.com/*".to_string();
        assert_eq!(
            registry
                .create(wildcard, "default", "agent")
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );

        let mut regex = params(AgentRuleAction::RemoveRequestHeader {
            name: "x-test".to_string(),
        });
        regex.match_type = Some("regex".to_string());
        assert!(registry.create(regex, "default", "agent").is_err());

        let mut contains = params(AgentRuleAction::RemoveRequestHeader {
            name: "x-test".to_string(),
        });
        contains.match_type = Some("contains".to_string());
        let error = registry.create(contains, "default", "agent").unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("wildcard or exact"));

        let cross_host = params(AgentRuleAction::MapRemote {
            target_url: "https://staging.example.com/v1".to_string(),
            preserve_path: true,
            preserve_query: true,
        });
        assert!(registry.create(cross_host, "default", "agent").is_err());
    }

    #[test]
    fn default_match_type_is_wildcard_and_pattern_is_normalized() {
        let (_directory, registry) = registry();
        let info = registry
            .create(
                params(AgentRuleAction::RemoveRequestHeader {
                    name: "x-test".to_string(),
                }),
                "default",
                "agent",
            )
            .unwrap();

        assert_eq!(info.url_pattern, "https://api.example.com/v1/*");
        let rule = registry
            .rewrite_manager
            .list_rules()
            .into_iter()
            .find(|rule| rule.id == info.rule_id)
            .unwrap();
        assert_eq!(rule.r#match.match_type.as_deref(), Some("wildcard"));
    }

    #[test]
    fn mock_rule_writes_and_cleans_up_its_body_file() {
        let (_directory, registry) = registry();
        let now = Utc::now();
        let info = registry
            .create_at(
                params(AgentRuleAction::MockResponseBody {
                    body: r#"{"ok":true}"#.to_string(),
                    content_type: Some("application/json".to_string()),
                }),
                "default",
                "agent",
                now,
            )
            .unwrap();
        let mock_path = registry.mock_file_path(&info.rule_id);
        assert_eq!(fs::read_to_string(&mock_path).unwrap(), r#"{"ok":true}"#);
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.auxiliary_rule_ids.len(), 1);
        assert!(registry
            .rewrite_manager
            .list_rules()
            .iter()
            .any(|rule| rule.r#match.stage == "response"));

        let removed = registry.remove_at(vec![info.rule_id.clone()], now);
        assert_eq!(removed.removed_count, 1);
        assert!(!mock_path.exists());
        assert!(registry.map_manager.list_rules().is_empty());
        assert!(registry.rewrite_manager.list_rules().is_empty());
    }

    #[test]
    fn ttl_cleanup_removes_expired_rules_and_files() {
        let (_directory, registry) = registry();
        let now = Utc::now();
        let info = registry
            .create_at(
                params(AgentRuleAction::MockResponseBody {
                    body: "expired".to_string(),
                    content_type: None,
                }),
                "default",
                "agent",
                now,
            )
            .unwrap();
        let mock_path = registry.mock_file_path(&info.rule_id);
        assert!(mock_path.exists());

        let removed = registry.cleanup_expired_locked(
            &mut registry.rules.lock().unwrap(),
            now + chrono::Duration::seconds(61),
        );
        assert_eq!(removed, 1);
        assert!(!mock_path.exists());
        assert!(registry.list().is_empty());
    }

    #[test]
    fn enforces_rule_limit() {
        let (_directory, registry) = registry();
        for index in 0..MAX_AGENT_RULES {
            registry
                .create(
                    params(AgentRuleAction::SetRequestHeader {
                        name: format!("x-rule-{index}"),
                        value: "1".to_string(),
                    }),
                    "default",
                    "agent",
                )
                .unwrap();
        }
        let error = registry
            .create(
                params(AgentRuleAction::SetRequestHeader {
                    name: "x-over-limit".to_string(),
                    value: "1".to_string(),
                }),
                "default",
                "agent",
            )
            .unwrap_err();
        assert_eq!(error.code, "RULE_LIMIT_EXCEEDED");
    }

    #[test]
    fn json_payload_fields_keep_typed_values() {
        let (_directory, registry) = registry();
        let mut action = AgentRuleAction::SetResponseJsonFields {
            fields: BTreeMap::new(),
        };
        if let AgentRuleAction::SetResponseJsonFields { fields } = &mut action {
            fields.insert("data.enabled".to_string(), Value::Bool(true));
            fields.insert("data.count".to_string(), json!(3));
        }
        registry.create(params(action), "default", "agent").unwrap();
        let rule = registry.rewrite_manager.list_rules().pop().unwrap();
        let actions = rule.actions.unwrap();
        assert_eq!(actions[0]["payload"]["fields"][0]["valueType"], "json");
    }

    #[test]
    fn agent_rules_do_not_survive_registry_restart() {
        let directory = tempfile::tempdir().unwrap();
        let rewrite_manager = Arc::new(RewriteManager::new());
        let map_manager = Arc::new(MapManager::new());
        let registry = AgentRuleRegistry::new(
            Arc::clone(&rewrite_manager),
            Arc::clone(&map_manager),
            directory.path().to_path_buf(),
        );
        registry
            .create(
                params(AgentRuleAction::SetRequestHeader {
                    name: "x-agent".to_string(),
                    value: "1".to_string(),
                }),
                "default",
                "codex",
            )
            .unwrap();
        assert_eq!(registry.list().len(), 1);
        assert_eq!(rewrite_manager.list_rules().len(), 1);

        drop(registry);
        drop(rewrite_manager);
        drop(map_manager);

        let restarted = AgentRuleRegistry::new(
            Arc::new(RewriteManager::new()),
            Arc::new(MapManager::new()),
            directory.path().to_path_buf(),
        );
        assert!(restarted.list().is_empty());
        assert!(restarted.snapshot().by_rule_id.is_empty());
    }
}
