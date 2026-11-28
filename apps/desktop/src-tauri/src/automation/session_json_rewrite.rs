use std::collections::BTreeSet;

use aiproxy_agent_control::{
    AutomationRewriteMatch, AutomationUpsert, AutomationUpserts, CreateSessionJsonRewriteParams,
    SessionJsonRewriteMode,
};
use aiproxy_db::sessions::load_session_summary;
use aiproxy_proxy_core::{
    session_rewrite_url_matches, supports_response_body_rewrite, ProxySessionSummary,
    SESSION_REWRITE_MATCH_TYPE,
};
use chrono::{DateTime, Utc};
use url::Url;

use super::*;

const RESOURCE_REF: &str = "session-json-rewrite";

mod renewal;
mod verification;

impl AppState {
    pub(crate) async fn create_session_json_rewrite(
        &self,
        params: CreateSessionJsonRewriteParams,
        caller: (&str, &str),
        permissions: AutomationPermissions,
    ) -> Result<Value, AutomationError> {
        validate_params(&params)?;
        if !permissions.manage_automation {
            return Err(AutomationError::new(
                "CONTROL_PERMISSION_DENIED",
                "manageAutomation is disabled",
            ));
        }

        // Keep the workspace and listener fixed from preflight through publication.
        let _proxy = self.proxy_op_lock().lock().await;
        let _automation = self.automation_mutation_lock().lock().await;
        let status = self.read_status();
        let Some(workspace_id) = status.active_workspace_id.as_deref() else {
            return Ok(capture_stopped());
        };

        let source = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            load_session_summary(&conn, &params.session_id)
                .map_err(|error| {
                    AutomationError::internal(format!("load source session: {error}"))
                })?
                .ok_or_else(|| {
                    AutomationError::new("SESSION_NOT_FOUND", "Source session not found.")
                })?
        };
        let url = Url::parse(&source.url)
            .ok()
            .filter(|url| {
                matches!(url.scheme(), "http" | "https")
                    && url.host().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            })
            .ok_or_else(|| {
                AutomationError::new(
                    "INVALID_ARGUMENT",
                    "Source session must have an HTTP or HTTPS origin.",
                )
            })?;
        if source.method == "CONNECT" || source.status_code == 0 {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "Source session must contain a completed HTTP response.",
            ));
        }
        let query = match resolve_query_keys(&url, params.match_query_keys.as_deref())? {
            Ok(query) => query,
            Err(keys) => {
                return Ok(json!({
                    "status": "needs_input", "code": "QUERY_MATCH_REQUIRED",
                    "queryKeys": keys,
                }));
            }
        };
        let pattern = match_pattern(url, &query);
        let match_scope = json!({
            "scheme": pattern.scheme(), "host": pattern.host_str(),
            "port": pattern.port_or_known_default(), "path": pattern.path(),
            "method": source.method, "queryParams": query, "workspaceId": workspace_id,
        });
        let plan = build_plan(&params, workspace_id, &source.method, &pattern);
        if params.mode == SessionJsonRewriteMode::Create {
            validate_plan_shape(&plan)?;
            if let Some(existing) = self.find_session_rewrite_change(&plan, workspace_id)? {
                return existing_result(&existing, match_scope);
            }
        }
        if !status.running {
            return Ok(capture_stopped());
        }

        let preflight =
            self.session_rewrite_preflight(&status, workspace_id, &source.method, &pattern)?;
        if preflight["code"] == "HTTP2_BODY_REWRITE_UNSUPPORTED" {
            return Ok(
                json!({ "status": "blocked", "match": match_scope, "preflight": preflight }),
            );
        }
        if params.mode == SessionJsonRewriteMode::Preview {
            return Ok(json!({ "status": "ready", "match": match_scope, "preflight": preflight }));
        }

        let mut prepared = self.prepare_automation_plan(&plan, caller, permissions)?;
        let activated = Utc::now();
        let activated_at = activated.to_rfc3339();
        let expires_at =
            (activated + chrono::Duration::seconds(params.ttl_seconds as i64)).to_rfc3339();
        prepared.expires_at = Some(expires_at.clone());
        for item in &mut prepared.items {
            if let Some(metadata) = item.metadata_after.as_mut() {
                metadata.expires_at = Some(expires_at.clone());
            }
        }
        self.commit_prepared_change(&prepared, caller, &HashMap::new())?;
        let generation = match self.publish_runtime(
            Some(workspace_id),
            Some(&prepared.change_id),
            Some((&prepared.change_id, &activated_at)),
        ) {
            Ok(generation) => generation,
            Err(error) => {
                self.abort_session_rewrite(&prepared.change_id)?;
                return Err(AutomationError::new(
                    "RUNTIME_PUBLISH_FAILED",
                    format!("Temporary rewrite was not published: {}", error.message),
                ));
            }
        };
        self.emit_automation_changed(
            "create_session_json_rewrite",
            std::slice::from_ref(&prepared.change_id),
            generation,
        );
        Ok(json!({
            "status": "active",
            "ruleId": prepared.resource_ids_by_ref.get(RESOURCE_REF),
            "changeId": prepared.change_id, "activatedAt": activated_at, "expiresAt": expires_at,
            "runtimeGeneration": generation, "idempotent": false,
            "match": match_scope, "preflight": preflight, "verification": { "status": "pending" },
        }))
    }

    fn find_session_rewrite_change(
        &self,
        plan: &AutomationPlan,
        workspace_id: &str,
    ) -> Result<Option<AutomationChangeSetRow>, AutomationError> {
        let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let change = automation::load_automation_change_by_idempotency(
            &conn,
            &format!("workspace:{workspace_id}"),
            &plan.idempotency_key,
        )
        .map_err(|error| {
            AutomationError::internal(format!("load temporary rewrite idempotency: {error}"))
        })?;
        if let Some(change) = &change {
            let plan_hash = hash_json(&serde_json::to_value(plan).map_err(|error| {
                AutomationError::internal(format!("serialize session rewrite plan: {error}"))
            })?)?;
            if change.plan_hash != plan_hash {
                return Err(AutomationError::new(
                    "IDEMPOTENCY_CONFLICT",
                    "idempotencyKey was already used for a different automation plan.",
                ));
            }
        }
        Ok(change)
    }

    fn abort_session_rewrite(&self, change_id: &str) -> Result<(), AutomationError> {
        let mut conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let tx = conn.transaction().map_err(|error| {
            AutomationError::internal(format!("begin unpublished rewrite cleanup: {error}"))
        })?;
        automation::delete_automation_resources_for_change(&tx, change_id)
            .and_then(|()| {
                automation::update_automation_change_status(
                    &tx,
                    change_id,
                    "aborted",
                    None,
                    None,
                    None,
                    Some(&Utc::now().to_rfc3339()),
                )
            })
            .map_err(|error| {
                AutomationError::internal(format!("abort unpublished rewrite: {error}"))
            })?;
        tx.commit().map_err(|error| {
            AutomationError::internal(format!("commit unpublished rewrite cleanup: {error}"))
        })
    }

    fn session_rewrite_preflight(
        &self,
        status: &crate::bootstrap::BootstrapStatus,
        workspace_id: &str,
        method: &str,
        pattern: &Url,
    ) -> Result<Value, AutomationError> {
        let saved_http2 = self
            .read_workspace_manager()
            .load(workspace_id)
            .map(|workspace| workspace.http2_enabled);
        let evidence = self.current_session_rewrite_evidence(status, method, pattern)?;
        Ok(protocol_preflight(
            workspace_id,
            saved_http2,
            status.http2_enabled,
            evidence.as_ref(),
        ))
    }

    fn current_session_rewrite_evidence(
        &self,
        status: &crate::bootstrap::BootstrapStatus,
        method: &str,
        pattern: &Url,
    ) -> Result<Option<ProxySessionSummary>, AutomationError> {
        let Some(started_at) = status.started_at.as_deref().and_then(parse_time) else {
            return Ok(None);
        };
        // The desktop has one local capture listener at a time. The listener
        // start boundary excludes sessions from the preceding workspace/runtime.
        let mut candidates = self.read_sessions();
        candidates.retain(|session| {
            session.status_code > 0
                && session.method == method
                && session
                    .host
                    .eq_ignore_ascii_case(pattern.host_str().unwrap_or_default())
                && parse_time(&session.started_at).is_some_and(|time| time >= started_at)
                && Url::parse(&session.url)
                    .is_ok_and(|url| session_rewrite_url_matches(pattern, &url))
        });
        candidates.sort_by_key(|session| {
            (
                !is_http2(&session.http_version),
                std::cmp::Reverse(parse_time(&session.started_at)),
            )
        });
        for session in candidates {
            let detail = self
                .read_session_detail(&session.id)
                .map_err(AutomationError::internal)?;
            if detail.is_some_and(|value| value.timing_source.as_deref() != Some("agentReplay")) {
                return Ok(Some(session));
            }
        }
        Ok(None)
    }
}

struct SessionRewriteTarget {
    change: AutomationChangeSetRow,
    rule: RewriteRule,
    pattern: Url,
    method: String,
    path: String,
    expected: Value,
}

fn load_session_rewrite_target(
    conn: &aiproxy_db::rusqlite::Connection,
    change: AutomationChangeSetRow,
) -> Result<SessionRewriteTarget, AutomationError> {
    let unsupported = || {
        AutomationError::new(
            "UNSUPPORTED_REWRITE",
            "The requested change does not own a temporary session JSON rewrite.",
        )
    };
    let summary: Value = serde_json::from_str(&change.summary_json).map_err(|_| unsupported())?;
    let rule_id = summary["resourceIdsByRef"][RESOURCE_REF]
        .as_str()
        .filter(|_| change.lifecycle == "ephemeral" && change.scope == "workspace")
        .ok_or_else(unsupported)?;
    let items = automation::load_automation_change_items(conn, &change.id)
        .map_err(|error| AutomationError::internal(format!("load session rewrite: {error}")))?;
    let [item] = items.as_slice() else {
        return Err(unsupported());
    };
    let rule: RewriteRule = item
        .after_json
        .as_deref()
        .filter(|_| {
            item.resource_kind == "rewrite"
                && item.operation == "create"
                && item.resource_id == rule_id
        })
        .and_then(|value| serde_json::from_str(value).ok())
        .ok_or_else(unsupported)?;
    let [method] = rule.r#match.methods.as_slice() else {
        return Err(unsupported());
    };
    let pattern = Url::parse(&rule.r#match.url_pattern)
        .ok()
        .filter(|url| url.has_host() && matches!(url.scheme(), "http" | "https"))
        .filter(|_| {
            rule.enabled
                && rule.id == rule_id
                && change.workspace_id.as_deref() == Some(rule.workspace_id.as_str())
                && rule.r#match.stage == "response"
                && rule.r#match.match_type.as_deref() == Some(SESSION_REWRITE_MATCH_TYPE)
        })
        .ok_or_else(unsupported)?;
    let [action] = rule.actions.as_deref().unwrap_or_default() else {
        return Err(unsupported());
    };
    let fields = &action["payload"]["fields"];
    let [field] = fields.as_array().map(Vec::as_slice).unwrap_or_default() else {
        return Err(unsupported());
    };
    let path = field["path"]
        .as_str()
        .filter(|_| {
            action["rewriteType"] == "body"
                && action["payload"]["target"] == "response"
                && action["payload"]["mode"] == "existingFields"
                && field["operation"] == "set"
                && field["valueType"] == "json"
        })
        .ok_or_else(unsupported)?
        .to_owned();
    let expected: Value = field["value"]
        .as_str()
        .and_then(|value| serde_json::from_str(value).ok())
        .filter(|value: &Value| !value.is_object() && !value.is_array())
        .ok_or_else(unsupported)?;
    Ok(SessionRewriteTarget {
        change,
        method: method.clone(),
        rule,
        pattern,
        path,
        expected,
    })
}

fn validate_params(params: &CreateSessionJsonRewriteParams) -> Result<(), AutomationError> {
    if params.session_id.is_empty()
        || params.json_path == "$"
        || !params.json_path.starts_with('$')
        || params.json_path.len() > 1024
        || params.value.is_array()
        || params.value.is_object()
        || params
            .value
            .as_str()
            .is_some_and(|value| value.len() > 64 * 1024)
        || !(60..=3600).contains(&params.ttl_seconds)
    {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "Invalid session JSON rewrite parameters.",
        ));
    }
    aiproxy_proxy_core::validate_json_field_path(&params.json_path).map_err(|_| {
        AutomationError::new("JSON_PATH_INVALID", "Invalid single-field JSON path.")
    })?;
    Ok(())
}

fn capture_stopped() -> Value {
    json!({
        "status": "blocked", "preflight": {
            "code": "CAPTURE_STOPPED", "appRunning": true, "controlAvailable": true,
            "recommendedAction": "Start capture in the target workspace.",
        },
    })
}

fn resolve_query_keys(
    url: &Url,
    requested: Option<&[String]>,
) -> Result<Result<BTreeMap<String, String>, Vec<String>>, AutomationError> {
    let pairs = url.query_pairs().collect::<Vec<_>>();
    let default = ["_method".to_owned()];
    let keys = match requested {
        Some(keys) => keys,
        None if pairs.is_empty() => &[],
        None if pairs.iter().filter(|(key, _)| key == "_method").count() == 1 => &default,
        None => {
            let names = pairs
                .iter()
                .map(|(key, _)| key.to_string())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .take(20)
                .collect();
            return Ok(Err(names));
        }
    };
    if keys.len() > 20 {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "matchQueryKeys accepts at most 20 keys.",
        ));
    }
    let mut query = BTreeMap::new();
    for key in keys {
        let mut values = pairs.iter().filter(|(name, _)| name == key);
        let value = values.next().filter(|(_, value)| value.len() <= 1024);
        if let Some((_, value)) = value {
            if !key.is_empty()
                && key.len() <= 128
                && values.next().is_none()
                && query.insert(key.clone(), value.to_string()).is_none()
            {
                continue;
            }
        }
        return Err(AutomationError::new(
            "QUERY_PARAM_INVALID",
            "Each match key must appear exactly once in both the input and captured query.",
        ));
    }
    Ok(Ok(query))
}

fn match_pattern(mut url: Url, query: &BTreeMap<String, String>) -> Url {
    url.set_query(None);
    url.set_fragment(None);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    url
}

fn build_plan(
    params: &CreateSessionJsonRewriteParams,
    workspace_id: &str,
    method: &str,
    pattern: &Url,
) -> AutomationPlan {
    AutomationPlan {
        scope: "workspace".to_owned(),
        workspace_id: Some(workspace_id.to_owned()),
        lifecycle: "ephemeral".to_owned(),
        ttl_seconds: Some(params.ttl_seconds),
        idempotency_key: params.idempotency_key.clone().unwrap_or_default(),
        upserts: AutomationUpserts {
            rewrite: vec![AutomationUpsert {
                id: None,
                expected_version: None,
                r#ref: Some(RESOURCE_REF.to_owned()),
                resource: AutomationRewriteResource {
                    enabled: Some(true),
                    name: "Session JSON response rewrite".to_owned(),
                    note: Some(format!("Source session {}", params.session_id)),
                    priority: 0,
                    r#match: AutomationRewriteMatch {
                        methods: vec![method.to_owned()],
                        stage: "response".to_owned(),
                        url_pattern: pattern.to_string(),
                        match_type: Some(SESSION_REWRITE_MATCH_TYPE.to_owned()),
                    },
                    rewrite_type: Some("body".to_owned()),
                    payload: Value::Null,
                    actions: vec![json!({
                        "rewriteType": "body",
                        "payload": {
                            "target": "response", "contentType": "application/json",
                            "mode": "existingFields",
                            "fields": [{
                                "operation": "set", "path": params.json_path,
                                "valueType": "json", "value": params.value.to_string(),
                            }],
                        },
                    })],
                },
            }],
            ..AutomationUpserts::default()
        },
        ..AutomationPlan::default()
    }
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.to_utc())
}

fn is_http2(version: &str) -> bool {
    matches!(version, "2" | "2.0" | "HTTP/2" | "h2")
}

fn protocol_preflight(
    workspace_id: &str,
    saved_http2: Option<bool>,
    runtime_http2: bool,
    evidence: Option<&ProxySessionSummary>,
) -> Value {
    let mut result = json!({
        "workspaceId": workspace_id, "savedHttp2Enabled": saved_http2,
        "runtimeHttp2Enabled": runtime_http2, "appRunning": true, "controlAvailable": true,
        "observedProtocol": evidence.map(|session| if is_http2(&session.http_version) {
            "h2"
        } else {
            session.http_version.as_str()
        }),
        "evidenceSessionId": evidence.map(|session| &session.id),
    });
    if !supports_response_body_rewrite(true) {
        if evidence.is_some_and(|session| is_http2(&session.http_version)) {
            result["code"] = json!("HTTP2_BODY_REWRITE_UNSUPPORTED");
            result["recommendedAction"] = json!(if saved_http2 == Some(false) {
                "Reapply the workspace's saved HTTP/2-off setting, then retry."
            } else {
                "Disable HTTP/2 for the workspace and restart capture, then retry."
            });
        } else if runtime_http2 {
            result["warnings"] = json!(["HTTP2_MAY_SKIP_BODY_REWRITE"]);
        }
    }
    result
}

fn existing_result(
    change: &AutomationChangeSetRow,
    match_scope: Value,
) -> Result<Value, AutomationError> {
    if change.status != "active"
        || change
            .expires_at
            .as_deref()
            .and_then(parse_time)
            .is_none_or(|deadline| deadline <= Utc::now())
    {
        return Err(AutomationError::new(
            "CHANGE_NOT_APPLICABLE",
            "This temporary rewrite is no longer active. Use a new idempotencyKey to create another rule.",
        ).with_details(json!({ "changeId": change.id })));
    }
    let summary: Value = serde_json::from_str(&change.summary_json).map_err(|error| {
        AutomationError::internal(format!("read temporary rewrite summary: {error}"))
    })?;
    Ok(json!({
        "status": "active", "ruleId": summary["resourceIdsByRef"][RESOURCE_REF],
        "changeId": change.id, "activatedAt": change.activated_at, "expiresAt": change.expires_at,
        "runtimeGeneration": change.runtime_generation, "idempotent": true,
        "match": match_scope, "verification": { "status": "pending" },
    }))
}

#[cfg(test)]
#[path = "session_json_rewrite_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "session_json_rewrite_lifecycle_tests.rs"]
mod lifecycle_tests;
