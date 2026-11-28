use aiproxy_agent_control::ExtendSessionJsonRewriteParams;
use serde::Deserialize;

use super::*;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenewalReceipt {
    additional_seconds: u64,
    previous_expires_at: String,
    activated_at: String,
    expires_at: String,
    runtime_generation: u64,
    reactivated: bool,
}

impl RenewalReceipt {
    fn result(&self, target: &SessionRewriteTarget, idempotent: bool) -> Value {
        json!({
            "status": if target.change.status == "active"
                && target.change.expires_at.as_deref().and_then(parse_time)
                    .is_some_and(|deadline| deadline > Utc::now()) {
                "active"
            } else {
                "expired"
            },
            "ruleId": target.rule.id, "changeId": target.change.id,
            "previousExpiresAt": self.previous_expires_at, "expiresAt": self.expires_at,
            "activatedAt": self.activated_at, "reactivated": self.reactivated,
            "runtimeGeneration": self.runtime_generation, "idempotent": idempotent,
        })
    }
}

impl AppState {
    pub(crate) async fn extend_session_json_rewrite(
        &self,
        params: ExtendSessionJsonRewriteParams,
        caller: (&str, &str),
        permissions: AutomationPermissions,
    ) -> Result<Value, AutomationError> {
        if !permissions.manage_automation {
            return Err(AutomationError::new(
                "CONTROL_PERMISSION_DENIED",
                "manageAutomation is disabled.",
            ));
        }
        if params.rule_id.is_empty()
            || params.rule_id.len() > 128
            || !(60..=3600).contains(&params.additional_seconds)
            || !(MIN_IDEMPOTENCY_KEY_BYTES..=MAX_IDEMPOTENCY_KEY_BYTES)
                .contains(&params.idempotency_key.len())
        {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "ruleId is required, additionalSeconds must be 60–3600, and idempotencyKey must be 16–128 bytes.",
            ));
        }
        let _proxy = self.proxy_op_lock().lock().await;
        let _automation = self.automation_mutation_lock().lock().await;
        let (mut target, metadata) = self.load_renewal_target(&params.rule_id)?;
        let mut summary: Value =
            serde_json::from_str(&target.change.summary_json).map_err(|error| {
                AutomationError::internal(format!("decode renewal history: {error}"))
            })?;
        let receipt_key = hash_json(&json!(params.idempotency_key))?;
        if let Some(receipt) = summary["renewals"].get(&receipt_key) {
            let receipt: RenewalReceipt =
                serde_json::from_value(receipt.clone()).map_err(|error| {
                    AutomationError::internal(format!("decode renewal receipt: {error}"))
                })?;
            if receipt.additional_seconds != params.additional_seconds {
                return Err(AutomationError::new(
                    "IDEMPOTENCY_CONFLICT",
                    "idempotencyKey was already used to extend this rule by a different duration.",
                ));
            }
            return Ok(receipt.result(&target, true));
        }

        let now = Utc::now();
        let previous_expires_at = target
            .change
            .expires_at
            .clone()
            .ok_or_else(|| AutomationError::internal("Temporary rewrite has no expiry."))?;
        let previous_expiry = parse_time(&previous_expires_at)
            .ok_or_else(|| AutomationError::internal("Temporary rewrite has an invalid expiry."))?;
        let was_active = target.change.status == "active" && previous_expiry > now;
        let expired_by_lifecycle = match target.change.status.as_str() {
            "active" => previous_expiry <= now,
            // The cleanup task only reverts ephemeral changes at their deadline.
            "reverted" => previous_expiry <= now,
            // Restart cleanup preserves the activation time. A publication
            // that failed before the rule became active has no such time.
            "aborted" => target.change.activated_at.is_some(),
            _ => false,
        };
        if !was_active && !expired_by_lifecycle {
            return Err(AutomationError::new(
                "CHANGE_NOT_APPLICABLE",
                "Only active or expired session rewrites can be extended.",
            ));
        }

        let workspace_id = target.rule.workspace_id.as_str();
        let status = self.read_status();
        if status.active_workspace_id.as_deref() != Some(workspace_id) {
            return Err(AutomationError::new(
                "SCOPE_CONFLICT",
                "Select the workspace that owns this temporary rewrite first.",
            ));
        }
        let preflight = if was_active {
            self.ensure_verification_targets_current(&target.change)?;
            None
        } else {
            if !status.running {
                let mut result = capture_stopped();
                result["ruleId"] = json!(target.rule.id);
                result["changeId"] = json!(target.change.id);
                return Ok(result);
            }
            let preflight = self.session_rewrite_preflight(
                &status,
                workspace_id,
                &target.method,
                &target.pattern,
            )?;
            if preflight["code"] == "HTTP2_BODY_REWRITE_UNSUPPORTED" {
                return Ok(json!({
                    "status": "blocked", "ruleId": target.rule.id,
                    "changeId": target.change.id, "preflight": preflight,
                }));
            }
            Some(preflight)
        };

        // Bound the remaining lifetime, including any time still on the rule.
        let expires_at = if was_active { previous_expiry } else { now }
            + chrono::Duration::seconds(params.additional_seconds as i64);
        if expires_at > now + chrono::Duration::hours(1) {
            return Err(AutomationError::new(
                "TTL_LIMIT_EXCEEDED",
                "The resulting remaining lifetime must not exceed 3600 seconds.",
            ));
        }
        let activated_at = if was_active {
            target.change.activated_at.clone().ok_or_else(|| {
                AutomationError::internal("Active rewrite has no activation time.")
            })?
        } else {
            now.to_rfc3339()
        };
        let host_lock = exact_pattern_host(target.pattern.as_str(), "session rewrite URL")?;
        let manager = self.read_rewrite_manager();
        let generation = manager.runtime_generation().saturating_add(1);
        let receipt = RenewalReceipt {
            additional_seconds: params.additional_seconds,
            previous_expires_at,
            activated_at: activated_at.clone(),
            expires_at: expires_at.to_rfc3339(),
            runtime_generation: generation,
            reactivated: !was_active,
        };
        if summary.get("renewals").is_none() {
            summary["renewals"] = json!({});
        }
        summary["renewals"][receipt_key] = serde_json::to_value(&receipt).map_err(|error| {
            AutomationError::internal(format!("encode renewal receipt: {error}"))
        })?;
        target.change.summary_json = summary.to_string();
        target.change.status = "active".into();
        target.change.activated_at = Some(activated_at);
        target.change.reverted_at = None;
        target.change.expires_at = Some(receipt.expires_at.clone());
        target.change.runtime_generation = Some(generation);

        let now_text = now.to_rfc3339();
        let mut metadata = metadata.unwrap_or_else(|| AutomationResourceRow {
            resource_kind: "rewrite".into(),
            resource_id: target.rule.id.clone(),
            scope: target.change.scope.clone(),
            scope_key: target.change.scope_key.clone(),
            workspace_id: target.change.workspace_id.clone(),
            owner_kind: "agent".into(),
            created_by_client: target
                .change
                .client_name
                .clone()
                .or_else(|| Some(caller.0.into())),
            created_by_version: target
                .change
                .client_version
                .clone()
                .or_else(|| Some(caller.1.into())),
            change_id: Some(target.change.id.clone()),
            expires_at: None,
            created_at: target.change.created_at.clone(),
            updated_at: now_text.clone(),
        });
        metadata.expires_at = Some(receipt.expires_at.clone());
        metadata.updated_at = now_text;

        self.persist_session_rewrite_renewal(&target.change, &metadata, !was_active)?;
        let generation = manager.publish_temporary_rule(target.rule.clone(), host_lock, expires_at);
        self.emit_automation_changed(
            "extend_session_json_rewrite",
            std::slice::from_ref(&target.change.id),
            generation,
        );
        let mut result = receipt.result(&target, false);
        if let Some(preflight) = preflight {
            result["preflight"] = preflight;
        }
        Ok(result)
    }

    fn load_renewal_target(
        &self,
        rule_id: &str,
    ) -> Result<(SessionRewriteTarget, Option<AutomationResourceRow>), AutomationError> {
        let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let db_error =
            |error| AutomationError::internal(format!("load temporary rewrite history: {error}"));
        let metadata =
            automation::load_automation_resource(&conn, "rewrite", rule_id).map_err(db_error)?;
        if metadata
            .as_ref()
            .is_some_and(|value| value.owner_kind != "agent")
        {
            return Err(AutomationError::new(
                "UNSUPPORTED_REWRITE",
                "Only Agent-owned session rewrites can be extended.",
            ));
        }
        let change_id =
            if let Some(change_id) = metadata.as_ref().and_then(|value| value.change_id.clone()) {
                change_id
            } else {
                let history =
                    automation::list_automation_change_ids_for_resource(&conn, "rewrite", rule_id)
                        .map_err(db_error)?;
                let [change_id] = history.as_slice() else {
                    return Err(AutomationError::new(
                        "NOT_FOUND",
                        "No unambiguous temporary rewrite history was found.",
                    ));
                };
                change_id.clone()
            };
        let change = automation::load_automation_change_set(&conn, &change_id)
            .map_err(db_error)?
            .ok_or_else(|| {
                AutomationError::new("NOT_FOUND", "Temporary rewrite change not found.")
            })?;
        let target = load_session_rewrite_target(&conn, change)?;
        if target.rule.id != rule_id {
            return Err(AutomationError::new(
                "NOT_FOUND",
                "Temporary rewrite rule not found in its change.",
            ));
        }
        Ok((target, metadata))
    }

    fn persist_session_rewrite_renewal(
        &self,
        change: &AutomationChangeSetRow,
        resource: &AutomationResourceRow,
        reactivated: bool,
    ) -> Result<(), AutomationError> {
        let mut conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let tx = conn.transaction().map_err(|error| {
            AutomationError::internal(format!("begin temporary rewrite renewal: {error}"))
        })?;
        let db_error =
            |error| AutomationError::internal(format!("save temporary rewrite renewal: {error}"));
        automation::save_automation_renewal(&tx, change).map_err(db_error)?;
        automation::save_automation_resource(&tx, resource).map_err(db_error)?;
        if reactivated {
            automation::update_automation_experiment_state(
                &tx,
                &change.id,
                "running",
                "not_started",
                &resource.updated_at,
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(|error| {
            AutomationError::internal(format!("commit temporary rewrite renewal: {error}"))
        })
    }
}
