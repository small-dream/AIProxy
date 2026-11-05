use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use aiproxy_agent_control::{
    ApplyAutomationPlanParams, AutomationAssertion, AutomationAsset, AutomationMapResource,
    AutomationPlan, AutomationRewriteResource, ClearAgentAutomationParams,
    GetAutomationChangeParams, GetAutomationResourceParams, ListAutomationResourcesParams,
    RollbackAutomationChangeParams, ValidateAutomationPlanParams, VerificationRequest,
    VerifyAutomationChangeParams,
};
use aiproxy_db::automation::{
    self, AutomationChangeItemRow, AutomationChangeSetRow, AutomationExperimentRow,
    AutomationResourceRow, AutomationVerificationRow,
};
use aiproxy_proxy_core::{
    evaluate_offline, MapRule, OfflineEvaluationInput, OfflineRequestInput, OfflineResponseInput,
    RewriteRule, RewriteRuleMatch,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Emitter;

use crate::bootstrap::AppState;

const MAX_PLAN_ITEMS: usize = 100;
const MAX_PLAN_BYTES: usize = 3 * 1024 * 1024;
const MAX_ASSET_BYTES: usize = 5 * 1024 * 1024;
const MAX_VERIFICATION_ASSERTIONS: usize = 100;
const MAX_VERIFICATION_REQUESTS: usize = 20;
const MIN_IDEMPOTENCY_KEY_BYTES: usize = 16;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;
const MAX_PROXY_VERIFICATION_BODY_BYTES: usize = 256 * 1024;
const MAX_PROXY_VERIFICATION_REQUESTS_PER_MINUTE: usize = 10;
const PROXY_SESSION_WAIT: Duration = Duration::from_secs(5);

static PROXY_VERIFICATION_TIMES: OnceLock<Mutex<VecDeque<Instant>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct AutomationError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl AutomationError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL_ERROR", message)
    }
}

impl From<String> for AutomationError {
    fn from(value: String) -> Self {
        Self::internal(value)
    }
}

impl From<&str> for AutomationError {
    fn from(value: &str) -> Self {
        Self::internal(value)
    }
}

#[derive(Debug, Clone, Default)]
pub struct AutomationPermissions {
    pub manage_automation: bool,
    pub manage_user_automation: bool,
    pub manage_scripts: bool,
    #[allow(dead_code)] // Reserved until Map Remote becomes writable.
    pub manage_cross_host_mappings: bool,
    pub manage_proxied_verification: bool,
    pub manage_global_automation: bool,
    pub automation_approved_roots: Vec<String>,
    pub proxied_verification_origins: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResourceSummary {
    pub kind: String,
    pub id: String,
    pub version: String,
    pub name: String,
    pub enabled: bool,
    pub priority: u32,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub owner: String,
    pub lifecycle: String,
    pub expires_at: Option<String>,
    pub change_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResourceView {
    #[serde(flatten)]
    pub summary: AutomationResourceSummary,
    pub resource: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPlanResource {
    pub kind: String,
    pub id: Option<String>,
    pub r#ref: Option<String>,
    pub operation: String,
    pub owner: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationValidationResult {
    pub plan_hash: String,
    pub scope_hash: String,
    pub can_apply: bool,
    pub warnings: Vec<String>,
    pub resources: Vec<AutomationPlanResource>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApplyResult {
    pub change_id: String,
    pub status: String,
    pub runtime_generation: u64,
    pub resource_ids_by_ref: BTreeMap<String, String>,
    pub expires_at: Option<String>,
    pub idempotent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResourceList {
    pub items: Vec<AutomationResourceSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationAssertionResult {
    pub id: String,
    pub subject: String,
    pub path: Option<String>,
    pub passed: bool,
    pub message: String,
    pub actual: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationConflictCandidate {
    pub rule_id: String,
    pub rule_name: Option<String>,
    pub priority: u32,
    pub match_type: Option<String>,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub source_pattern: Option<String>,
    pub outcome: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationConflictDiagnostic {
    pub winning_rule_id: Option<String>,
    pub candidates: Vec<AutomationConflictCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationVerificationRequestResult {
    pub r#ref: String,
    pub status: String,
    pub matched_rule_ids: Vec<String>,
    pub assertions: Vec<AutomationAssertionResult>,
    pub evidence_session_ids: Vec<String>,
    pub rule_trace_refs: Vec<String>,
    pub response_status: Option<u16>,
    pub final_url: Option<String>,
    pub conflict: Option<AutomationConflictDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationVerificationResult {
    pub verification_id: Option<String>,
    pub change_id: String,
    pub experiment_id: String,
    pub mode: String,
    pub evidence_level: String,
    pub runtime_generation: u64,
    pub status: String,
    pub requests: Vec<AutomationVerificationRequestResult>,
    pub baseline_session_ids: Vec<String>,
    pub evidence_session_ids: Vec<String>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationChangeView {
    pub change_id: String,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub lifecycle: String,
    pub status: String,
    pub plan_hash: String,
    pub scope_hash_before: String,
    pub scope_hash_after: String,
    pub runtime_generation: Option<u64>,
    pub created_at: String,
    pub activated_at: Option<String>,
    pub expires_at: Option<String>,
    pub items: Vec<AutomationChangeItemView>,
    pub experiment: Option<Value>,
    pub verifications: Vec<Value>,
    pub rollback_scope_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationChangeItemView {
    pub resource_kind: String,
    pub resource_id: String,
    pub operation: String,
    pub version_before: Option<String>,
    pub version_after: Option<String>,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub dependencies: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearAgentAutomationResult {
    pub cleared_change_ids: Vec<String>,
    pub cleared_resource_count: usize,
    pub runtime_generation: u64,
}

#[derive(Debug, Clone)]
enum PreparedResource {
    Rewrite(RewriteRule),
    Map(MapRule),
}

impl PreparedResource {
    fn kind(&self) -> &'static str {
        match self {
            Self::Rewrite(_) => "rewrite",
            Self::Map(_) => "map",
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::Rewrite(rule) => &rule.id,
            Self::Map(rule) => &rule.id,
        }
    }

    fn value(&self) -> Result<Value, AutomationError> {
        match self {
            Self::Rewrite(rule) => serde_json::to_value(rule)
                .map_err(|error| AutomationError::internal(format!("serialize rewrite: {error}"))),
            Self::Map(rule) => serde_json::to_value(rule)
                .map_err(|error| AutomationError::internal(format!("serialize map: {error}"))),
        }
    }

    fn version(&self) -> Result<String, AutomationError> {
        hash_json(&self.value()?)
    }
}

#[derive(Debug, Clone)]
struct PreparedChangeItem {
    resource: PreparedResource,
    operation: String,
    version_before: Option<String>,
    version_after: Option<String>,
    before_json: Option<String>,
    after_json: String,
    metadata_before: Option<AutomationResourceRow>,
    metadata_after: Option<AutomationResourceRow>,
    dependencies_json: String,
}

#[derive(Debug, Clone)]
struct PreparedPlan {
    change_id: String,
    idempotency_key: String,
    lifecycle: String,
    plan_hash: String,
    scope_hash_before: String,
    scope_hash_after: String,
    scope_key: String,
    workspace_id: Option<String>,
    expires_at: Option<String>,
    items: Vec<PreparedChangeItem>,
    resource_ids_by_ref: BTreeMap<String, String>,
    warnings: Vec<String>,
    plan_resources: Vec<AutomationPlanResource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PersistedChangeState {
    Before,
    After,
    Mixed,
}

fn scope_items_from_change_items(
    items: &[AutomationChangeItemRow],
) -> Result<Vec<PreparedChangeItem>, AutomationError> {
    items
        .iter()
        .map(|item| {
            let resource_json = if item.operation == "delete" {
                item.before_json.as_deref()
            } else {
                item.after_json.as_deref()
            }
            .ok_or_else(|| {
                AutomationError::internal(format!(
                    "change item {} {} is missing its resource snapshot",
                    item.resource_kind, item.resource_id
                ))
            })?;
            let resource = match item.resource_kind.as_str() {
                "rewrite" => PreparedResource::Rewrite(
                    serde_json::from_str(resource_json).map_err(|error| {
                        AutomationError::internal(format!("decode rewrite scope snapshot: {error}"))
                    })?,
                ),
                "map" => {
                    PreparedResource::Map(serde_json::from_str(resource_json).map_err(|error| {
                        AutomationError::internal(format!("decode map scope snapshot: {error}"))
                    })?)
                }
                kind => {
                    return Err(AutomationError::internal(format!(
                        "unsupported scope snapshot kind {kind}"
                    )))
                }
            };
            Ok(PreparedChangeItem {
                resource,
                operation: item.operation.clone(),
                version_before: item.version_before.clone(),
                version_after: item.version_after.clone(),
                before_json: item.before_json.clone(),
                after_json: item
                    .after_json
                    .clone()
                    .unwrap_or_else(|| "null".to_string()),
                metadata_before: None,
                metadata_after: None,
                dependencies_json: item.dependencies_json.clone(),
            })
        })
        .collect()
}

impl AppState {
    pub async fn validate_automation_plan(
        &self,
        params: ValidateAutomationPlanParams,
        caller: (&str, &str),
        permissions: AutomationPermissions,
    ) -> Result<AutomationValidationResult, AutomationError> {
        let _guard = self.automation_mutation_lock().lock().await;
        let prepared = self.prepare_automation_plan(&params.plan, caller, permissions)?;
        Ok(AutomationValidationResult {
            plan_hash: prepared.plan_hash,
            scope_hash: prepared.scope_hash_before,
            can_apply: true,
            warnings: prepared.warnings,
            resources: prepared.plan_resources,
            summary: plan_summary(&params.plan),
        })
    }

    pub async fn apply_automation_plan(
        &self,
        params: ApplyAutomationPlanParams,
        caller: (&str, &str),
        permissions: AutomationPermissions,
    ) -> Result<AutomationApplyResult, AutomationError> {
        let _guard = self.automation_mutation_lock().lock().await;
        self.apply_automation_plan_locked(params, caller, permissions)
    }

    pub fn list_automation_resources(
        &self,
        params: ListAutomationResourcesParams,
    ) -> Result<AutomationResourceList, AutomationError> {
        let limit = params.limit.clamp(1, 100) as usize;
        let offset = params
            .cursor
            .as_deref()
            .unwrap_or("0")
            .parse::<usize>()
            .map_err(|_| {
                AutomationError::new("INVALID_ARGUMENT", "cursor must be a numeric offset")
            })?;
        let scope_key = match (params.scope.as_deref(), params.workspace_id.as_deref()) {
            (Some("workspace"), Some(workspace_id)) => Some(format!("workspace:{workspace_id}")),
            (Some("global"), _) => Some("global".to_string()),
            (Some("workspace"), None) => {
                return Err(AutomationError::new(
                    "INVALID_ARGUMENT",
                    "workspaceId is required when scope=workspace",
                ))
            }
            (None, Some(workspace_id)) => Some(format!("workspace:{workspace_id}")),
            (None, None) => None,
            (Some(_), _) => {
                return Err(AutomationError::new(
                    "INVALID_ARGUMENT",
                    "scope must be workspace or global",
                ))
            }
        };
        let kind = params.kind.as_deref();
        if let Some(kind) = kind {
            if !matches!(kind, "rewrite" | "map") {
                return Err(AutomationError::new(
                    "FEATURE_NOT_AVAILABLE",
                    "only rewrite and map resources are available in this release",
                ));
            }
        }
        if let Some(lifecycle) = params.lifecycle.as_deref() {
            if !matches!(lifecycle, "persistent" | "ephemeral") {
                return Err(AutomationError::new(
                    "INVALID_ARGUMENT",
                    "lifecycle must be persistent or ephemeral",
                ));
            }
        }

        let metadata = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::list_automation_resources(
                &conn,
                scope_key.as_deref(),
                kind,
                params.lifecycle.as_deref(),
                10_000,
            )
            .map_err(|error| {
                AutomationError::internal(format!("list automation resources: {error}"))
            })?
        };
        let metadata_by_id: HashMap<(String, String), AutomationResourceRow> = metadata
            .into_iter()
            .map(|row| ((row.resource_kind.clone(), row.resource_id.clone()), row))
            .collect();

        let mut summaries = Vec::new();
        if kind.is_none() || kind == Some("rewrite") {
            for rule in self.read_rewrite_manager().list_rules() {
                if let Some(scope_key) = scope_key.as_deref() {
                    if scope_key != format!("workspace:{}", rule.workspace_id) {
                        continue;
                    }
                }
                let metadata = metadata_by_id.get(&("rewrite".to_string(), rule.id.clone()));
                if metadata.is_some_and(|row| row.owner_kind == "agent")
                    && params.lifecycle.as_deref() == Some("persistent")
                    && metadata.and_then(|row| self.change_lifecycle(row.change_id.as_deref()))
                        == Some("ephemeral")
                {
                    continue;
                }
                if metadata.is_some_and(|row| row.owner_kind == "agent")
                    && params.lifecycle.as_deref() == Some("ephemeral")
                    && metadata.and_then(|row| self.change_lifecycle(row.change_id.as_deref()))
                        != Some("ephemeral")
                {
                    continue;
                }
                summaries.push(resource_summary_for_rewrite(
                    &rule,
                    metadata,
                    self.change_lifecycle(metadata.and_then(|row| row.change_id.as_deref())),
                )?);
            }
        }
        if kind.is_none() || kind == Some("map") {
            for rule in self.read_map_manager().list_rules() {
                if let Some(scope_key) = scope_key.as_deref() {
                    if scope_key != format!("workspace:{}", rule.workspace_id) {
                        continue;
                    }
                }
                let metadata = metadata_by_id.get(&("map".to_string(), rule.id.clone()));
                if metadata.is_some_and(|row| row.owner_kind == "agent")
                    && params.lifecycle.as_deref() == Some("persistent")
                    && metadata.and_then(|row| self.change_lifecycle(row.change_id.as_deref()))
                        == Some("ephemeral")
                {
                    continue;
                }
                if metadata.is_some_and(|row| row.owner_kind == "agent")
                    && params.lifecycle.as_deref() == Some("ephemeral")
                    && metadata.and_then(|row| self.change_lifecycle(row.change_id.as_deref()))
                        != Some("ephemeral")
                {
                    continue;
                }
                summaries.push(resource_summary_for_map(
                    &rule,
                    metadata,
                    self.change_lifecycle(metadata.and_then(|row| row.change_id.as_deref())),
                )?);
            }
        }
        summaries.sort_by(|a, b| {
            b.expires_at
                .is_none()
                .cmp(&a.expires_at.is_none())
                .then_with(|| a.kind.cmp(&b.kind))
                .then_with(|| a.id.cmp(&b.id))
        });
        let total = summaries.len();
        let items = summaries
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let next = offset + items.len();
        Ok(AutomationResourceList {
            items,
            next_cursor: (next < total).then(|| next.to_string()),
        })
    }

    pub fn get_automation_resource(
        &self,
        params: GetAutomationResourceParams,
    ) -> Result<AutomationResourceView, AutomationError> {
        let metadata = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::load_automation_resource(&conn, &params.kind, &params.id).map_err(
                |error| AutomationError::internal(format!("load automation resource: {error}")),
            )?
        };
        match params.kind.as_str() {
            "rewrite" => {
                let rule = self
                    .read_rewrite_manager()
                    .list_rules()
                    .into_iter()
                    .find(|rule| rule.id == params.id)
                    .ok_or_else(|| {
                        AutomationError::new("NOT_FOUND", "rewrite resource not found")
                    })?;
                let summary = resource_summary_for_rewrite(
                    &rule,
                    metadata.as_ref(),
                    self.change_lifecycle(
                        metadata.as_ref().and_then(|row| row.change_id.as_deref()),
                    ),
                )?;
                Ok(AutomationResourceView {
                    summary,
                    resource: serde_json::to_value(rule).map_err(|error| {
                        AutomationError::internal(format!("serialize rewrite resource: {error}"))
                    })?,
                })
            }
            "map" => {
                let rule = self
                    .read_map_manager()
                    .list_rules()
                    .into_iter()
                    .find(|rule| rule.id == params.id)
                    .ok_or_else(|| AutomationError::new("NOT_FOUND", "map resource not found"))?;
                let summary = resource_summary_for_map(
                    &rule,
                    metadata.as_ref(),
                    self.change_lifecycle(
                        metadata.as_ref().and_then(|row| row.change_id.as_deref()),
                    ),
                )?;
                Ok(AutomationResourceView {
                    summary,
                    resource: serde_json::to_value(rule).map_err(|error| {
                        AutomationError::internal(format!("serialize map resource: {error}"))
                    })?,
                })
            }
            _ => Err(AutomationError::new(
                "FEATURE_NOT_AVAILABLE",
                "only rewrite and map resources are available in this release",
            )),
        }
    }

    pub fn get_automation_change(
        &self,
        params: GetAutomationChangeParams,
    ) -> Result<AutomationChangeView, AutomationError> {
        let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let change = automation::load_automation_change_set(&conn, &params.change_id)
            .map_err(|error| AutomationError::internal(format!("load automation change: {error}")))?
            .ok_or_else(|| AutomationError::new("NOT_FOUND", "automation change not found"))?;
        let experiment = automation::load_automation_experiment_by_change(&conn, &change.id)
            .map_err(|error| AutomationError::internal(format!("load experiment: {error}")))?;
        let items = automation::load_automation_change_items(&conn, &change.id)
            .map_err(|error| AutomationError::internal(format!("load change items: {error}")))?;
        let verifications = match experiment.as_ref() {
            Some(experiment) => automation::load_automation_verifications(&conn, &experiment.id)
                .map_err(|error| {
                    AutomationError::internal(format!("load verifications: {error}"))
                })?,
            None => Vec::new(),
        };
        Ok(change_view(change, items, experiment, verifications))
    }

    pub fn list_automation_changes(
        &self,
        limit: u32,
    ) -> Result<Vec<AutomationChangeView>, AutomationError> {
        let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let changes = automation::list_recent_automation_changes(&conn, limit.clamp(1, 50))
            .map_err(|error| {
                AutomationError::internal(format!("list automation changes: {error}"))
            })?;
        changes
            .into_iter()
            .map(|change| {
                let items = automation::load_automation_change_items(&conn, &change.id).map_err(
                    |error| AutomationError::internal(format!("load change items: {error}")),
                )?;
                let experiment = automation::load_automation_experiment_by_change(
                    &conn, &change.id,
                )
                .map_err(|error| AutomationError::internal(format!("load experiment: {error}")))?;
                let verifications = match experiment.as_ref() {
                    Some(experiment) => {
                        automation::load_automation_verifications(&conn, &experiment.id).map_err(
                            |error| {
                                AutomationError::internal(format!("load verifications: {error}"))
                            },
                        )?
                    }
                    None => Vec::new(),
                };
                Ok(change_view(change, items, experiment, verifications))
            })
            .collect()
    }

    pub async fn promote_automation_change(
        &self,
        change_id: String,
    ) -> Result<AutomationChangeView, AutomationError> {
        let _guard = self.automation_mutation_lock().lock().await;
        let now = chrono::Utc::now().to_rfc3339();
        {
            let mut conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            let tx = conn.transaction().map_err(|error| {
                AutomationError::internal(format!("begin promotion transaction: {error}"))
            })?;
            let change = automation::load_automation_change_set(&tx, &change_id)
                .map_err(|error| AutomationError::internal(format!("load change: {error}")))?
                .ok_or_else(|| AutomationError::new("NOT_FOUND", "automation change not found"))?;
            if change.lifecycle != "persistent" {
                return Err(AutomationError::new(
                    "INVALID_ARGUMENT",
                    "only persistent automation changes can be converted to user rules",
                ));
            }
            if change.status != "active" {
                return Err(AutomationError::new(
                    "STATE_CONFLICT",
                    format!("automation change is {}", change.status),
                ));
            }
            let items =
                automation::load_automation_change_items(&tx, &change_id).map_err(|error| {
                    AutomationError::internal(format!("load change items: {error}"))
                })?;
            if change_requires_user_automation(&items) {
                return Err(AutomationError::new(
                    "STATE_CONFLICT",
                    "this change also modifies user-owned resources and cannot be promoted as a whole",
                )
                .with_details(json!({ "changeId": change_id })));
            }
            let promoted = automation::set_automation_change_owner(&tx, &change_id, "user", &now)
                .map_err(|error| {
                AutomationError::internal(format!("promote automation resources: {error}"))
            })?;
            if promoted == 0 {
                return Err(AutomationError::new(
                    "STATE_CONFLICT",
                    "this change has no Agent-owned resources to convert",
                ));
            }
            automation::update_automation_change_status(
                &tx, &change_id, "promoted", None, None, None, None,
            )
            .map_err(|error| AutomationError::internal(format!("mark change promoted: {error}")))?;
            automation::update_automation_experiment_state(
                &tx,
                &change_id,
                "promoted",
                "kept_by_user",
                &now,
            )
            .map_err(|error| AutomationError::internal(format!("promote experiment: {error}")))?;
            tx.commit()
                .map_err(|error| AutomationError::internal(format!("commit promotion: {error}")))?;
        }
        let generation = self.read_rewrite_manager().runtime_generation();
        self.emit_automation_changed(
            "promote_automation_change",
            std::slice::from_ref(&change_id),
            generation,
        );
        self.get_automation_change(GetAutomationChangeParams { change_id })
    }

    pub async fn rollback_automation_change(
        &self,
        params: RollbackAutomationChangeParams,
        permissions: Option<AutomationPermissions>,
    ) -> Result<AutomationApplyResult, AutomationError> {
        let _guard = self.automation_mutation_lock().lock().await;
        self.rollback_automation_change_locked(
            &params.change_id,
            Some(&params.expected_scope_hash),
            "manual",
            permissions.as_ref(),
        )
    }

    pub async fn clear_agent_automation(
        &self,
        params: ClearAgentAutomationParams,
    ) -> Result<ClearAgentAutomationResult, AutomationError> {
        let _guard = self.automation_mutation_lock().lock().await;
        if !matches!(
            params.lifecycle.as_str(),
            "persistent" | "ephemeral" | "all"
        ) {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "lifecycle must be persistent, ephemeral, or all",
            ));
        }
        let scope_key = automation_scope_key(&params.scope, params.workspace_id.as_deref())?;
        let resources = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::list_automation_resources(
                &conn,
                Some(&scope_key),
                None,
                (params.lifecycle != "all").then_some(params.lifecycle.as_str()),
                10_000,
            )
            .map_err(|error| AutomationError::internal(format!("list Agent resources: {error}")))?
        };
        let agent_resources = resources
            .into_iter()
            .filter(|row| row.owner_kind == "agent")
            .collect::<Vec<_>>();
        let resource_count = agent_resources.len();
        let mut change_ids = HashSet::new();
        {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            for resource in &agent_resources {
                if let Some(change_id) = resource.change_id.as_ref() {
                    change_ids.insert(change_id.clone());
                }
                for change_id in automation::list_automation_change_ids_for_resource(
                    &conn,
                    &resource.resource_kind,
                    &resource.resource_id,
                )
                .map_err(|error| {
                    AutomationError::internal(format!("load resource change history: {error}"))
                })? {
                    change_ids.insert(change_id);
                }
            }
        }
        let mut change_ids = change_ids.into_iter().collect::<Vec<_>>();
        change_ids.sort();

        for change_id in &change_ids {
            let items = {
                let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
                automation::load_automation_change_items(&conn, change_id).map_err(|error| {
                    AutomationError::internal(format!("load cleanup items: {error}"))
                })?
            };
            if change_requires_user_automation(&items) {
                return Err(AutomationError::new(
                    "CONTROL_PERMISSION_DENIED",
                    "clearAgentAutomation cannot clear a change that also modifies user-owned resources",
                )
                .with_details(json!({
                    "changeId": change_id,
                })));
            }
        }

        let now = chrono::Utc::now().to_rfc3339();
        {
            let mut conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            let tx = conn.transaction().map_err(|error| {
                AutomationError::internal(format!("begin clear transaction: {error}"))
            })?;
            for resource in &agent_resources {
                match resource.resource_kind.as_str() {
                    "rewrite" => aiproxy_db::rules::delete_rewrite_rule(&tx, &resource.resource_id)
                        .map_err(|error| {
                            AutomationError::internal(format!("clear rewrite resource: {error}"))
                        })?,
                    "map" => aiproxy_db::rules::delete_map_rule(&tx, &resource.resource_id)
                        .map_err(|error| {
                            AutomationError::internal(format!("clear map resource: {error}"))
                        })?,
                    kind => {
                        return Err(AutomationError::new(
                            "FEATURE_NOT_AVAILABLE",
                            format!("cannot clear unsupported resource kind {kind}"),
                        ))
                    }
                }
                automation::delete_automation_resource(
                    &tx,
                    &resource.resource_kind,
                    &resource.resource_id,
                )
                .map_err(|error| {
                    AutomationError::internal(format!("clear resource metadata: {error}"))
                })?;
            }
            for change_id in &change_ids {
                automation::update_automation_change_status(
                    &tx,
                    change_id,
                    "reverting",
                    None,
                    None,
                    None,
                    None,
                )
                .map_err(|error| {
                    AutomationError::internal(format!("mark change clearing: {error}"))
                })?;
            }
            tx.commit().map_err(|error| {
                AutomationError::internal(format!("commit clear transaction: {error}"))
            })?;
        }

        let generation = self
            .publish_current_runtime(params.workspace_id.as_deref(), None)
            .map_err(|error| {
                AutomationError::new(
                    "RUNTIME_PUBLISH_FAILED",
                    format!(
                        "database cleanup committed but runtime publication failed: {}",
                        error.message
                    ),
                )
                .with_details(json!({
                    "clearedChangeIds": change_ids,
                    "committed": true,
                    "retryable": true,
                }))
            })?;
        {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            for change_id in &change_ids {
                automation::update_automation_change_status(
                    &conn,
                    change_id,
                    "aborted",
                    Some(generation),
                    None,
                    None,
                    Some(&now),
                )
                .map_err(|error| {
                    AutomationError::internal(format!("record cleared change: {error}"))
                })?;
                automation::update_automation_experiment_state(
                    &conn, change_id, "aborted", "cleared", &now,
                )
                .map_err(|error| {
                    AutomationError::internal(format!("record cleared experiment: {error}"))
                })?;
            }
        }
        for change_id in &change_ids {
            let _ = remove_staged_assets(self.automation_asset_root(), change_id);
        }

        let target_keys = agent_resources
            .iter()
            .map(|row| (row.resource_kind.clone(), row.resource_id.clone()))
            .collect::<HashSet<_>>();
        let remaining = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::list_automation_resources(
                &conn,
                Some(&scope_key),
                None,
                (params.lifecycle != "all").then_some(params.lifecycle.as_str()),
                10_000,
            )
            .map_err(|error| {
                AutomationError::internal(format!("list remaining resources: {error}"))
            })?
        };
        let remaining_resource_ids = remaining
            .into_iter()
            .filter(|row| row.owner_kind == "agent")
            .map(|row| (row.resource_kind, row.resource_id))
            .filter(|key| target_keys.contains(key))
            .collect::<Vec<_>>();
        let runtime_resource_ids = self
            .read_rewrite_manager()
            .list_rules()
            .into_iter()
            .map(|rule| ("rewrite".to_string(), rule.id))
            .chain(
                self.read_map_manager()
                    .list_rules()
                    .into_iter()
                    .map(|rule| ("map".to_string(), rule.id)),
            )
            .collect::<HashSet<_>>();
        let uncleared = remaining_resource_ids
            .into_iter()
            .chain(
                target_keys
                    .iter()
                    .filter(|key| runtime_resource_ids.contains(*key))
                    .cloned(),
            )
            .collect::<Vec<_>>();
        if !uncleared.is_empty() {
            return Err(AutomationError::new(
                "CLEANUP_INCOMPLETE",
                "Agent automation resources remain after cleanup",
            )
            .with_details(json!({
                "remainingResources": uncleared,
                "clearedChangeIds": change_ids,
            })));
        }

        self.emit_automation_changed("clear_agent_automation", &change_ids, generation);
        Ok(ClearAgentAutomationResult {
            cleared_change_ids: change_ids,
            cleared_resource_count: resource_count,
            runtime_generation: generation,
        })
    }

    pub fn recover_automation_changes(&self) -> Result<(), AutomationError> {
        self.abandon_ephemeral_changes_after_restart()?;
        let changes = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::list_unfinished_automation_changes(&conn).map_err(|error| {
                AutomationError::internal(format!("list unfinished changes: {error}"))
            })?
        };
        let mut recoveries = Vec::new();
        for change in changes {
            if change.lifecycle == "ephemeral" {
                continue;
            }
            let items = {
                let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
                automation::load_automation_change_items(&conn, &change.id).map_err(|error| {
                    AutomationError::internal(format!("load recovery items: {error}"))
                })?
            };
            let recovery_state = self.classify_persisted_change_state(&items)?;
            if recovery_state == PersistedChangeState::Mixed {
                return Err(AutomationError::new(
                    "RECOVERY_CONFLICT",
                    format!(
                        "automation change {} has a mixed persisted state and cannot be recovered automatically",
                        change.id
                    ),
                )
                .with_details(json!({ "changeId": change.id })));
            }
            recoveries.push((change, recovery_state));
        }
        if recoveries.is_empty() {
            self.publish_current_runtime(None, None)?;
            return Ok(());
        }

        let generation = self.publish_current_runtime(None, None)?;
        let now = chrono::Utc::now().to_rfc3339();
        for (change, recovery_state) in recoveries {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            match recovery_state {
                PersistedChangeState::After => {
                    automation::update_automation_change_status(
                        &conn,
                        &change.id,
                        "active",
                        Some(generation),
                        None,
                        Some(&now),
                        None,
                    )
                    .map_err(|error| {
                        AutomationError::internal(format!("recover change: {error}"))
                    })?;
                }
                PersistedChangeState::Before => {
                    automation::update_automation_change_status(
                        &conn,
                        &change.id,
                        "reverted",
                        Some(generation),
                        None,
                        None,
                        Some(&now),
                    )
                    .map_err(|error| {
                        AutomationError::internal(format!("recover rollback: {error}"))
                    })?;
                    automation::update_automation_experiment_state(
                        &conn,
                        &change.id,
                        "completed",
                        "recovered_rollback",
                        &now,
                    )
                    .map_err(|error| {
                        AutomationError::internal(format!("recover rollback experiment: {error}"))
                    })?;
                    let _ = remove_staged_assets(self.automation_asset_root(), &change.id);
                }
                PersistedChangeState::Mixed => unreachable!("mixed state rejected above"),
            }
        }
        Ok(())
    }

    fn classify_persisted_change_state(
        &self,
        items: &[AutomationChangeItemRow],
    ) -> Result<PersistedChangeState, AutomationError> {
        let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let rewrites = aiproxy_db::rules::load_all_rewrite_rules(&conn)
            .map_err(|error| {
                AutomationError::internal(format!("load rewrite recovery state: {error}"))
            })?
            .into_iter()
            .map(crate::bootstrap::converters::rewrite_row_to_rule)
            .map(|rule| (rule.id.clone(), PreparedResource::Rewrite(rule)))
            .collect::<HashMap<_, _>>();
        let maps = aiproxy_db::rules::load_all_map_rules(&conn)
            .map_err(|error| {
                AutomationError::internal(format!("load map recovery state: {error}"))
            })?
            .into_iter()
            .map(crate::bootstrap::converters::map_row_to_rule)
            .map(|rule| (rule.id.clone(), PreparedResource::Map(rule)))
            .collect::<HashMap<_, _>>();

        let mut all_before = true;
        let mut all_after = true;
        for item in items {
            let current = match item.resource_kind.as_str() {
                "rewrite" => rewrites.get(&item.resource_id),
                "map" => maps.get(&item.resource_id),
                _ => None,
            };
            let current_version = current.map(PreparedResource::version).transpose()?;
            all_before &= current_version == item.version_before;
            all_after &= current_version == item.version_after;
        }
        Ok(if all_after {
            PersistedChangeState::After
        } else if all_before {
            PersistedChangeState::Before
        } else {
            PersistedChangeState::Mixed
        })
    }

    fn abandon_ephemeral_changes_after_restart(&self) -> Result<(), AutomationError> {
        let changes = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::list_ephemeral_changes_for_restart_cleanup(&conn).map_err(|error| {
                AutomationError::internal(format!("list ephemeral restart cleanup: {error}"))
            })?
        };
        for change in changes {
            let now = chrono::Utc::now().to_rfc3339();
            {
                let mut conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
                let tx = conn.transaction().map_err(|error| {
                    AutomationError::internal(format!("begin ephemeral restart cleanup: {error}"))
                })?;
                automation::delete_automation_resources_for_change(&tx, &change.id).map_err(
                    |error| {
                        AutomationError::internal(format!(
                            "remove ephemeral resource metadata: {error}"
                        ))
                    },
                )?;
                automation::update_automation_experiment_state(
                    &tx,
                    &change.id,
                    "expired",
                    "expired_by_restart",
                    &now,
                )
                .map_err(|error| {
                    AutomationError::internal(format!(
                        "mark experiment expired by restart: {error}"
                    ))
                })?;
                automation::update_automation_change_status(
                    &tx,
                    &change.id,
                    "aborted",
                    None,
                    None,
                    None,
                    Some(&now),
                )
                .map_err(|error| {
                    AutomationError::internal(format!("abort ephemeral change: {error}"))
                })?;
                tx.commit().map_err(|error| {
                    AutomationError::internal(format!("commit ephemeral restart cleanup: {error}"))
                })?;
            }
            let _ = remove_staged_assets(self.automation_asset_root(), &change.id);
        }
        Ok(())
    }

    pub async fn cleanup_expired_automation(&self) -> Result<usize, AutomationError> {
        let _guard = self.automation_mutation_lock().lock().await;
        self.read_agent_rule_registry().cleanup_expired();
        let expired = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::list_expired_ephemeral_changes(&conn, &chrono::Utc::now().to_rfc3339())
                .map_err(|error| {
                    AutomationError::internal(format!("list expired changes: {error}"))
                })?
        };
        let mut reverted = 0;
        for change in expired {
            if self
                .rollback_automation_change_locked(&change.id, None, "expired", None)
                .is_ok()
            {
                reverted += 1;
            }
        }
        Ok(reverted)
    }

    pub async fn verify_automation_change(
        &self,
        params: VerifyAutomationChangeParams,
        permissions: AutomationPermissions,
    ) -> Result<AutomationVerificationResult, AutomationError> {
        if params.assertions.is_empty() || params.assertions.len() > MAX_VERIFICATION_ASSERTIONS {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                format!("assertions must contain 1-{MAX_VERIFICATION_ASSERTIONS} entries"),
            ));
        }
        for assertion in &params.assertions {
            validate_assertion(assertion)?;
        }
        let change = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::load_automation_change_set(&conn, &params.change_id)
                .map_err(|error| AutomationError::internal(format!("load change: {error}")))?
                .ok_or_else(|| AutomationError::new("NOT_FOUND", "automation change not found"))?
        };
        if change.status != "active" {
            return Ok(expired_verification(
                &change,
                &params,
                "change is not active",
                self.read_rewrite_manager().runtime_generation(),
            ));
        }
        if let Some(expires_at) = change.expires_at.as_deref() {
            if expires_at <= chrono::Utc::now().to_rfc3339().as_str() {
                return Ok(expired_verification(
                    &change,
                    &params,
                    "change has expired",
                    self.read_rewrite_manager().runtime_generation(),
                ));
            }
        }
        self.ensure_verification_targets_current(&change)?;

        match params.mode.as_str() {
            "offline" => self.verify_offline(&change, &params).await,
            "external" => self.verify_external(&change, &params),
            "proxy" => {
                if !permissions.manage_proxied_verification {
                    return Err(AutomationError::new(
                        "CONTROL_PERMISSION_DENIED",
                        "manageProxiedVerification is disabled",
                    ));
                }
                self.verify_proxy(&change, &params, &permissions).await
            }
            _ => Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "mode must be offline, proxy, or external",
            )),
        }
    }

    fn apply_automation_plan_locked(
        &self,
        params: ApplyAutomationPlanParams,
        caller: (&str, &str),
        permissions: AutomationPermissions,
    ) -> Result<AutomationApplyResult, AutomationError> {
        validate_plan_shape(&params.plan)?;
        let scope_key =
            automation_scope_key(&params.plan.scope, params.plan.workspace_id.as_deref())?;
        let plan_hash = hash_json(&serde_json::to_value(&params.plan).map_err(|error| {
            AutomationError::internal(format!("serialize automation plan: {error}"))
        })?)?;

        if let Some(existing) = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::load_automation_change_by_idempotency(
                &conn,
                &scope_key,
                &params.plan.idempotency_key,
            )
            .map_err(|error| AutomationError::internal(format!("load idempotency: {error}")))?
        } {
            if existing.plan_hash != plan_hash {
                return Err(AutomationError::new(
                    "IDEMPOTENCY_CONFLICT",
                    "idempotencyKey was already used for a different automation plan",
                )
                .with_details(json!({ "changeId": existing.id })));
            }
            if existing.status == "active" {
                let summary: Value =
                    serde_json::from_str(&existing.summary_json).unwrap_or(Value::Null);
                return Ok(apply_result_from_change(&existing, &summary, true));
            }
            if matches!(existing.status.as_str(), "reverted" | "aborted") {
                return Err(AutomationError::new(
                    "CHANGE_NOT_APPLICABLE",
                    "this idempotencyKey belongs to a change that was rolled back or cleared; use a new idempotencyKey to apply the plan again",
                )
                .with_details(json!({
                    "changeId": existing.id,
                    "status": existing.status,
                })));
            }
            if matches!(existing.status.as_str(), "committed" | "publish_failed") {
                let generation = self.publish_current_runtime(
                    existing.workspace_id.as_deref(),
                    Some(&existing.id),
                )?;
                let now = chrono::Utc::now().to_rfc3339();
                let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
                automation::update_automation_change_status(
                    &conn,
                    &existing.id,
                    "active",
                    Some(generation),
                    None,
                    Some(&now),
                    None,
                )
                .map_err(|error| {
                    AutomationError::internal(format!("activate retried change: {error}"))
                })?;
                // Return the refreshed row: the stale `existing` still says
                // publish_failed and carries no runtime generation.
                let refreshed = automation::load_automation_change_set(&conn, &existing.id)
                    .map_err(|error| {
                        AutomationError::internal(format!("reload retried change: {error}"))
                    })?
                    .ok_or_else(|| {
                        AutomationError::internal(format!(
                            "retried change {} disappeared",
                            existing.id
                        ))
                    })?;
                drop(conn);
                self.emit_automation_changed(
                    "apply_automation_plan_retry",
                    std::slice::from_ref(&existing.id),
                    generation,
                );
                let summary: Value =
                    serde_json::from_str(&refreshed.summary_json).unwrap_or(Value::Null);
                return Ok(apply_result_from_change(&refreshed, &summary, true));
            }
            return Err(AutomationError::new(
                "CHANGE_NOT_APPLICABLE",
                format!("automation change is {}", existing.status),
            )
            .with_details(json!({ "changeId": existing.id })));
        }

        let prepared = self.prepare_automation_plan(&params.plan, caller, permissions)?;
        if params.expected_plan_hash != prepared.plan_hash {
            return Err(AutomationError::new(
                "PLAN_HASH_MISMATCH",
                "expectedPlanHash does not match the supplied plan; run validate again",
            ));
        }
        if params.expected_scope_hash != prepared.scope_hash_before {
            return Err(AutomationError::new(
                "SCOPE_CONFLICT",
                "automation resources changed since validation; run validate again",
            ));
        }

        let staged_assets = self.stage_assets(&prepared.change_id, &params.plan.assets)?;
        if let Err(error) = self.commit_prepared_change(&prepared, caller, &staged_assets) {
            let _ = remove_staged_assets(self.automation_asset_root(), &prepared.change_id);
            return Err(error);
        }

        let generation = match self
            .publish_current_runtime(prepared.workspace_id.as_deref(), Some(&prepared.change_id))
        {
            Ok(generation) => generation,
            Err(error) => {
                if let Ok(conn) = self.lock_db_for_ipc() {
                    let _ = automation::update_automation_change_status(
                        &conn,
                        &prepared.change_id,
                        "publish_failed",
                        None,
                        None,
                        None,
                        None,
                    );
                }
                return Err(AutomationError::new(
                    "RUNTIME_PUBLISH_FAILED",
                    format!(
                        "database committed but runtime publication failed: {}",
                        error.message
                    ),
                )
                .with_details(json!({ "changeId": prepared.change_id })));
            }
        };

        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::update_automation_change_status(
                &conn,
                &prepared.change_id,
                "active",
                Some(generation),
                None,
                Some(&now),
                None,
            )
            .map_err(|error| {
                AutomationError::new(
                    "ACTIVATION_RECORD_FAILED",
                    format!("runtime published but active status could not be recorded: {error}"),
                )
                .with_details(json!({ "changeId": prepared.change_id }))
            })?;
        }

        self.emit_automation_changed(
            "apply_automation_plan",
            std::slice::from_ref(&prepared.change_id),
            generation,
        );
        Ok(AutomationApplyResult {
            change_id: prepared.change_id,
            status: "active".to_string(),
            runtime_generation: generation,
            resource_ids_by_ref: prepared.resource_ids_by_ref,
            expires_at: prepared.expires_at,
            idempotent: false,
        })
    }

    fn prepare_automation_plan(
        &self,
        plan: &AutomationPlan,
        caller: (&str, &str),
        permissions: AutomationPermissions,
    ) -> Result<PreparedPlan, AutomationError> {
        validate_plan_shape(plan)?;
        if !permissions.manage_automation {
            return Err(AutomationError::new(
                "CONTROL_PERMISSION_DENIED",
                "manageAutomation is disabled",
            ));
        }
        if plan.scope == "global" && !permissions.manage_global_automation {
            return Err(AutomationError::new(
                "CONTROL_PERMISSION_DENIED",
                "manageGlobalAutomation is disabled",
            ));
        }
        if !plan.upserts.script.is_empty() && !permissions.manage_scripts {
            return Err(AutomationError::new(
                "CONTROL_PERMISSION_DENIED",
                "manageScripts is disabled",
            ));
        }
        let scope_key = automation_scope_key(&plan.scope, plan.workspace_id.as_deref())?;
        let workspace_id = (plan.scope == "workspace").then(|| plan.workspace_id.clone().unwrap());
        let change_id = uuid::Uuid::new_v4().to_string();
        let plan_hash = hash_json(&serde_json::to_value(plan).map_err(|error| {
            AutomationError::internal(format!("serialize automation plan: {error}"))
        })?)?;
        let expires_at = (plan.lifecycle == "ephemeral").then(|| {
            let ttl = plan.ttl_seconds.unwrap_or(600) as i64;
            (chrono::Utc::now() + chrono::Duration::seconds(ttl)).to_rfc3339()
        });

        let metadata_conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let mut warnings = Vec::new();
        let mut refs = HashSet::new();
        for asset in &plan.assets {
            if !refs.insert(asset.r#ref.clone()) {
                return Err(AutomationError::new(
                    "INVALID_ARGUMENT",
                    format!("duplicate asset ref {}", asset.r#ref),
                ));
            }
            validate_asset(asset)?;
        }
        let asset_paths =
            preview_asset_paths(self.automation_asset_root(), &change_id, &plan.assets)?;
        let mut items = Vec::new();
        let mut resource_ids_by_ref = BTreeMap::new();
        let mut plan_resources = Vec::new();
        let now = chrono::Utc::now().to_rfc3339();

        for upsert in &plan.upserts.rewrite {
            let id = upsert
                .id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let existing = self
                .read_rewrite_manager()
                .list_rules()
                .into_iter()
                .find(|rule| rule.id == id);
            let metadata_before = if upsert.id.is_some() {
                automation::load_automation_resource(&metadata_conn, "rewrite", &id).map_err(
                    |error| AutomationError::internal(format!("load resource ownership: {error}")),
                )?
            } else {
                None
            };
            let owner = metadata_before
                .as_ref()
                .map(|row| row.owner_kind.as_str())
                .unwrap_or("user");
            if upsert.id.is_some() {
                ensure_persistent_update_allowed(
                    &metadata_conn,
                    &plan.lifecycle,
                    "rewrite",
                    &id,
                    metadata_before.as_ref(),
                )?;
                if existing.is_none() {
                    return Err(AutomationError::new(
                        "NOT_FOUND",
                        format!("rewrite resource {id} does not exist"),
                    ));
                }
                ensure_resource_in_plan_scope(
                    "rewrite",
                    &id,
                    &existing.as_ref().unwrap().workspace_id,
                    workspace_id.as_deref().unwrap_or_default(),
                )?;
                if owner == "user" && !permissions.manage_user_automation {
                    return Err(AutomationError::new(
                        "CONTROL_PERMISSION_DENIED",
                        format!(
                            "rewrite resource {id} is user-owned; manageUserAutomation is required"
                        ),
                    ));
                }
                let expected = upsert.expected_version.as_deref().ok_or_else(|| {
                    AutomationError::new(
                        "INVALID_ARGUMENT",
                        format!("rewrite resource {id} update requires expectedVersion"),
                    )
                })?;
                let current = existing.as_ref().unwrap();
                let current_version =
                    hash_json(&serde_json::to_value(current).map_err(|error| {
                        AutomationError::internal(format!("serialize existing rewrite: {error}"))
                    })?)?;
                if expected != current_version {
                    return Err(AutomationError::new(
                        "RESOURCE_VERSION_MISMATCH",
                        format!("rewrite resource {id} changed since it was read"),
                    )
                    .with_details(json!({ "currentVersion": current_version })));
                }
            }
            if let Some(reference) = upsert.r#ref.as_deref() {
                validate_ref(reference, &mut refs)?;
                resource_ids_by_ref.insert(reference.to_string(), id.clone());
            }
            let rule = build_rewrite_rule(
                workspace_id.as_deref().unwrap_or_default(),
                id.clone(),
                &upsert.resource,
                existing.as_ref(),
            )?;
            let after = PreparedResource::Rewrite(rule.clone());
            let after_json = serde_json::to_string(&rule).map_err(|error| {
                AutomationError::internal(format!("serialize prepared rewrite: {error}"))
            })?;
            let metadata_after = Some(automation_resource_row(AutomationResourceRowInput {
                kind: "rewrite",
                id: &id,
                plan,
                workspace_id: workspace_id.as_deref(),
                change_id: &change_id,
                expires_at: expires_at.as_deref(),
                now: &now,
                caller,
                owner: "agent",
            }));
            plan_resources.push(AutomationPlanResource {
                kind: "rewrite".to_string(),
                id: upsert.id.clone(),
                r#ref: upsert.r#ref.clone(),
                operation: if upsert.id.is_some() {
                    "update"
                } else {
                    "create"
                }
                .to_string(),
                owner: owner.to_string(),
                version: Some(after.version()?),
            });
            items.push(PreparedChangeItem {
                version_before: existing
                    .as_ref()
                    .map(|rule| hash_json(&serde_json::to_value(rule).unwrap_or(Value::Null)))
                    .transpose()?,
                before_json: existing
                    .as_ref()
                    .and_then(|rule| serde_json::to_string(rule).ok()),
                version_after: Some(after.version()?),
                after_json,
                dependencies_json: dependencies_json(None, metadata_before.as_ref())?,
                metadata_before,
                metadata_after,
                resource: after,
                operation: if upsert.id.is_some() {
                    "update"
                } else {
                    "create"
                }
                .to_string(),
            });
        }

        for upsert in &plan.upserts.map {
            let id = upsert
                .id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let existing = self
                .read_map_manager()
                .list_rules()
                .into_iter()
                .find(|rule| rule.id == id);
            let metadata_before = if upsert.id.is_some() {
                automation::load_automation_resource(&metadata_conn, "map", &id).map_err(
                    |error| AutomationError::internal(format!("load resource ownership: {error}")),
                )?
            } else {
                None
            };
            let owner = metadata_before
                .as_ref()
                .map(|row| row.owner_kind.as_str())
                .unwrap_or("user");
            if upsert.id.is_some() {
                ensure_persistent_update_allowed(
                    &metadata_conn,
                    &plan.lifecycle,
                    "map",
                    &id,
                    metadata_before.as_ref(),
                )?;
                if existing.is_none() {
                    return Err(AutomationError::new(
                        "NOT_FOUND",
                        format!("map resource {id} does not exist"),
                    ));
                }
                ensure_resource_in_plan_scope(
                    "map",
                    &id,
                    &existing.as_ref().unwrap().workspace_id,
                    workspace_id.as_deref().unwrap_or_default(),
                )?;
                if owner == "user" && !permissions.manage_user_automation {
                    return Err(AutomationError::new(
                        "CONTROL_PERMISSION_DENIED",
                        format!(
                            "map resource {id} is user-owned; manageUserAutomation is required"
                        ),
                    ));
                }
                let expected = upsert.expected_version.as_deref().ok_or_else(|| {
                    AutomationError::new(
                        "INVALID_ARGUMENT",
                        format!("map resource {id} update requires expectedVersion"),
                    )
                })?;
                let current = existing.as_ref().unwrap();
                let current_version =
                    hash_json(&serde_json::to_value(current).map_err(|error| {
                        AutomationError::internal(format!("serialize existing map: {error}"))
                    })?)?;
                if expected != current_version {
                    return Err(AutomationError::new(
                        "RESOURCE_VERSION_MISMATCH",
                        format!("map resource {id} changed since it was read"),
                    )
                    .with_details(json!({ "currentVersion": current_version })));
                }
            }
            if let Some(reference) = upsert.r#ref.as_deref() {
                validate_ref(reference, &mut refs)?;
                resource_ids_by_ref.insert(reference.to_string(), id.clone());
            }
            let target_value = resolve_map_target(
                &upsert.resource,
                &asset_paths,
                existing.as_ref().map(|rule| rule.target_value.as_str()),
                &permissions.automation_approved_roots,
            )?;
            let rule = build_map_rule(
                workspace_id.as_deref().unwrap_or_default(),
                id.clone(),
                &upsert.resource,
                target_value,
                existing.as_ref(),
            )?;
            if rule.mode != "local" {
                return Err(AutomationError::new(
                    "FEATURE_NOT_AVAILABLE",
                    "Map Remote is not available in this release",
                ));
            }
            let asset_ref = upsert.resource.managed_asset_ref.clone();
            let after = PreparedResource::Map(rule.clone());
            let after_json = serde_json::to_string(&rule).map_err(|error| {
                AutomationError::internal(format!("serialize prepared map: {error}"))
            })?;
            let metadata_after = Some(automation_resource_row(AutomationResourceRowInput {
                kind: "map",
                id: &id,
                plan,
                workspace_id: workspace_id.as_deref(),
                change_id: &change_id,
                expires_at: expires_at.as_deref(),
                now: &now,
                caller,
                owner: "agent",
            }));
            plan_resources.push(AutomationPlanResource {
                kind: "map".to_string(),
                id: upsert.id.clone(),
                r#ref: upsert.r#ref.clone(),
                operation: if upsert.id.is_some() {
                    "update"
                } else {
                    "create"
                }
                .to_string(),
                owner: owner.to_string(),
                version: Some(after.version()?),
            });
            items.push(PreparedChangeItem {
                version_before: existing
                    .as_ref()
                    .map(|rule| hash_json(&serde_json::to_value(rule).unwrap_or(Value::Null)))
                    .transpose()?,
                before_json: existing
                    .as_ref()
                    .and_then(|rule| serde_json::to_string(rule).ok()),
                version_after: Some(after.version()?),
                after_json,
                dependencies_json: dependencies_json(
                    asset_ref.as_deref(),
                    metadata_before.as_ref(),
                )?,
                metadata_before,
                metadata_after,
                resource: after,
                operation: if upsert.id.is_some() {
                    "update"
                } else {
                    "create"
                }
                .to_string(),
            });
        }

        for delete in &plan.deletes {
            let (kind, before, metadata_before) = match delete.kind.as_str() {
                "rewrite" => {
                    let before = self
                        .read_rewrite_manager()
                        .list_rules()
                        .into_iter()
                        .find(|rule| rule.id == delete.id)
                        .map(PreparedResource::Rewrite);
                    let metadata =
                        automation::load_automation_resource(&metadata_conn, "rewrite", &delete.id)
                            .map_err(|error| {
                                AutomationError::internal(format!(
                                    "load resource ownership: {error}"
                                ))
                            })?;
                    ("rewrite", before, metadata)
                }
                "map" => {
                    let before = self
                        .read_map_manager()
                        .list_rules()
                        .into_iter()
                        .find(|rule| rule.id == delete.id)
                        .map(PreparedResource::Map);
                    let metadata =
                        automation::load_automation_resource(&metadata_conn, "map", &delete.id)
                            .map_err(|error| {
                                AutomationError::internal(format!(
                                    "load resource ownership: {error}"
                                ))
                            })?;
                    ("map", before, metadata)
                }
                _ => {
                    return Err(AutomationError::new(
                        "FEATURE_NOT_AVAILABLE",
                        format!("unsupported delete kind {}", delete.kind),
                    ))
                }
            };
            let before = before.ok_or_else(|| {
                AutomationError::new(
                    "NOT_FOUND",
                    format!("{kind} resource {} does not exist", delete.id),
                )
            })?;
            let resource_workspace_id = match &before {
                PreparedResource::Rewrite(rule) => &rule.workspace_id,
                PreparedResource::Map(rule) => &rule.workspace_id,
            };
            ensure_resource_in_plan_scope(
                kind,
                &delete.id,
                resource_workspace_id,
                workspace_id.as_deref().unwrap_or_default(),
            )?;
            // A persistent plan must not delete a resource that still belongs
            // to an ephemeral change: the TTL rollback would then fail forever
            // because its expected post-change version is gone.
            ensure_persistent_update_allowed(
                &metadata_conn,
                &plan.lifecycle,
                kind,
                &delete.id,
                metadata_before.as_ref(),
            )?;
            let owner = metadata_before
                .as_ref()
                .map(|row| row.owner_kind.as_str())
                .unwrap_or("user");
            if owner == "user" && !permissions.manage_user_automation {
                return Err(AutomationError::new(
                    "CONTROL_PERMISSION_DENIED",
                    format!(
                        "{kind} resource {} is user-owned; manageUserAutomation is required",
                        delete.id
                    ),
                ));
            }
            let current_version = before.version()?;
            if current_version != delete.expected_version {
                return Err(AutomationError::new(
                    "RESOURCE_VERSION_MISMATCH",
                    format!("{kind} resource {} changed since it was read", delete.id),
                ));
            }
            plan_resources.push(AutomationPlanResource {
                kind: kind.to_string(),
                id: Some(delete.id.clone()),
                r#ref: None,
                operation: "delete".to_string(),
                owner: owner.to_string(),
                version: None,
            });
            items.push(PreparedChangeItem {
                resource: before.clone(),
                operation: "delete".to_string(),
                version_before: Some(current_version),
                version_after: None,
                before_json: Some(
                    match &before {
                        PreparedResource::Rewrite(rule) => serde_json::to_string(rule),
                        PreparedResource::Map(rule) => serde_json::to_string(rule),
                    }
                    .map_err(|error| {
                        AutomationError::internal(format!("serialize delete before: {error}"))
                    })?,
                ),
                after_json: Value::Null.to_string(),
                dependencies_json: dependencies_json(None, metadata_before.as_ref())?,
                metadata_before,
                metadata_after: None,
            });
        }

        if items.is_empty() {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "automation plan must contain at least one change",
            ));
        }
        let scope_hash_before = self.scope_hash(workspace_id.as_deref(), &items, false)?;
        let scope_hash_after = self.scope_hash(workspace_id.as_deref(), &items, true)?;
        via_warnings_for_risk(plan, &mut warnings);
        drop(metadata_conn);
        Ok(PreparedPlan {
            change_id,
            idempotency_key: plan.idempotency_key.clone(),
            lifecycle: plan.lifecycle.clone(),
            plan_hash,
            scope_hash_before,
            scope_hash_after,
            scope_key,
            workspace_id,
            expires_at,
            items,
            resource_ids_by_ref,
            warnings,
            plan_resources,
        })
    }

    fn scope_hash(
        &self,
        workspace_id: Option<&str>,
        items: &[PreparedChangeItem],
        after: bool,
    ) -> Result<String, AutomationError> {
        let Some(workspace_id) = workspace_id else {
            return hash_json(&json!({ "scope": "global" }));
        };
        let rewrite_rules = self
            .read_rewrite_manager()
            .list_rules()
            .into_iter()
            .filter(|rule| rule.workspace_id == workspace_id)
            .collect::<Vec<_>>();
        let map_rules = self
            .read_map_manager()
            .list_rules()
            .into_iter()
            .filter(|rule| rule.workspace_id == workspace_id)
            .collect::<Vec<_>>();

        let target_ids = items
            .iter()
            .map(|item| {
                (
                    item.resource.kind().to_string(),
                    item.resource.id().to_string(),
                )
            })
            .collect::<HashSet<_>>();
        let rewrite_target_hosts = items
            .iter()
            .filter_map(|item| match &item.resource {
                PreparedResource::Rewrite(rule) => pattern_host(&rule.r#match.url_pattern),
                PreparedResource::Map(_) => None,
            })
            .collect::<Vec<_>>();
        let map_target_hosts = items
            .iter()
            .filter_map(|item| match &item.resource {
                PreparedResource::Map(rule) => pattern_host(&rule.source_pattern),
                PreparedResource::Rewrite(_) => None,
            })
            .collect::<Vec<_>>();
        let rewrite_has_unbounded_target = items.iter().any(|item| {
            matches!(&item.resource, PreparedResource::Rewrite(rule) if pattern_host(&rule.r#match.url_pattern).is_none())
        });
        let map_has_unbounded_target = items.iter().any(|item| {
            matches!(&item.resource, PreparedResource::Map(rule) if pattern_host(&rule.source_pattern).is_none())
        });

        let includes_rewrite = |rule: &RewriteRule| {
            rewrite_has_unbounded_target
                || target_ids.contains(&("rewrite".to_string(), rule.id.clone()))
                || rewrite_target_hosts.iter().any(|host| {
                    host_conflicts(host, pattern_host(&rule.r#match.url_pattern).as_deref())
                })
        };
        let includes_map = |rule: &MapRule| {
            map_has_unbounded_target
                || target_ids.contains(&("map".to_string(), rule.id.clone()))
                || map_target_hosts
                    .iter()
                    .any(|host| host_conflicts(host, pattern_host(&rule.source_pattern).as_deref()))
        };

        let mut rewrite_snapshot = rewrite_rules
            .iter()
            .filter(|rule| includes_rewrite(rule))
            .cloned()
            .collect::<Vec<_>>();
        let mut map_snapshot = map_rules
            .iter()
            .filter(|rule| includes_map(rule))
            .cloned()
            .collect::<Vec<_>>();

        if after {
            for item in items {
                match &item.resource {
                    PreparedResource::Rewrite(rule) => {
                        rewrite_snapshot.retain(|candidate| candidate.id != rule.id);
                        if item.operation != "delete" {
                            rewrite_snapshot.push(rule.clone());
                        }
                    }
                    PreparedResource::Map(rule) => {
                        map_snapshot.retain(|candidate| candidate.id != rule.id);
                        if item.operation != "delete" {
                            map_snapshot.push(rule.clone());
                        }
                    }
                }
            }
        }

        rewrite_snapshot.sort_by(|a, b| a.id.cmp(&b.id));
        map_snapshot.sort_by(|a, b| a.id.cmp(&b.id));
        hash_json(&json!({
            "workspaceId": workspace_id,
            "rewrite": rewrite_snapshot,
            "map": map_snapshot,
        }))
    }

    fn stage_assets(
        &self,
        change_id: &str,
        assets: &[AutomationAsset],
    ) -> Result<HashMap<String, PathBuf>, AutomationError> {
        let paths = preview_asset_paths(self.automation_asset_root(), change_id, assets)?;
        for asset in assets {
            let path = paths.get(&asset.r#ref).ok_or_else(|| {
                AutomationError::internal(format!("asset path missing for {}", asset.r#ref))
            })?;
            let bytes = BASE64_STANDARD
                .decode(&asset.content_base64)
                .map_err(|error| {
                    AutomationError::new(
                        "INVALID_ARGUMENT",
                        format!("asset {} is not valid base64: {error}", asset.r#ref),
                    )
                })?;
            if bytes.len() > MAX_ASSET_BYTES {
                return Err(AutomationError::new(
                    "INVALID_ARGUMENT",
                    format!("asset {} exceeds 5 MiB", asset.r#ref),
                ));
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    AutomationError::internal(format!("create automation asset directory: {error}"))
                })?;
            }
            let temp = path.with_extension("tmp");
            std::fs::write(&temp, &bytes).map_err(|error| {
                AutomationError::internal(format!("write automation asset: {error}"))
            })?;
            std::fs::rename(&temp, path).map_err(|error| {
                AutomationError::internal(format!("publish automation asset: {error}"))
            })?;
        }
        Ok(paths)
    }

    fn commit_prepared_change(
        &self,
        prepared: &PreparedPlan,
        caller: (&str, &str),
        _assets: &HashMap<String, PathBuf>,
    ) -> Result<(), AutomationError> {
        let mut conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let tx = conn.transaction().map_err(|error| {
            AutomationError::internal(format!("begin automation transaction: {error}"))
        })?;
        let now = chrono::Utc::now().to_rfc3339();
        let summary = json!({
            "resourceIdsByRef": prepared.resource_ids_by_ref,
            "resourceCount": prepared.items.len(),
        });
        let change = AutomationChangeSetRow {
            id: prepared.change_id.clone(),
            scope: if prepared.workspace_id.is_some() {
                "workspace"
            } else {
                "global"
            }
            .to_string(),
            scope_key: prepared.scope_key.clone(),
            workspace_id: prepared.workspace_id.clone(),
            idempotency_key: prepared.idempotency_key.clone(),
            plan_hash: prepared.plan_hash.clone(),
            expected_plan_hash: prepared.plan_hash.clone(),
            scope_hash_before: prepared.scope_hash_before.clone(),
            scope_hash_after: prepared.scope_hash_after.clone(),
            lifecycle: prepared.lifecycle.clone(),
            status: "prepared".to_string(),
            runtime_generation: None,
            client_name: Some(caller.0.to_string()),
            client_version: Some(caller.1.to_string()),
            summary_json: summary.to_string(),
            created_at: now.clone(),
            committed_at: None,
            activated_at: None,
            reverted_at: None,
            expires_at: prepared.expires_at.clone(),
        };
        automation::insert_automation_change_set(&tx, &change).map_err(|error| {
            AutomationError::internal(format!("insert automation change: {error}"))
        })?;
        automation::update_automation_change_status(
            &tx,
            &prepared.change_id,
            "committed",
            None,
            Some(&now),
            None,
            None,
        )
        .map_err(|error| AutomationError::internal(format!("mark change committed: {error}")))?;

        let writes_user_rule_tables = prepared.lifecycle != "ephemeral";
        for (sequence, item) in prepared.items.iter().enumerate() {
            if writes_user_rule_tables {
                match &item.resource {
                    PreparedResource::Rewrite(rule) => {
                        if item.operation == "delete" {
                            aiproxy_db::rules::delete_rewrite_rule(&tx, &rule.id).map_err(
                                |error| {
                                    AutomationError::internal(format!(
                                        "delete rewrite rule: {error}"
                                    ))
                                },
                            )?;
                        } else {
                            aiproxy_db::rules::save_rewrite_rule(&tx, &rewrite_row(rule)).map_err(
                                |error| {
                                    AutomationError::internal(format!("save rewrite rule: {error}"))
                                },
                            )?;
                        }
                    }
                    PreparedResource::Map(rule) => {
                        if item.operation == "delete" {
                            aiproxy_db::rules::delete_map_rule(&tx, &rule.id).map_err(|error| {
                                AutomationError::internal(format!("delete map rule: {error}"))
                            })?;
                        } else {
                            aiproxy_db::rules::save_map_rule(&tx, &map_row(rule)).map_err(
                                |error| {
                                    AutomationError::internal(format!("save map rule: {error}"))
                                },
                            )?;
                        }
                    }
                }
            }

            if item.operation == "delete" {
                if let Some(metadata) = item.metadata_before.as_ref() {
                    automation::delete_automation_resource(
                        &tx,
                        &metadata.resource_kind,
                        &metadata.resource_id,
                    )
                    .map_err(|error| {
                        AutomationError::internal(format!("delete resource metadata: {error}"))
                    })?;
                }
            } else if let Some(metadata) = item.metadata_after.as_ref() {
                // Updating a user-owned rule must not transfer ownership to the
                // Agent. In that case we keep the user's metadata untouched.
                let resource_was_agent_owned = item
                    .metadata_before
                    .as_ref()
                    .is_some_and(|row| row.owner_kind == "agent");
                if item.operation == "create" || resource_was_agent_owned {
                    automation::save_automation_resource(&tx, metadata).map_err(|error| {
                        AutomationError::internal(format!("save resource metadata: {error}"))
                    })?;
                }
            }

            automation::insert_automation_change_item(
                &tx,
                &AutomationChangeItemRow {
                    change_id: prepared.change_id.clone(),
                    sequence: sequence as u32,
                    resource_kind: item.resource.kind().to_string(),
                    resource_id: item.resource.id().to_string(),
                    operation: item.operation.clone(),
                    version_before: item.version_before.clone(),
                    version_after: item.version_after.clone(),
                    before_json: item.before_json.clone(),
                    after_json: Some(item.after_json.clone()),
                    dependencies_json: item.dependencies_json.clone(),
                },
            )
            .map_err(|error| AutomationError::internal(format!("insert change item: {error}")))?;
        }

        tx.commit().map_err(|error| {
            AutomationError::internal(format!("commit automation change: {error}"))
        })?;
        Ok(())
    }

    fn publish_current_runtime(
        &self,
        workspace_id: Option<&str>,
        pending_ephemeral_change: Option<&str>,
    ) -> Result<u64, AutomationError> {
        let (rewrite_rows, map_rows, metadata, mut ephemeral_changes) = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            (
                aiproxy_db::rules::load_all_rewrite_rules(&conn).map_err(|error| {
                    AutomationError::internal(format!("reload rewrite rules: {error}"))
                })?,
                aiproxy_db::rules::load_all_map_rules(&conn).map_err(|error| {
                    AutomationError::internal(format!("reload map rules: {error}"))
                })?,
                automation::list_automation_resources(&conn, None, None, None, 10_000).map_err(
                    |error| {
                        AutomationError::internal(format!(
                            "load runtime resource ownership: {error}"
                        ))
                    },
                )?,
                automation::list_active_ephemeral_changes(&conn).map_err(|error| {
                    AutomationError::internal(format!("load ephemeral changes: {error}"))
                })?,
            )
        };
        if let Some(change_id) = pending_ephemeral_change {
            if !ephemeral_changes
                .iter()
                .any(|change| change.id == change_id)
            {
                let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
                if let Some(change) = automation::load_automation_change_set(&conn, change_id)
                    .map_err(|error| {
                        AutomationError::internal(format!("load pending ephemeral change: {error}"))
                    })?
                {
                    if change.lifecycle == "ephemeral"
                        && matches!(
                            change.status.as_str(),
                            "committed" | "publish_failed" | "active"
                        )
                    {
                        ephemeral_changes.push(change);
                    }
                }
            }
        }
        let metadata_by_id = metadata
            .into_iter()
            .map(|row| ((row.resource_kind.clone(), row.resource_id.clone()), row))
            .collect::<HashMap<_, _>>();
        let mut rewrites = rewrite_rows
            .into_iter()
            .map(crate::bootstrap::converters::rewrite_row_to_rule)
            .map(|rule| {
                let host_lock = runtime_host_lock_for_resource(
                    "rewrite",
                    &rule.id,
                    &rule.r#match.url_pattern,
                    &metadata_by_id,
                )?;
                Ok((rule, host_lock))
            })
            .collect::<Result<Vec<_>, AutomationError>>()?;
        let mut maps = map_rows
            .into_iter()
            .map(crate::bootstrap::converters::map_row_to_rule)
            .map(|rule| {
                let host_lock = runtime_host_lock_for_resource(
                    "map",
                    &rule.id,
                    &rule.source_pattern,
                    &metadata_by_id,
                )?;
                Ok((rule, host_lock))
            })
            .collect::<Result<Vec<_>, AutomationError>>()?;
        for change in ephemeral_changes {
            let items = {
                let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
                automation::load_automation_change_items(&conn, &change.id).map_err(|error| {
                    AutomationError::internal(format!("load ephemeral items: {error}"))
                })?
            };
            for item in items {
                let resource_key = (item.resource_kind.clone(), item.resource_id.clone());
                let owner_change_id = metadata_by_id
                    .get(&resource_key)
                    .and_then(|metadata| metadata.change_id.as_deref());
                if owner_change_id != Some(change.id.as_str()) {
                    // Never let an older ephemeral snapshot overwrite a resource
                    // whose metadata has moved to another lifecycle or change.
                    continue;
                }
                let Some(after_json) = item.after_json.as_deref() else {
                    continue;
                };
                match item.resource_kind.as_str() {
                    "rewrite" if item.operation == "create" || item.operation == "update" => {
                        let rule: RewriteRule =
                            serde_json::from_str(after_json).map_err(|error| {
                                AutomationError::internal(format!(
                                    "decode ephemeral rewrite: {error}"
                                ))
                            })?;
                        let host_lock = exact_pattern_host(
                            &rule.r#match.url_pattern,
                            "ephemeral rewrite urlPattern",
                        )?;
                        rewrites.retain(|candidate| candidate.0.id != rule.id);
                        rewrites.push((rule, Some(host_lock)));
                    }
                    "map" if item.operation == "create" || item.operation == "update" => {
                        let rule: MapRule = serde_json::from_str(after_json).map_err(|error| {
                            AutomationError::internal(format!("decode ephemeral map: {error}"))
                        })?;
                        let host_lock = exact_pattern_host(
                            &rule.source_pattern,
                            "ephemeral map sourcePattern",
                        )?;
                        maps.retain(|candidate| candidate.0.id != rule.id);
                        maps.push((rule, Some(host_lock)));
                    }
                    _ => {}
                }
            }
        }
        // Legacy temporary Agent rules live only in the managers and must
        // survive a database-backed publication, including their host locks.
        // Hold the registry mutation lock through the merge and publish so an
        // expiring or newly created legacy rule cannot be resurrected/lost.
        let generation = self
            .read_agent_rule_registry()
            .with_live_snapshot(|legacy| {
                for (rule, host_lock) in self.read_rewrite_manager().list_rules_with_host_locks() {
                    if (legacy.by_rule_id.contains_key(&rule.id)
                        || legacy.auxiliary_rule_ids.contains(&rule.id))
                        && !rewrites.iter().any(|entry| entry.0.id == rule.id)
                    {
                        rewrites.push((rule, host_lock));
                    }
                }
                for (rule, host_lock) in self.read_map_manager().list_rules_with_host_locks() {
                    if legacy.by_rule_id.contains_key(&rule.id)
                        && !maps.iter().any(|entry| entry.0.id == rule.id)
                    {
                        maps.push((rule, host_lock));
                    }
                }
                let previous_generation = self.read_rewrite_manager().runtime_generation();
                let generation = previous_generation.saturating_add(1);
                self.read_rewrite_manager()
                    .publish_rules_atomic(rewrites, maps, generation);
                generation
            });
        let _ = workspace_id;
        Ok(generation)
    }

    fn rollback_automation_change_locked(
        &self,
        change_id: &str,
        expected_scope_hash: Option<&str>,
        reason: &str,
        permissions: Option<&AutomationPermissions>,
    ) -> Result<AutomationApplyResult, AutomationError> {
        let (change, items) = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            let change = automation::load_automation_change_set(&conn, change_id)
                .map_err(|error| AutomationError::internal(format!("load change: {error}")))?
                .ok_or_else(|| AutomationError::new("NOT_FOUND", "automation change not found"))?;
            let items =
                automation::load_automation_change_items(&conn, change_id).map_err(|error| {
                    AutomationError::internal(format!("load change items: {error}"))
                })?;
            (change, items)
        };
        if matches!(change.status.as_str(), "reverted" | "aborted") {
            let summary: Value = serde_json::from_str(&change.summary_json).unwrap_or(Value::Null);
            return Ok(apply_result_from_change(&change, &summary, true));
        }
        if change.status == "promoted" {
            return Err(AutomationError::new(
                "ROLLBACK_CONFLICT",
                "this change was converted to user-owned rules and can no longer be rolled back as an Agent experiment",
            )
            .with_details(json!({ "changeId": change_id })));
        }
        if change_requires_user_automation(&items)
            && permissions.is_some_and(|permissions| !permissions.manage_user_automation)
        {
            return Err(AutomationError::new(
                "CONTROL_PERMISSION_DENIED",
                "manageUserAutomation is required to roll back a change involving user-owned resources",
            )
            .with_details(json!({ "changeId": change_id })));
        }
        if expected_scope_hash.is_some_and(|expected| expected != change.scope_hash_after) {
            return Err(AutomationError::new(
                "SCOPE_CONFLICT",
                "expectedScopeHash does not match this change",
            ));
        }

        if reason == "manual" {
            let scope_items = scope_items_from_change_items(&items)?;
            let current_scope_hash =
                self.scope_hash(change.workspace_id.as_deref(), &scope_items, true)?;
            if current_scope_hash != change.scope_hash_after {
                return Err(AutomationError::new(
                    "ROLLBACK_CONFLICT",
                    "automation resources or their same-host candidates changed after this automation change",
                )
                .with_details(json!({ "changeId": change_id })));
            }
        }

        for item in &items {
            let current = self.current_resource(item);
            let current_version = current
                .as_ref()
                .map(PreparedResource::version)
                .transpose()?;
            let expected = if item.operation == "delete" {
                None
            } else {
                item.version_after.clone()
            };
            if current_version != expected {
                return Err(AutomationError::new(
                    "ROLLBACK_CONFLICT",
                    format!(
                        "{} resource {} was changed after this automation change",
                        item.resource_kind, item.resource_id
                    ),
                )
                .with_details(json!({
                    "changeId": change_id,
                    "kind": item.resource_kind,
                    "resourceId": item.resource_id,
                })));
            }
        }

        let mut conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let tx = conn.transaction().map_err(|error| {
            AutomationError::internal(format!("begin rollback transaction: {error}"))
        })?;
        for item in items.iter().rev() {
            match item.operation.as_str() {
                "create" => {
                    if change.lifecycle != "ephemeral" {
                        match item.resource_kind.as_str() {
                            "rewrite" => {
                                aiproxy_db::rules::delete_rewrite_rule(&tx, &item.resource_id)
                                    .map_err(|error| {
                                        AutomationError::internal(format!(
                                            "rollback rewrite create: {error}"
                                        ))
                                    })?
                            }
                            "map" => aiproxy_db::rules::delete_map_rule(&tx, &item.resource_id)
                                .map_err(|error| {
                                    AutomationError::internal(format!(
                                        "rollback map create: {error}"
                                    ))
                                })?,
                            _ => {}
                        }
                    }
                    automation::delete_automation_resource(
                        &tx,
                        &item.resource_kind,
                        &item.resource_id,
                    )
                    .map_err(|error| {
                        AutomationError::internal(format!("rollback metadata create: {error}"))
                    })?;
                }
                "update" => {
                    let before = item.before_json.as_deref().ok_or_else(|| {
                        AutomationError::internal("change item is missing beforeJson")
                    })?;
                    self.restore_rule_json(&tx, &item.resource_kind, before)?;
                    self.restore_metadata(&tx, item)?;
                }
                "delete" => {
                    let before = item.before_json.as_deref().ok_or_else(|| {
                        AutomationError::internal("change item is missing beforeJson")
                    })?;
                    self.restore_rule_json(&tx, &item.resource_kind, before)?;
                    self.restore_metadata(&tx, item)?;
                }
                _ => {}
            }
        }
        let now = chrono::Utc::now().to_rfc3339();
        automation::update_automation_change_status(
            &tx,
            change_id,
            "reverting",
            None,
            None,
            None,
            None,
        )
        .map_err(|error| AutomationError::internal(format!("mark change reverting: {error}")))?;
        tx.commit()
            .map_err(|error| AutomationError::internal(format!("commit rollback: {error}")))?;
        drop(conn);

        let generation = self
            .publish_current_runtime(change.workspace_id.as_deref(), None)
            .map_err(|error| {
                AutomationError::new(
                    "RUNTIME_PUBLISH_FAILED",
                    format!(
                        "database rollback committed but runtime publication failed: {}",
                        error.message
                    ),
                )
                .with_details(json!({
                    "changeId": change_id,
                    "committed": true,
                    "retryable": true,
                }))
            })?;
        {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::update_automation_change_status(
                &conn,
                change_id,
                "reverted",
                Some(generation),
                None,
                None,
                Some(&now),
            )
            .map_err(|error| {
                AutomationError::new(
                    "ACTIVATION_RECORD_FAILED",
                    format!("runtime reverted but change status could not be recorded: {error}"),
                )
                .with_details(json!({ "changeId": change_id }))
            })?;
            automation::update_automation_experiment_state(
                &conn,
                change_id,
                if reason == "expired" {
                    "expired"
                } else {
                    "completed"
                },
                reason,
                &now,
            )
            .map_err(|error| {
                AutomationError::internal(format!("update experiment cleanup: {error}"))
            })?;
        }
        let _ = remove_staged_assets(self.automation_asset_root(), change_id);
        self.emit_automation_changed(reason, &[change_id.to_string()], generation);
        Ok(AutomationApplyResult {
            change_id: change_id.to_string(),
            status: "reverted".to_string(),
            runtime_generation: generation,
            resource_ids_by_ref: BTreeMap::new(),
            expires_at: change.expires_at,
            idempotent: false,
        })
    }

    fn current_resource(&self, item: &AutomationChangeItemRow) -> Option<PreparedResource> {
        match item.resource_kind.as_str() {
            "rewrite" => self
                .read_rewrite_manager()
                .list_rules()
                .into_iter()
                .find(|rule| rule.id == item.resource_id)
                .map(PreparedResource::Rewrite),
            "map" => self
                .read_map_manager()
                .list_rules()
                .into_iter()
                .find(|rule| rule.id == item.resource_id)
                .map(PreparedResource::Map),
            _ => None,
        }
    }

    fn ensure_verification_targets_current(
        &self,
        change: &AutomationChangeSetRow,
    ) -> Result<(), AutomationError> {
        let items = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            automation::load_automation_change_items(&conn, &change.id).map_err(|error| {
                AutomationError::internal(format!("load verification targets: {error}"))
            })?
        };
        for item in &items {
            let current_version = self
                .current_resource(item)
                .map(|resource| resource.version())
                .transpose()?;
            if current_version != item.version_after {
                return Err(AutomationError::new(
                    "RESOURCE_VERSION_MISMATCH",
                    format!(
                        "{} resource {} no longer matches this active change; verify the current change instead",
                        item.resource_kind, item.resource_id
                    ),
                )
                .with_details(json!({
                    "changeId": change.id,
                    "kind": item.resource_kind,
                    "resourceId": item.resource_id,
                    "expectedVersion": item.version_after,
                    "actualVersion": current_version,
                })));
            }
        }
        Ok(())
    }

    fn restore_rule_json(
        &self,
        conn: &aiproxy_db::rusqlite::Connection,
        kind: &str,
        before_json: &str,
    ) -> Result<(), AutomationError> {
        match kind {
            "rewrite" => {
                let rule: RewriteRule = serde_json::from_str(before_json).map_err(|error| {
                    AutomationError::internal(format!("decode rewrite rollback data: {error}"))
                })?;
                aiproxy_db::rules::save_rewrite_rule(conn, &rewrite_row(&rule))
                    .map_err(|error| AutomationError::internal(format!("restore rewrite: {error}")))
            }
            "map" => {
                let rule: MapRule = serde_json::from_str(before_json).map_err(|error| {
                    AutomationError::internal(format!("decode map rollback data: {error}"))
                })?;
                aiproxy_db::rules::save_map_rule(conn, &map_row(&rule))
                    .map_err(|error| AutomationError::internal(format!("restore map: {error}")))
            }
            _ => Ok(()),
        }
    }

    fn restore_metadata(
        &self,
        conn: &aiproxy_db::rusqlite::Connection,
        item: &AutomationChangeItemRow,
    ) -> Result<(), AutomationError> {
        let metadata = parse_metadata_from_dependencies(&item.dependencies_json)?;
        if let Some(metadata) = metadata {
            automation::save_automation_resource(conn, &metadata).map_err(|error| {
                AutomationError::internal(format!("restore resource metadata: {error}"))
            })?;
        } else {
            let _ = automation::delete_automation_resource(
                conn,
                &item.resource_kind,
                &item.resource_id,
            );
        }
        Ok(())
    }

    async fn verify_offline(
        &self,
        change: &AutomationChangeSetRow,
        params: &VerifyAutomationChangeParams,
    ) -> Result<AutomationVerificationResult, AutomationError> {
        if params.requests.is_empty() || params.requests.len() > MAX_VERIFICATION_REQUESTS {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                format!("offline verification requires 1-{MAX_VERIFICATION_REQUESTS} requests"),
            ));
        }
        let target_ids = self.change_target_ids(&change.id)?;
        let response_stage_targets = self
            .read_rewrite_manager()
            .list_rules()
            .into_iter()
            .filter(|rule| rule.r#match.stage == "response" && target_ids.contains(&rule.id))
            .map(|rule| rule.id)
            .collect::<HashSet<_>>();
        let mut request_results = Vec::new();
        let mut evidence = Vec::new();
        let mut overall_passed = true;
        let mut limitations = vec![
            "Offline evidence proves matching and transformation only.".to_string(),
            "Offline evidence does not prove that the real proxy runtime or network path is active.".to_string(),
            "Offline evidence does not prove real client rendering.".to_string(),
        ];
        let mut response_limitation_added = false;
        for request in &params.requests {
            let baseline_id = request
                .baseline_session_id
                .clone()
                .or_else(|| params.baseline_session_ids.first().cloned());
            let baseline = baseline_id
                .as_deref()
                .map(|id| {
                    self.read_session_detail(id).map_err(|error| {
                        AutomationError::internal(format!("read baseline session {id}: {error}"))
                    })
                })
                .transpose()?
                .flatten();
            let (method, url, headers, body) = offline_request_parts(request, baseline.as_ref())?;
            let baseline_response = baseline
                .as_ref()
                .map(offline_baseline_response)
                .transpose()?;
            let response_unevaluated =
                baseline_response.is_none() && !response_stage_targets.is_empty();
            let result = evaluate_offline(
                OfflineEvaluationInput {
                    workspace_id: change
                        .workspace_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string()),
                    request: OfflineRequestInput {
                        method,
                        url,
                        headers,
                        body_base64: Some(BASE64_STANDARD.encode(body)),
                    },
                    baseline_response,
                },
                self.read_rewrite_manager(),
                self.read_map_manager(),
            )?;
            let matched_rule_ids =
                matched_rule_ids(&result.rewrite_traces, &result.map_traces, &target_ids);
            let mut request_status = classify_match_status(
                &target_ids,
                &matched_rule_ids,
                &result.rewrite_traces,
                &result.map_traces,
            );
            let trace_failed = result
                .rewrite_traces
                .iter()
                .any(|trace| trace.outcome == "error")
                || result
                    .map_traces
                    .iter()
                    .any(|trace| trace.outcome == "failed");
            if trace_failed {
                request_status = "rule_failed".to_string();
            }
            let observations = build_offline_observations(&result, &matched_rule_ids);
            let assertions = evaluate_assertions(&params.assertions, &observations);
            if request_status == "passed" && assertions.iter().any(|assertion| !assertion.passed) {
                request_status = "assertion_failed".to_string();
            }
            if response_unevaluated
                && matches!(
                    request_status.as_str(),
                    "passed" | "not_matched" | "shadowed"
                )
            {
                request_status = "insufficient_evidence".to_string();
                if !response_limitation_added {
                    limitations.push(
                        "Response-stage rewrite rules were not evaluated because no baselineSessionId was supplied; pass a baseline session to verify response transformations."
                            .to_string(),
                    );
                    response_limitation_added = true;
                }
            }
            let conflict = matches!(
                request_status.as_str(),
                "not_matched" | "shadowed" | "rule_failed"
            )
            .then(|| {
                self.conflict_diagnostic(&target_ids, &result.rewrite_traces, &result.map_traces)
            })
            .flatten();
            if request_status != "passed" {
                overall_passed = false;
            }
            evidence.extend(assertions.iter().filter(|_| false).map(|_| String::new()));
            request_results.push(AutomationVerificationRequestResult {
                r#ref: request.r#ref.clone(),
                status: request_status,
                matched_rule_ids: matched_rule_ids.clone(),
                assertions,
                evidence_session_ids: baseline_id.into_iter().collect(),
                rule_trace_refs: matched_rule_ids,
                response_status: result.response_status,
                final_url: Some(result.final_url),
                conflict,
            });
        }
        if !overall_passed
            && request_results
                .iter()
                .all(|result| result.status == "not_matched")
        {
            limitations.push("No target rule matched the supplied request.".to_string());
        }
        self.persist_verification(change, params, &request_results, &evidence, &limitations)
    }

    fn verify_external(
        &self,
        change: &AutomationChangeSetRow,
        params: &VerifyAutomationChangeParams,
    ) -> Result<AutomationVerificationResult, AutomationError> {
        if params.external_session_ids.is_empty() {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "external verification requires externalSessionIds from a recently captured client request",
            ));
        }
        let target_ids = self.change_target_ids(&change.id)?;
        let mut request_results = Vec::new();
        let mut evidence = Vec::new();
        let mut overall_passed = true;
        for session_id in &params.external_session_ids {
            let detail = self
                .read_session_detail(session_id)
                .map_err(|error| {
                    AutomationError::internal(format!("read evidence session: {error}"))
                })?
                .ok_or_else(|| {
                    AutomationError::new("NOT_FOUND", format!("session {session_id} not found"))
                })?;
            if detail.timing_source.as_deref() == Some("agentReplay") {
                return Err(AutomationError::new(
                    "INSUFFICIENT_EVIDENCE",
                    "replay_session sessions bypass rules and cannot prove rule effects",
                ));
            }
            if let Some(activated_at) = change.activated_at.as_deref() {
                let activated_at =
                    chrono::DateTime::parse_from_rfc3339(activated_at).map_err(|error| {
                        AutomationError::internal(format!(
                            "parse automation activation time: {error}"
                        ))
                    })?;
                let session_started_at = chrono::DateTime::parse_from_rfc3339(
                    &detail.summary.started_at,
                )
                .map_err(|error| {
                    AutomationError::internal(format!("parse evidence session time: {error}"))
                })?;
                if session_started_at < activated_at {
                    return Err(AutomationError::new(
                        "INSUFFICIENT_EVIDENCE",
                        "external evidence must be captured after this automation change became active",
                    )
                    .with_details(json!({
                        "sessionId": session_id,
                        "startedAt": detail.summary.started_at,
                        "activatedAt": activated_at.to_rfc3339(),
                    })));
                }
            }
            let matched = matched_rule_ids(&detail.rewrite_traces, &detail.map_traces, &target_ids);
            let mut status = if detail
                .failure
                .as_ref()
                .is_some_and(|failure| failure.origin == "upstream")
            {
                "upstream_failed".to_string()
            } else {
                classify_match_status(
                    &target_ids,
                    &matched,
                    &detail.rewrite_traces,
                    &detail.map_traces,
                )
            };
            let observations = build_session_observations(&detail, &matched);
            let assertions = evaluate_assertions(&params.assertions, &observations);
            if status == "passed" && assertions.iter().any(|assertion| !assertion.passed) {
                status = "assertion_failed".to_string();
            }
            let conflict = matches!(status.as_str(), "not_matched" | "shadowed" | "rule_failed")
                .then(|| {
                    self.conflict_diagnostic(
                        &target_ids,
                        &detail.rewrite_traces,
                        &detail.map_traces,
                    )
                })
                .flatten();
            if status != "passed" {
                overall_passed = false;
            }
            evidence.push(session_id.clone());
            request_results.push(AutomationVerificationRequestResult {
                r#ref: session_id.clone(),
                status,
                matched_rule_ids: matched.clone(),
                assertions,
                evidence_session_ids: vec![session_id.clone()],
                rule_trace_refs: matched,
                response_status: Some(detail.summary.status_code),
                final_url: Some(detail.summary.url),
                conflict,
            });
        }
        let limitations = vec![
            "External evidence reflects the real client request and proxy pipeline.".to_string(),
            "It cannot prove visual rendering beyond the captured HTTP response.".to_string(),
        ];
        let _ = overall_passed;
        self.persist_verification(change, params, &request_results, &evidence, &limitations)
    }

    async fn verify_proxy(
        &self,
        change: &AutomationChangeSetRow,
        params: &VerifyAutomationChangeParams,
        permissions: &AutomationPermissions,
    ) -> Result<AutomationVerificationResult, AutomationError> {
        if params.requests.is_empty() || params.requests.len() > MAX_VERIFICATION_REQUESTS {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                format!("proxy verification requires 1-{MAX_VERIFICATION_REQUESTS} requests"),
            ));
        }
        reserve_proxy_verification_slots(params.requests.len())?;
        let status = self.read_status();
        if !status.running {
            return Err(proxy_verification_unavailable(
                "PROXY_NOT_RUNNING",
                "Start AIProxy capture before using proxy verification.",
            ));
        }
        let target_ids = self.change_target_ids(&change.id)?;
        let mut prepared = Vec::with_capacity(params.requests.len());
        let mut needs_https = false;
        for request in &params.requests {
            let baseline_id = request
                .baseline_session_id
                .clone()
                .or_else(|| params.baseline_session_ids.first().cloned());
            let baseline = baseline_id
                .as_deref()
                .map(|id| {
                    self.read_session_detail(id).map_err(|error| {
                        AutomationError::internal(format!("read baseline session {id}: {error}"))
                    })
                })
                .transpose()?
                .flatten();
            let (method, url, headers, body) = offline_request_parts(request, baseline.as_ref())?;
            let (method, request_uses_https) = validate_proxy_verification_target(
                &method,
                &url,
                &permissions.proxied_verification_origins,
            )?;
            let preflight = evaluate_offline(
                OfflineEvaluationInput {
                    workspace_id: change
                        .workspace_id
                        .clone()
                        .unwrap_or_else(|| "default".to_string()),
                    request: OfflineRequestInput {
                        method: method.clone(),
                        url: url.clone(),
                        headers: headers.clone(),
                        body_base64: Some(BASE64_STANDARD.encode(&body)),
                    },
                    baseline_response: None,
                },
                self.read_rewrite_manager(),
                self.read_map_manager(),
            )
            .map_err(|error| {
                AutomationError::new(
                    "RULE_PREFLIGHT_FAILED",
                    format!("proxy verification rule preflight failed: {error}"),
                )
            })?;
            ensure_proxy_transformation_stays_on_origin(
                &url,
                &preflight.final_url,
                &preflight.rewrite_traces,
            )?;
            needs_https |= request_uses_https;
            let _ = baseline;
            prepared.push((request.clone(), method, url, headers, body));
        }

        if needs_https {
            if !status.ssl_enabled {
                return Err(proxy_verification_unavailable(
                    "SSL_INTERCEPTION_DISABLED",
                    "Enable SSL interception before proxying HTTPS verification requests.",
                ));
            }
            let storage = aiproxy_tls_manager::CertStorage::resolve().map_err(|error| {
                proxy_verification_unavailable(
                    "CERTIFICATE_UNAVAILABLE",
                    format!("Resolve the AIProxy root certificate: {error}"),
                )
            })?;
            if !storage.root_cert_exists() {
                return Err(proxy_verification_unavailable(
                    "CERTIFICATE_UNAVAILABLE",
                    "Generate an AIProxy root certificate before HTTPS proxy verification.",
                ));
            }
            let platform = aiproxy_tls_manager::detect_platform();
            if !aiproxy_tls_manager::is_cert_trusted_on_platform(storage.root_cert_path(), platform)
            {
                return Err(proxy_verification_unavailable(
                    "CERTIFICATE_UNTRUSTED",
                    "Trust the AIProxy root certificate before HTTPS proxy verification.",
                ));
            }
        }

        let client = self.proxy_verification_client(status.port, needs_https)?;
        let mut request_results = Vec::with_capacity(prepared.len());
        let mut evidence = Vec::new();
        let mut limitations = vec![
            "Proxy evidence proves that the request traversed the live AIProxy rule pipeline."
                .to_string(),
            "Proxy evidence does not prove that a real app rendered the response.".to_string(),
            "HTTPS verification requires AIProxy SSL interception and a trusted root certificate."
                .to_string(),
        ];
        for (request, method, url, headers, body) in prepared {
            let before = self
                .read_sessions()
                .into_iter()
                .map(|summary| summary.id)
                .collect::<HashSet<_>>();
            let mut builder = client.request(
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| {
                    AutomationError::new(
                        "INVALID_ARGUMENT",
                        format!("proxy verification method is invalid: {error}"),
                    )
                })?,
                &url,
            );
            for header in &headers {
                if is_proxy_verification_header(&header.name) {
                    continue;
                }
                builder = builder.header(&header.name, &header.value);
            }
            if !body.is_empty() {
                builder = builder.body(body);
            }
            let started = Instant::now();
            let response = builder.send().await.map_err(|error| {
                AutomationError::new(
                    "UPSTREAM_UNREACHABLE",
                    format!("Proxy verification request failed: {error}"),
                )
            })?;
            let response_status = response.status().as_u16();
            let final_url = response.url().to_string();
            let response_headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| aiproxy_proxy_core::OfflineHeader {
                            name: name.as_str().to_string(),
                            value: value.to_string(),
                        })
                })
                .collect::<Vec<_>>();
            let response_body = read_bounded_reqwest_body(response).await?;
            let duration_ms = started.elapsed().as_millis() as u64;
            let detail = self
                .find_verification_session(&before, &method, &url, &final_url)
                .await;
            let cross_host_transformation = detail.as_ref().and_then(|detail| {
                ensure_proxy_transformation_stays_on_origin(
                    &url,
                    &session_url(&url, &final_url),
                    &detail.rewrite_traces,
                )
                .err()
            });
            if let Some(error) = cross_host_transformation.as_ref() {
                limitations.push(format!(
                    "Proxy verification detected a cross-host transformation for request {}: {}",
                    request.r#ref, error.message
                ));
            }
            let matched = detail
                .as_ref()
                .map(|detail| {
                    matched_rule_ids(&detail.rewrite_traces, &detail.map_traces, &target_ids)
                })
                .unwrap_or_default();
            let mut request_status = if cross_host_transformation.is_some() {
                "rule_failed".to_string()
            } else if detail.as_ref().is_some_and(|detail| {
                detail
                    .failure
                    .as_ref()
                    .is_some_and(|failure| failure.origin == "upstream")
            }) {
                "upstream_failed".to_string()
            } else {
                classify_match_status(
                    &target_ids,
                    &matched,
                    detail
                        .as_ref()
                        .map(|detail| detail.rewrite_traces.as_slice())
                        .unwrap_or(&[]),
                    detail
                        .as_ref()
                        .map(|detail| detail.map_traces.as_slice())
                        .unwrap_or(&[]),
                )
            };
            if detail.is_none() {
                request_status = "insufficient_evidence".to_string();
                limitations.push(format!(
                    "No captured session was linked to proxy verification request {}.",
                    request.r#ref
                ));
            }
            let observations = build_proxy_observations(
                response_status,
                &session_url(&url, &final_url),
                &response_headers,
                &response_body,
                duration_ms,
                detail.as_ref(),
                &matched,
            );
            let assertions = evaluate_assertions(&params.assertions, &observations);
            if request_status == "passed" && assertions.iter().any(|assertion| !assertion.passed) {
                request_status = "assertion_failed".to_string();
            }
            let conflict = matches!(
                request_status.as_str(),
                "not_matched" | "shadowed" | "rule_failed"
            )
            .then(|| {
                self.conflict_diagnostic(
                    &target_ids,
                    detail
                        .as_ref()
                        .map(|detail| detail.rewrite_traces.as_slice())
                        .unwrap_or(&[]),
                    detail
                        .as_ref()
                        .map(|detail| detail.map_traces.as_slice())
                        .unwrap_or(&[]),
                )
            })
            .flatten();
            let evidence_session_ids = detail
                .as_ref()
                .map(|detail| vec![detail.summary.id.clone()])
                .unwrap_or_default();
            evidence.extend(evidence_session_ids.iter().cloned());
            request_results.push(AutomationVerificationRequestResult {
                r#ref: request.r#ref,
                status: request_status,
                matched_rule_ids: matched.clone(),
                assertions,
                evidence_session_ids,
                rule_trace_refs: matched,
                response_status: Some(response_status),
                final_url: Some(session_url(&url, &final_url)),
                conflict,
            });
        }
        self.persist_verification(change, params, &request_results, &evidence, &limitations)
    }

    fn proxy_verification_client(
        &self,
        port: u16,
        needs_https: bool,
    ) -> Result<reqwest::Client, AutomationError> {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|error| {
            proxy_verification_unavailable(
                "PROXY_CLIENT_INVALID",
                format!("Configure the local AIProxy proxy: {error}"),
            )
        })?;
        let mut builder = reqwest::Client::builder()
            .proxy(proxy)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20));
        if needs_https {
            let storage = aiproxy_tls_manager::CertStorage::resolve().map_err(|error| {
                proxy_verification_unavailable(
                    "CERTIFICATE_UNAVAILABLE",
                    format!("Resolve the AIProxy root certificate: {error}"),
                )
            })?;
            let pem = storage.load_root_cert_pem().map_err(|error| {
                proxy_verification_unavailable(
                    "CERTIFICATE_UNAVAILABLE",
                    format!("Read the AIProxy root certificate: {error}"),
                )
            })?;
            let certificate = reqwest::Certificate::from_pem(pem.as_bytes()).map_err(|error| {
                proxy_verification_unavailable(
                    "CERTIFICATE_INVALID",
                    format!("Parse the AIProxy root certificate: {error}"),
                )
            })?;
            builder = builder.add_root_certificate(certificate);
        }
        builder.build().map_err(|error| {
            AutomationError::internal(format!("build proxy verification client: {error}"))
        })
    }

    async fn find_verification_session(
        &self,
        before: &HashSet<String>,
        method: &str,
        url: &str,
        final_url: &str,
    ) -> Option<aiproxy_proxy_core::ProxySessionDetail> {
        let started = Instant::now();
        loop {
            for summary in self.read_sessions() {
                if before.contains(&summary.id) || !summary.method.eq_ignore_ascii_case(method) {
                    continue;
                }
                if summary.url != url && summary.url != final_url {
                    continue;
                }
                if let Ok(Some(detail)) = self.read_session_detail(&summary.id) {
                    return Some(detail);
                }
            }
            if started.elapsed() >= PROXY_SESSION_WAIT {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn change_target_ids(&self, change_id: &str) -> Result<HashSet<String>, AutomationError> {
        let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let items = automation::load_automation_change_items(&conn, change_id)
            .map_err(|error| AutomationError::internal(format!("load change items: {error}")))?;
        Ok(items
            .into_iter()
            .filter(|item| item.operation != "delete")
            .map(|item| item.resource_id)
            .collect())
    }

    fn conflict_diagnostic(
        &self,
        targets: &HashSet<String>,
        rewrite_traces: &[aiproxy_proxy_core::RewriteTrace],
        map_traces: &[aiproxy_proxy_core::MapTrace],
    ) -> Option<AutomationConflictDiagnostic> {
        let rewrite_rules = self.read_rewrite_manager().list_rules();
        let map_rules = self.read_map_manager().list_rules();
        let mut candidates = Vec::new();
        let mut traced = HashSet::new();

        for trace in rewrite_traces {
            traced.insert(trace.rule_id.clone());
            let rule = rewrite_rules.iter().find(|rule| rule.id == trace.rule_id);
            candidates.push(AutomationConflictCandidate {
                rule_id: trace.rule_id.clone(),
                rule_name: Some(trace.rule_name.clone()),
                priority: rule.map(|rule| rule.priority).unwrap_or_default(),
                match_type: rule.and_then(|rule| rule.r#match.match_type.clone()),
                scope: "workspace".to_string(),
                workspace_id: rule.map(|rule| rule.workspace_id.clone()),
                source_pattern: rule.map(|rule| rule.r#match.url_pattern.clone()),
                outcome: Some(trace.outcome.clone()),
                reason: if targets.contains(&trace.rule_id) {
                    "The target rule matched but its rewrite trace reports a failure.".to_string()
                } else {
                    "A higher-priority or earlier rewrite rule matched before the target resource."
                        .to_string()
                },
            });
        }
        for trace in map_traces {
            traced.insert(trace.rule_id.clone());
            let rule = map_rules.iter().find(|rule| rule.id == trace.rule_id);
            candidates.push(AutomationConflictCandidate {
                rule_id: trace.rule_id.clone(),
                rule_name: Some(trace.rule_name.clone()),
                priority: rule.map(|rule| rule.priority).unwrap_or_default(),
                match_type: rule.and_then(|rule| rule.match_type.clone()),
                scope: "workspace".to_string(),
                workspace_id: rule.map(|rule| rule.workspace_id.clone()),
                source_pattern: rule.map(|rule| rule.source_pattern.clone()),
                outcome: Some(trace.outcome.clone()),
                reason: if targets.contains(&trace.rule_id) {
                    "The target rule matched but its map trace reports a failure.".to_string()
                } else {
                    "A higher-priority or earlier map rule matched before the target resource."
                        .to_string()
                },
            });
        }

        for target in targets {
            if traced.contains(target) {
                continue;
            }
            if let Some(rule) = rewrite_rules.iter().find(|rule| &rule.id == target) {
                candidates.push(AutomationConflictCandidate {
                    rule_id: rule.id.clone(),
                    rule_name: Some(rule.name.clone()),
                    priority: rule.priority,
                    match_type: rule.r#match.match_type.clone(),
                    scope: "workspace".to_string(),
                    workspace_id: Some(rule.workspace_id.clone()),
                    source_pattern: Some(rule.r#match.url_pattern.clone()),
                    outcome: None,
                    reason: if !rule.enabled {
                        "The target rewrite rule is disabled.".to_string()
                    } else {
                        "The target rewrite rule produced no trace; URL, method, stage, host lock, or workspace did not match."
                            .to_string()
                    },
                });
                continue;
            }
            if let Some(rule) = map_rules.iter().find(|rule| &rule.id == target) {
                candidates.push(AutomationConflictCandidate {
                    rule_id: rule.id.clone(),
                    rule_name: Some(rule.name.clone()),
                    priority: rule.priority,
                    match_type: rule.match_type.clone(),
                    scope: "workspace".to_string(),
                    workspace_id: Some(rule.workspace_id.clone()),
                    source_pattern: Some(rule.source_pattern.clone()),
                    outcome: None,
                    reason: if !rule.enabled {
                        "The target map rule is disabled.".to_string()
                    } else {
                        "The target map rule produced no trace; URL, method, host lock, or workspace did not match."
                            .to_string()
                    },
                });
                continue;
            }
            candidates.push(AutomationConflictCandidate {
                rule_id: target.clone(),
                rule_name: None,
                priority: 0,
                match_type: None,
                scope: "workspace".to_string(),
                workspace_id: None,
                source_pattern: None,
                outcome: None,
                reason: "The target resource is not present in the current runtime snapshot."
                    .to_string(),
            });
        }
        if candidates.is_empty() {
            return None;
        }
        candidates.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.rule_id.cmp(&right.rule_id))
        });
        let winning_rule_id = rewrite_traces
            .iter()
            .map(|trace| trace.rule_id.clone())
            .chain(map_traces.iter().map(|trace| trace.rule_id.clone()))
            .next();
        Some(AutomationConflictDiagnostic {
            winning_rule_id,
            candidates,
        })
    }

    fn persist_verification(
        &self,
        change: &AutomationChangeSetRow,
        params: &VerifyAutomationChangeParams,
        requests: &[AutomationVerificationRequestResult],
        evidence: &[String],
        limitations: &[String],
    ) -> Result<AutomationVerificationResult, AutomationError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let tx = conn.transaction().map_err(|error| {
            AutomationError::internal(format!("begin verification transaction: {error}"))
        })?;
        let experiment = automation::load_automation_experiment_by_change(&tx, &change.id)
            .map_err(|error| AutomationError::internal(format!("load experiment: {error}")))?
            .unwrap_or_else(|| AutomationExperimentRow {
                id: uuid::Uuid::new_v4().to_string(),
                change_id: change.id.clone(),
                objective: format!("Verify automation change {}", change.id),
                baseline_session_ids: serde_json::to_string(&params.baseline_session_ids)
                    .unwrap_or_else(|_| "[]".to_string()),
                status: "running".to_string(),
                cleanup_state: "not_started".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
            });
        if automation::load_automation_experiment_by_change(&tx, &change.id)
            .map_err(|error| AutomationError::internal(format!("check experiment: {error}")))?
            .is_none()
        {
            automation::insert_automation_experiment(&tx, &experiment).map_err(|error| {
                AutomationError::internal(format!("insert experiment: {error}"))
            })?;
        }
        let overall_status = if requests.iter().all(|request| request.status == "passed") {
            "passed"
        } else if requests
            .iter()
            .any(|request| request.status == "rule_failed")
        {
            "rule_failed"
        } else if requests
            .iter()
            .any(|request| request.status == "assertion_failed")
        {
            "assertion_failed"
        } else if requests
            .iter()
            .any(|request| request.status == "upstream_failed")
        {
            "upstream_failed"
        } else if requests.iter().any(|request| request.status == "shadowed") {
            "shadowed"
        } else if requests
            .iter()
            .any(|request| request.status == "insufficient_evidence")
        {
            "insufficient_evidence"
        } else {
            "not_matched"
        };
        let evidence_level = match params.mode.as_str() {
            "offline" => "offline",
            "proxy" => "proxy",
            "external" => "external",
            _ => "unknown",
        };
        let result = AutomationVerificationResult {
            verification_id: Some(uuid::Uuid::new_v4().to_string()),
            change_id: change.id.clone(),
            experiment_id: experiment.id.clone(),
            mode: params.mode.clone(),
            evidence_level: evidence_level.to_string(),
            runtime_generation: self.read_rewrite_manager().runtime_generation(),
            status: overall_status.to_string(),
            requests: requests.to_vec(),
            baseline_session_ids: params.baseline_session_ids.clone(),
            evidence_session_ids: evidence.to_vec(),
            limitations: limitations.to_vec(),
        };
        let verification_id = result.verification_id.clone().unwrap();
        automation::insert_automation_verification(
            &tx,
            &AutomationVerificationRow {
                id: verification_id.clone(),
                experiment_id: experiment.id.clone(),
                mode: params.mode.clone(),
                request_json: serde_json::to_string(&params.requests)
                    .unwrap_or_else(|_| "[]".to_string()),
                assertions_json: serde_json::to_string(&params.assertions)
                    .unwrap_or_else(|_| "[]".to_string()),
                result_json: serde_json::to_string(&result).map_err(|error| {
                    AutomationError::internal(format!("serialize verification result: {error}"))
                })?,
                evidence_session_ids: serde_json::to_string(evidence)
                    .unwrap_or_else(|_| "[]".to_string()),
                limitations_json: serde_json::to_string(limitations)
                    .unwrap_or_else(|_| "[]".to_string()),
                created_at: now,
            },
        )
        .map_err(|error| AutomationError::internal(format!("insert verification: {error}")))?;
        tx.commit()
            .map_err(|error| AutomationError::internal(format!("commit verification: {error}")))?;
        Ok(result)
    }

    fn change_lifecycle(&self, change_id: Option<&str>) -> Option<&'static str> {
        let change_id = change_id?;
        let conn = self.lock_db_for_ipc().ok()?;
        let change = automation::load_automation_change_set(&conn, change_id).ok()??;
        if change.lifecycle == "ephemeral" {
            Some("ephemeral")
        } else {
            Some("persistent")
        }
    }

    fn emit_automation_changed(&self, reason: &str, change_ids: &[String], generation: u64) {
        let Some(handle) = self.read_app_handle() else {
            return;
        };
        for change_id in change_ids {
            let (change, experiment, affected_resources) = self
                .lock_db_for_ipc()
                .ok()
                .map(|conn| {
                    let change = automation::load_automation_change_set(&conn, change_id)
                        .ok()
                        .flatten();
                    let experiment =
                        automation::load_automation_experiment_by_change(&conn, change_id)
                            .ok()
                            .flatten();
                    let affected_resources =
                        automation::load_automation_change_items(&conn, change_id)
                            .map(|items| {
                                items
                                    .into_iter()
                                    .map(|item| {
                                        json!({
                                            "kind": item.resource_kind,
                                            "id": item.resource_id,
                                            "operation": item.operation,
                                        })
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                    (change, experiment, affected_resources)
                })
                .unwrap_or((None, None, Vec::new()));
            let _ = handle.emit(
                "automation-changed",
                json!({
                    "reason": reason,
                    "changeId": change_id,
                    "changeIds": change_ids,
                    "runtimeGeneration": generation,
                    "scope": change.as_ref().map(|value| value.scope.clone()),
                    "workspaceId": change.as_ref().and_then(|value| value.workspace_id.clone()),
                    "lifecycle": change.as_ref().map(|value| value.lifecycle.clone()),
                    "status": change.as_ref().map(|value| value.status.clone()),
                    "affectedResources": affected_resources,
                    "experimentId": experiment.as_ref().map(|value| value.id.clone()),
                    "cleanupState": experiment.as_ref().map(|value| value.cleanup_state.clone()),
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                }),
            );
        }
    }
}

pub fn spawn_automation_maintenance(state: std::sync::Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            if let Err(error) = state.cleanup_expired_automation().await {
                tracing::warn!(
                    component = "desktop.automation",
                    event = "automation_expiry_failed",
                    error = %error.message,
                    "automation_expiry_failed"
                );
            }
        }
    });
}

fn proxy_verification_unavailable(reason: &str, message: impl Into<String>) -> AutomationError {
    let message = message.into();
    AutomationError::new("PROXY_VERIFICATION_UNAVAILABLE", message.clone())
        .with_details(json!({ "reason": reason, "message": message }))
}

fn validate_proxy_verification_target(
    method: &str,
    url: &str,
    allowed_origins: &[String],
) -> Result<(String, bool), AutomationError> {
    let method = method.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "proxy verification only allows GET, HEAD, and OPTIONS",
        ));
    }
    let parsed = url::Url::parse(url).map_err(|error| {
        AutomationError::new(
            "INVALID_ARGUMENT",
            format!("proxy verification URL is invalid: {error}"),
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "proxy verification URL must use http or https",
        ));
    }
    let origin = parsed.origin().ascii_serialization();
    if !allowed_origins.iter().any(|allowed| allowed == &origin) {
        return Err(AutomationError::new(
            "ORIGIN_NOT_ALLOWED",
            "The verification target origin is not in the Agent Access proxied verification whitelist.",
        )
        .with_details(json!({ "origin": origin })));
    }
    Ok((method, parsed.scheme() == "https"))
}

fn host_for_url(url: &str) -> Result<String, AutomationError> {
    let parsed = url::Url::parse(url).map_err(|error| {
        AutomationError::new(
            "INVALID_ARGUMENT",
            format!("verification URL is invalid: {error}"),
        )
    })?;
    parsed
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .ok_or_else(|| {
            AutomationError::new("INVALID_ARGUMENT", "verification URL must include a host")
        })
}

fn ensure_proxy_transformation_stays_on_origin(
    original_url: &str,
    final_url: &str,
    traces: &[aiproxy_proxy_core::RewriteTrace],
) -> Result<(), AutomationError> {
    let original_host = host_for_url(original_url)?;
    let final_host = host_for_url(final_url)?;
    if final_host != original_host {
        return Err(AutomationError::new(
            "CONTROL_PERMISSION_DENIED",
            "proxy verification refused a cross-host rule transformation",
        )
        .with_details(json!({
            "originalUrl": original_url,
            "finalUrl": final_url,
            "originalHost": original_host,
            "finalHost": final_host,
        })));
    }
    for trace in traces {
        for entry in &trace.entries {
            if entry.kind != "redirect" {
                continue;
            }
            let Some(target) = entry.after.as_deref() else {
                continue;
            };
            let target_host = host_for_url(target)?;
            if target_host != original_host {
                return Err(AutomationError::new(
                    "CONTROL_PERMISSION_DENIED",
                    "proxy verification refused a cross-host rewrite redirect",
                )
                .with_details(json!({
                    "ruleId": trace.rule_id,
                    "ruleName": trace.rule_name,
                    "originalUrl": original_url,
                    "redirectTarget": target,
                    "originalHost": original_host,
                    "targetHost": target_host,
                })));
            }
        }
    }
    Ok(())
}

fn reserve_proxy_verification_slots(count: usize) -> Result<(), AutomationError> {
    let times = PROXY_VERIFICATION_TIMES.get_or_init(|| Mutex::new(VecDeque::new()));
    let mut times = times.lock().unwrap_or_else(|error| error.into_inner());
    let now = Instant::now();
    while times
        .front()
        .is_some_and(|started| now.duration_since(*started) >= Duration::from_secs(60))
    {
        times.pop_front();
    }
    if times.len() + count > MAX_PROXY_VERIFICATION_REQUESTS_PER_MINUTE {
        return Err(AutomationError::new(
            "RATE_LIMITED",
            format!(
                "Proxy verification allows at most {MAX_PROXY_VERIFICATION_REQUESTS_PER_MINUTE} requests per minute."
            ),
        ));
    }
    for _ in 0..count {
        times.push_back(now);
    }
    Ok(())
}

fn is_proxy_verification_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "content-length"
            | "connection"
            | "proxy-connection"
            | "proxy-authorization"
            | "transfer-encoding"
            | "expect"
    )
}

async fn read_bounded_reqwest_body(
    mut response: reqwest::Response,
) -> Result<Vec<u8>, AutomationError> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        AutomationError::new(
            "UPSTREAM_UNREACHABLE",
            format!("Read proxy verification response: {error}"),
        )
    })? {
        if body.len() + chunk.len() > MAX_PROXY_VERIFICATION_BODY_BYTES {
            return Err(AutomationError::new(
                "RESULT_TOO_LARGE",
                format!(
                    "Proxy verification response exceeds the {} KiB limit.",
                    MAX_PROXY_VERIFICATION_BODY_BYTES / 1024
                ),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn session_url(request_url: &str, response_url: &str) -> String {
    if response_url.trim().is_empty() {
        request_url.to_string()
    } else {
        response_url.to_string()
    }
}

fn build_proxy_observations(
    status: u16,
    final_url: &str,
    response_headers: &[aiproxy_proxy_core::OfflineHeader],
    response_body: &[u8],
    duration_ms: u64,
    detail: Option<&aiproxy_proxy_core::ProxySessionDetail>,
    matched: &[String],
) -> HashMap<(String, String), Observation> {
    let mut observations = HashMap::new();
    observations.insert(
        ("status".to_string(), String::new()),
        Observation::Value(json!(status)),
    );
    if let Some(detail) = detail {
        for header in &detail.request_headers {
            observations.insert(
                (
                    "requestHeader".to_string(),
                    header.name.to_ascii_lowercase(),
                ),
                Observation::Value(json!(header.value)),
            );
        }
    }
    for header in response_headers {
        observations.insert(
            (
                "responseHeader".to_string(),
                header.name.to_ascii_lowercase(),
            ),
            Observation::Value(json!(header.value)),
        );
    }
    if let Ok(url) = url::Url::parse(final_url) {
        for (name, value) in url.query_pairs() {
            observations.insert(
                ("queryParam".to_string(), name.to_string()),
                Observation::Value(json!(value.to_string())),
            );
        }
    }
    observations.insert(
        ("responseBody".to_string(), String::new()),
        Observation::Value(json!(String::from_utf8_lossy(response_body))),
    );
    observations.insert(
        ("ruleTrace".to_string(), String::new()),
        Observation::Value(json!({
            "rewrite": detail.map(|detail| detail.rewrite_traces.as_slice()).unwrap_or(&[]),
            "map": detail.map(|detail| detail.map_traces.as_slice()).unwrap_or(&[]),
            "matchedRuleIds": matched,
        })),
    );
    observations.insert(
        ("durationMs".to_string(), String::new()),
        Observation::Value(json!(duration_ms)),
    );
    observations
}

fn validate_plan_shape(plan: &AutomationPlan) -> Result<(), AutomationError> {
    if plan.scope != "workspace" && plan.scope != "global" {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "scope must be workspace or global",
        ));
    }
    if plan.scope == "workspace"
        && plan
            .workspace_id
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "workspaceId is required when scope=workspace",
        ));
    }
    if plan.lifecycle != "persistent" && plan.lifecycle != "ephemeral" {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "lifecycle must be persistent or ephemeral",
        ));
    }
    if plan.lifecycle == "ephemeral" {
        let ttl = plan.ttl_seconds.unwrap_or(600);
        if !(60..=3600).contains(&ttl) {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "ephemeral ttlSeconds must be between 60 and 3600",
            ));
        }
    }
    let key_len = plan.idempotency_key.len();
    if !(MIN_IDEMPOTENCY_KEY_BYTES..=MAX_IDEMPOTENCY_KEY_BYTES).contains(&key_len) {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "idempotencyKey must be 16-128 bytes",
        ));
    }
    let total = plan.upserts.resource_count() + plan.deletes.len();
    if total == 0 || total > MAX_PLAN_ITEMS {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("automation plans must contain 1-{MAX_PLAN_ITEMS} changes"),
        ));
    }
    let mut upsert_resources = HashSet::new();
    {
        let mut record_upsert = |kind: &str, id: &str| -> Result<(), AutomationError> {
            if !upsert_resources.insert((kind.to_string(), id.to_string())) {
                return Err(AutomationError::new(
                    "INVALID_ARGUMENT",
                    format!("plan contains duplicate {kind} update for resource {id}"),
                )
                .with_details(json!({ "kind": kind, "resourceId": id })));
            }
            Ok(())
        };
        for upsert in &plan.upserts.rewrite {
            if let Some(id) = upsert.id.as_deref() {
                record_upsert("rewrite", id)?;
            }
        }
        for upsert in &plan.upserts.map {
            if let Some(id) = upsert.id.as_deref() {
                record_upsert("map", id)?;
            }
        }
    }
    let mut deleted_resources = HashSet::new();
    for delete in &plan.deletes {
        let key = (delete.kind.clone(), delete.id.clone());
        if !deleted_resources.insert(key.clone()) {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                format!(
                    "plan contains duplicate {} delete for resource {}",
                    delete.kind, delete.id
                ),
            )
            .with_details(json!({
                "kind": delete.kind,
                "resourceId": delete.id,
            })));
        }
        if upsert_resources.contains(&key) {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                format!(
                    "plan cannot both update and delete {} resource {}",
                    delete.kind, delete.id
                ),
            )
            .with_details(json!({
                "kind": delete.kind,
                "resourceId": delete.id,
            })));
        }
    }
    if plan.activation.is_some() {
        return Err(AutomationError::new(
            "FEATURE_NOT_AVAILABLE",
            "Throttle activation is not available in this release",
        ));
    }
    if !plan.upserts.dns.is_empty() {
        return Err(AutomationError::new(
            "FEATURE_NOT_AVAILABLE",
            "DNS automation is not available in this release",
        ));
    }
    if !plan.upserts.script.is_empty() {
        return Err(AutomationError::new(
            "FEATURE_NOT_AVAILABLE",
            "Script automation is not available in this release",
        ));
    }
    if !plan.upserts.throttle_profile.is_empty() || !plan.upserts.throttle_rule.is_empty() {
        return Err(AutomationError::new(
            "FEATURE_NOT_AVAILABLE",
            "Throttle automation is not available in this release",
        ));
    }
    if !plan.upserts.breakpoint.is_empty() {
        return Err(AutomationError::new(
            "FEATURE_NOT_AVAILABLE",
            "Breakpoint writes are not available in this release",
        ));
    }
    if plan.scope == "global" {
        return Err(AutomationError::new(
            "FEATURE_NOT_AVAILABLE",
            "global automation is not available in this release",
        ));
    }
    if plan.lifecycle == "ephemeral" {
        let has_updates = plan
            .upserts
            .rewrite
            .iter()
            .any(|upsert| upsert.id.is_some() || upsert.expected_version.is_some())
            || plan
                .upserts
                .map
                .iter()
                .any(|upsert| upsert.id.is_some() || upsert.expected_version.is_some());
        if has_updates || !plan.deletes.is_empty() {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "ephemeral plans may only create new resources",
            ));
        }
    }
    let serialized = serde_json::to_vec(plan).map_err(|error| {
        AutomationError::internal(format!("serialize automation plan: {error}"))
    })?;
    if serialized.len() > MAX_PLAN_BYTES {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "automation plan exceeds 3 MiB",
        ));
    }
    let mut kinds = HashMap::new();
    for upsert in &plan.upserts.rewrite {
        *kinds.entry("rewrite").or_insert(0usize) += 1;
        if upsert.id.is_some() && upsert.expected_version.is_none() {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "updates require expectedVersion",
            ));
        }
    }
    for upsert in &plan.upserts.map {
        *kinds.entry("map").or_insert(0usize) += 1;
        if upsert.id.is_some() && upsert.expected_version.is_none() {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "updates require expectedVersion",
            ));
        }
    }
    if kinds.values().any(|count| *count > MAX_PLAN_ITEMS) {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "each resource kind is limited to 100 changes",
        ));
    }
    Ok(())
}

fn validate_assertion(assertion: &AutomationAssertion) -> Result<(), AutomationError> {
    if assertion.id.trim().is_empty() || assertion.id.len() > 128 {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "assertion id must be 1-128 bytes",
        ));
    }
    if !matches!(
        assertion.subject.as_str(),
        "status"
            | "requestHeader"
            | "responseHeader"
            | "responseBody"
            | "queryParam"
            | "ruleTrace"
            | "durationMs"
    ) {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("unsupported assertion subject {}", assertion.subject),
        ));
    }
    if !matches!(
        assertion.operator.as_str(),
        "equals" | "contains" | "exists" | "notExists" | "gte" | "lte"
    ) {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("unsupported assertion operator {}", assertion.operator),
        ));
    }
    if matches!(
        assertion.operator.as_str(),
        "equals" | "contains" | "gte" | "lte"
    ) && assertion.expected.is_none()
    {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("assertion {} requires expected", assertion.id),
        ));
    }
    Ok(())
}

fn validate_asset(asset: &AutomationAsset) -> Result<(), AutomationError> {
    if asset.r#ref.trim().is_empty() || asset.r#ref.len() > 128 {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "asset ref must be 1-128 bytes",
        ));
    }
    if asset.file_name.trim().is_empty() || asset.file_name.len() > 255 {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "asset fileName must be 1-255 bytes",
        ));
    }
    if Path::new(&asset.file_name)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(asset.file_name.as_str())
    {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "asset fileName must not contain path separators",
        ));
    }
    BASE64_STANDARD
        .decode(&asset.content_base64)
        .map_err(|error| {
            AutomationError::new(
                "INVALID_ARGUMENT",
                format!("asset {} is not valid base64: {error}", asset.r#ref),
            )
        })?;
    Ok(())
}

fn validate_ref(reference: &str, refs: &mut HashSet<String>) -> Result<(), AutomationError> {
    if reference.trim().is_empty() || reference.len() > 128 {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "resource ref must be 1-128 bytes",
        ));
    }
    if !refs.insert(reference.to_string()) {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("duplicate ref {reference}"),
        ));
    }
    Ok(())
}

fn preview_asset_paths(
    root: &Path,
    change_id: &str,
    assets: &[AutomationAsset],
) -> Result<HashMap<String, PathBuf>, AutomationError> {
    let mut paths = HashMap::new();
    for asset in assets {
        validate_asset(asset)?;
        paths.insert(
            asset.r#ref.clone(),
            root.join(change_id).join(&asset.file_name),
        );
    }
    Ok(paths)
}

fn resolve_map_target(
    resource: &AutomationMapResource,
    asset_paths: &HashMap<String, PathBuf>,
    existing_target: Option<&str>,
    approved_roots: &[String],
) -> Result<String, AutomationError> {
    if let Some(asset_ref) = resource.managed_asset_ref.as_deref() {
        return asset_paths
            .get(asset_ref)
            .map(|path| path.display().to_string())
            .ok_or_else(|| {
                AutomationError::new(
                    "INVALID_ARGUMENT",
                    format!("managedAssetRef {asset_ref} does not exist in assets"),
                )
            });
    }
    if let Some(approved_path) = resource.approved_path.as_deref() {
        return resolve_approved_path(approved_path, approved_roots);
    }
    if let Some(target_value) = resource.target_value.as_deref() {
        if existing_target == Some(target_value) {
            return Ok(target_value.to_string());
        }
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "targetValue is retained for updates only; use managedAssetRef or approvedPath to select a local target",
        ));
    }
    if let Some(existing_target) = existing_target {
        return Ok(existing_target.to_string());
    }
    Err(AutomationError::new(
        "INVALID_ARGUMENT",
        "map resource requires managedAssetRef or approvedPath",
    ))
}

fn resolve_approved_path(
    approved_path: &str,
    approved_roots: &[String],
) -> Result<String, AutomationError> {
    let requested = Path::new(approved_path);
    if requested
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "approvedPath must not contain parent-directory traversal",
        ));
    }
    let requested = std::fs::canonicalize(requested).map_err(|error| {
        AutomationError::new(
            "INVALID_ARGUMENT",
            format!("approvedPath does not resolve to a readable file: {error}"),
        )
    })?;
    let mut matched = false;
    for root in approved_roots {
        let Ok(root) = std::fs::canonicalize(root) else {
            continue;
        };
        if path_is_within(&requested, &root) {
            matched = true;
            break;
        }
    }
    if !matched {
        return Err(AutomationError::new(
            "PATH_NOT_APPROVED",
            "approvedPath is outside the user-approved Map Local roots (or no roots are approved)",
        ));
    }
    Ok(requested.to_string_lossy().into_owned())
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = path.to_string_lossy().to_lowercase();
        let root = root.to_string_lossy().to_lowercase();
        path == root
            || path.starts_with(&format!("{root}\\"))
            || path.starts_with(&format!("{root}/"))
    }
    #[cfg(not(windows))]
    {
        path == root || path.starts_with(root)
    }
}

fn ensure_resource_in_plan_scope(
    kind: &str,
    resource_id: &str,
    resource_workspace_id: &str,
    plan_workspace_id: &str,
) -> Result<(), AutomationError> {
    if resource_workspace_id == plan_workspace_id {
        return Ok(());
    }
    Err(AutomationError::new(
        "SCOPE_CONFLICT",
        format!("{kind} resource belongs to a different workspace"),
    )
    .with_details(json!({ "kind": kind, "resourceId": resource_id })))
}

fn ensure_persistent_update_allowed(
    conn: &aiproxy_db::rusqlite::Connection,
    plan_lifecycle: &str,
    kind: &str,
    id: &str,
    metadata: Option<&AutomationResourceRow>,
) -> Result<(), AutomationError> {
    if plan_lifecycle != "persistent" {
        return Ok(());
    }
    let Some(change_id) = metadata.and_then(|row| row.change_id.as_deref()) else {
        return Ok(());
    };
    let change = automation::load_automation_change_set(conn, change_id)
        .map_err(|error| AutomationError::internal(format!("load resource lifecycle: {error}")))?
        .ok_or_else(|| {
            AutomationError::internal(format!(
                "resource {kind}:{id} points at missing automation change {change_id}"
            ))
        })?;
    if change.lifecycle == "ephemeral" {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!(
                "persistent plans cannot update {kind} resource {id} while it belongs to an ephemeral change; wait for expiry or clear Agent automation first"
            ),
        )
        .with_details(json!({
            "kind": kind,
            "resourceId": id,
            "changeId": change_id,
            "resourceLifecycle": change.lifecycle,
            "planLifecycle": plan_lifecycle,
        })));
    }
    Ok(())
}

fn validate_rewrite_redirect_target(
    payload: &Value,
    match_host: &str,
    rule_id: &str,
) -> Result<(), AutomationError> {
    let target_url = payload
        .get("targetUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AutomationError::new(
                "INVALID_ARGUMENT",
                format!("redirect action for rewrite resource {rule_id} requires targetUrl"),
            )
        })?;
    let target = url::Url::parse(target_url).map_err(|error| {
        AutomationError::new(
            "INVALID_ARGUMENT",
            format!("redirect targetUrl for rewrite resource {rule_id} is invalid: {error}"),
        )
    })?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("redirect targetUrl for rewrite resource {rule_id} must use http or https"),
        ));
    }
    let target_host = target
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .ok_or_else(|| {
            AutomationError::new(
                "INVALID_ARGUMENT",
                format!("redirect targetUrl for rewrite resource {rule_id} must include a host"),
            )
        })?;
    if target_host != match_host.trim_end_matches('.').to_ascii_lowercase() {
        return Err(AutomationError::new(
            "FEATURE_NOT_AVAILABLE",
            format!(
                "cross-host redirect targets are not available in this release; rewrite resource {rule_id} matches {match_host} but redirects to {target_host}"
            ),
        )
        .with_details(json!({
            "ruleId": rule_id,
            "matchHost": match_host,
            "targetHost": target_host,
            "targetUrl": target_url,
        })));
    }
    Ok(())
}

fn build_rewrite_rule(
    workspace_id: &str,
    id: String,
    resource: &AutomationRewriteResource,
    existing: Option<&RewriteRule>,
) -> Result<RewriteRule, AutomationError> {
    if resource.name.trim().is_empty() || resource.name.len() > 256 {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "rewrite name must be 1-256 bytes",
        ));
    }
    if resource.r#match.url_pattern.trim().is_empty() {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "rewrite urlPattern is required",
        ));
    }
    let match_host = exact_pattern_host(&resource.r#match.url_pattern, "rewrite urlPattern")?;
    if resource.actions.is_empty() {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "rewrite actions must contain at least one action",
        ));
    }
    if resource.actions.len() > 100 {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "rewrite actions are limited to 100 entries",
        ));
    }
    for action in &resource.actions {
        let object = action.as_object().ok_or_else(|| {
            AutomationError::new("INVALID_ARGUMENT", "rewrite actions must be objects")
        })?;
        if !object.get("rewriteType").is_some_and(Value::is_string)
            || !object.get("payload").is_some_and(Value::is_object)
        {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "rewrite actions require rewriteType and payload",
            ));
        }
        if object
            .get("rewriteType")
            .and_then(Value::as_str)
            .is_some_and(|rewrite_type| rewrite_type.eq_ignore_ascii_case("redirect"))
        {
            validate_rewrite_redirect_target(
                object.get("payload").unwrap_or(&Value::Null),
                &match_host,
                &id,
            )?;
        }
    }
    let rewrite_type = resource
        .rewrite_type
        .clone()
        .or_else(|| {
            resource.actions.first().and_then(|action| {
                action
                    .get("rewriteType")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        })
        .unwrap_or_else(|| "header".to_string());
    Ok(RewriteRule {
        actions: Some(resource.actions.clone()),
        enabled: resource
            .enabled
            .or_else(|| existing.map(|rule| rule.enabled))
            .unwrap_or(false),
        id,
        name: resource.name.clone(),
        note: resource.note.clone(),
        // Action-array rules round-trip through the database with a null legacy payload.
        // Normalize here so resourceVersion remains stable across reloads and rollback.
        payload: Value::Null,
        priority: resource.priority,
        r#match: RewriteRuleMatch {
            match_type: resource.r#match.match_type.clone(),
            methods: resource.r#match.methods.clone(),
            stage: resource.r#match.stage.clone(),
            url_pattern: resource.r#match.url_pattern.clone(),
        },
        rewrite_type,
        workspace_id: workspace_id.to_string(),
    })
}

fn build_map_rule(
    workspace_id: &str,
    id: String,
    resource: &AutomationMapResource,
    target_value: String,
    existing: Option<&MapRule>,
) -> Result<MapRule, AutomationError> {
    if resource.mode != "local" {
        return Err(AutomationError::new(
            "FEATURE_NOT_AVAILABLE",
            "Map Remote is not available in this release",
        ));
    }
    if resource.name.trim().is_empty() || resource.name.len() > 256 {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "map name must be 1-256 bytes",
        ));
    }
    if resource.source_pattern.trim().is_empty() {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "map sourcePattern is required",
        ));
    }
    exact_pattern_host(&resource.source_pattern, "map sourcePattern")?;
    if resource.managed_asset_ref.is_none() && !Path::new(&target_value).is_file() {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("map local target must be an existing file: {target_value}"),
        ));
    }
    Ok(MapRule {
        enabled: resource
            .enabled
            .or_else(|| existing.map(|rule| rule.enabled))
            .unwrap_or(false),
        id,
        mode: "local".to_string(),
        name: resource.name.clone(),
        note: resource.note.clone(),
        preserve_path: resource.preserve_path,
        preserve_query: resource.preserve_query,
        priority: resource.priority,
        source_pattern: resource.source_pattern.clone(),
        target_value,
        match_type: resource.match_type.clone(),
        workspace_id: workspace_id.to_string(),
    })
}

struct AutomationResourceRowInput<'a> {
    kind: &'a str,
    id: &'a str,
    plan: &'a AutomationPlan,
    workspace_id: Option<&'a str>,
    change_id: &'a str,
    expires_at: Option<&'a str>,
    now: &'a str,
    caller: (&'a str, &'a str),
    owner: &'a str,
}

fn automation_resource_row(input: AutomationResourceRowInput<'_>) -> AutomationResourceRow {
    AutomationResourceRow {
        resource_kind: input.kind.to_string(),
        resource_id: input.id.to_string(),
        scope: input.plan.scope.clone(),
        scope_key: automation_scope_key(&input.plan.scope, input.plan.workspace_id.as_deref())
            .unwrap_or_else(|_| "global".to_string()),
        workspace_id: input.workspace_id.map(str::to_string),
        owner_kind: input.owner.to_string(),
        created_by_client: Some(input.caller.0.to_string()),
        created_by_version: Some(input.caller.1.to_string()),
        change_id: Some(input.change_id.to_string()),
        expires_at: input.expires_at.map(str::to_string),
        created_at: input.now.to_string(),
        updated_at: input.now.to_string(),
    }
}

fn automation_scope_key(
    scope: &str,
    workspace_id: Option<&str>,
) -> Result<String, AutomationError> {
    match scope {
        "global" => Ok("global".to_string()),
        "workspace" => workspace_id
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("workspace:{value}"))
            .ok_or_else(|| AutomationError::new("INVALID_ARGUMENT", "workspaceId is required")),
        _ => Err(AutomationError::new(
            "INVALID_ARGUMENT",
            "scope must be workspace or global",
        )),
    }
}

fn rewrite_row(rule: &RewriteRule) -> aiproxy_db::rules::RewriteRuleRow {
    aiproxy_db::rules::RewriteRuleRow {
        id: rule.id.clone(),
        workspace_id: rule.workspace_id.clone(),
        name: rule.name.clone(),
        note: rule.note.clone(),
        enabled: rule.enabled,
        priority: rule.priority,
        match_methods: serde_json::to_string(&rule.r#match.methods)
            .unwrap_or_else(|_| "[]".to_string()),
        match_stage: rule.r#match.stage.clone(),
        match_url_pattern: rule.r#match.url_pattern.clone(),
        match_type: rule
            .r#match
            .match_type
            .clone()
            .unwrap_or_else(|| "contains".to_string()),
        rewrite_type: rule.rewrite_type.clone(),
        // Legacy rows persist a single action object in `payload` and have no
        // `actions` array. Preserve that shape on write so rolling an update
        // back does not replace the object with `"null"`.
        payload: if rule.actions.is_some() {
            serde_json::to_string(&rule.actions).unwrap_or_else(|_| "[]".to_string())
        } else {
            serde_json::to_string(&rule.payload).unwrap_or_else(|_| "null".to_string())
        },
    }
}

fn map_row(rule: &MapRule) -> aiproxy_db::rules::MapRuleRow {
    aiproxy_db::rules::MapRuleRow {
        id: rule.id.clone(),
        workspace_id: rule.workspace_id.clone(),
        mode: rule.mode.clone(),
        name: rule.name.clone(),
        note: rule.note.clone(),
        enabled: rule.enabled,
        preserve_path: rule.preserve_path,
        preserve_query: rule.preserve_query,
        priority: rule.priority,
        source_pattern: rule.source_pattern.clone(),
        target_value: rule.target_value.clone(),
        match_type: rule
            .match_type
            .clone()
            .unwrap_or_else(|| "contains".to_string()),
    }
}

fn resource_summary_for_rewrite(
    rule: &RewriteRule,
    metadata: Option<&AutomationResourceRow>,
    lifecycle: Option<&str>,
) -> Result<AutomationResourceSummary, AutomationError> {
    Ok(AutomationResourceSummary {
        kind: "rewrite".to_string(),
        id: rule.id.clone(),
        version: hash_json(
            &serde_json::to_value(rule).map_err(|error| {
                AutomationError::internal(format!("serialize rewrite: {error}"))
            })?,
        )?,
        name: rule.name.clone(),
        enabled: rule.enabled,
        priority: rule.priority,
        scope: metadata
            .map(|row| row.scope.clone())
            .unwrap_or_else(|| "workspace".to_string()),
        workspace_id: Some(rule.workspace_id.clone()),
        owner: metadata
            .map(|row| row.owner_kind.clone())
            .unwrap_or_else(|| "user".to_string()),
        lifecycle: lifecycle.unwrap_or("persistent").to_string(),
        expires_at: metadata.and_then(|row| row.expires_at.clone()),
        change_id: metadata.and_then(|row| row.change_id.clone()),
    })
}

fn resource_summary_for_map(
    rule: &MapRule,
    metadata: Option<&AutomationResourceRow>,
    lifecycle: Option<&str>,
) -> Result<AutomationResourceSummary, AutomationError> {
    Ok(AutomationResourceSummary {
        kind: "map".to_string(),
        id: rule.id.clone(),
        version: hash_json(
            &serde_json::to_value(rule)
                .map_err(|error| AutomationError::internal(format!("serialize map: {error}")))?,
        )?,
        name: rule.name.clone(),
        enabled: rule.enabled,
        priority: rule.priority,
        scope: metadata
            .map(|row| row.scope.clone())
            .unwrap_or_else(|| "workspace".to_string()),
        workspace_id: Some(rule.workspace_id.clone()),
        owner: metadata
            .map(|row| row.owner_kind.clone())
            .unwrap_or_else(|| "user".to_string()),
        lifecycle: lifecycle.unwrap_or("persistent").to_string(),
        expires_at: metadata.and_then(|row| row.expires_at.clone()),
        change_id: metadata.and_then(|row| row.change_id.clone()),
    })
}

fn hash_json(value: &Value) -> Result<String, AutomationError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        AutomationError::internal(format!("serialize JSON for hashing: {error}"))
    })?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn pattern_host(pattern: &str) -> Option<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return None;
    }
    let authority = pattern
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(pattern)
        .trim_start_matches("//")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    if authority.is_empty() || authority == "*" {
        return None;
    }
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split_once(']').map(|(host, _)| host)?
    } else {
        authority.split(':').next().unwrap_or_default()
    }
    .trim_end_matches('.')
    .to_ascii_lowercase();
    if host.is_empty() || (host.contains('*') && !host.starts_with("*.")) {
        return None;
    }
    Some(host)
}

fn exact_pattern_host(pattern: &str, label: &str) -> Result<String, AutomationError> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("{label} is required"),
        ));
    }
    let parse_target = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = url::Url::parse(&parse_target).map_err(|error| {
        AutomationError::new("INVALID_ARGUMENT", format!("{label} is invalid: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("{label} must use http, https, ws, or wss"),
        ));
    }
    let host = url.host_str().ok_or_else(|| {
        AutomationError::new(
            "INVALID_ARGUMENT",
            format!("{label} must include an exact host"),
        )
    })?;
    if host.contains('*') {
        return Err(AutomationError::new(
            "INVALID_ARGUMENT",
            format!("{label} must contain an exact host; wildcard hosts are not allowed"),
        ));
    }
    Ok(host.to_ascii_lowercase())
}

fn runtime_host_lock_for_resource(
    kind: &str,
    id: &str,
    pattern: &str,
    metadata_by_id: &HashMap<(String, String), AutomationResourceRow>,
) -> Result<Option<String>, AutomationError> {
    let owned_by_agent = metadata_by_id
        .get(&(kind.to_string(), id.to_string()))
        .is_some_and(|metadata| metadata.owner_kind == "agent");
    if !owned_by_agent {
        return Ok(None);
    }
    exact_pattern_host(pattern, "Agent rule pattern").map(Some)
}

fn host_conflicts(target: &str, candidate: Option<&str>) -> bool {
    let Some(candidate) = candidate else {
        return true;
    };
    if target == "*" || candidate == "*" {
        return true;
    }
    if target == candidate {
        return true;
    }
    let target_matches_candidate = target
        .strip_prefix("*.")
        .is_some_and(|suffix| candidate == suffix || candidate.ends_with(&format!(".{suffix}")));
    let candidate_matches_target = candidate
        .strip_prefix("*.")
        .is_some_and(|suffix| target == suffix || target.ends_with(&format!(".{suffix}")));
    target_matches_candidate || candidate_matches_target
}

fn plan_summary(plan: &AutomationPlan) -> String {
    format!(
        "{} {} plan with {} upserts, {} deletes, and {} assets",
        plan.lifecycle,
        plan.scope,
        plan.upserts.resource_count(),
        plan.deletes.len(),
        plan.assets.len()
    )
}

fn via_warnings_for_risk(plan: &AutomationPlan, warnings: &mut Vec<String>) {
    if plan.lifecycle == "ephemeral" {
        warnings.push(
            "Ephemeral resources expire automatically; verify before the TTL elapses.".to_string(),
        );
    }
    if !plan.assets.is_empty() {
        warnings.push("Managed assets are written under the AIProxy data directory and removed with the change.".to_string());
    }
    if plan
        .upserts
        .map
        .iter()
        .any(|upsert| !upsert.resource.preserve_query)
    {
        warnings.push(
            "A Map Local rule that does not preserve the query string may drop request parameters."
                .to_string(),
        );
    }
}

fn dependencies_json(
    asset_ref: Option<&str>,
    metadata_before: Option<&AutomationResourceRow>,
) -> Result<String, AutomationError> {
    Ok(json!({
        "assetRef": asset_ref,
        "metadata": metadata_before.map(serde_json::to_value).transpose().map_err(|error| {
            AutomationError::internal(format!("serialize resource metadata dependency: {error}"))
        })?,
    })
    .to_string())
}

fn parse_metadata_from_dependencies(
    dependencies_json: &str,
) -> Result<Option<AutomationResourceRow>, AutomationError> {
    let value: Value = serde_json::from_str(dependencies_json).unwrap_or(Value::Null);
    let Some(metadata) = value.get("metadata").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    serde_json::from_value(metadata.clone())
        .map(Some)
        .map_err(|error| AutomationError::internal(format!("decode resource metadata: {error}")))
}

pub(crate) fn change_requires_user_automation(items: &[AutomationChangeItemRow]) -> bool {
    items.iter().any(|item| {
        if item.operation == "create" {
            return false;
        }
        parse_metadata_from_dependencies(&item.dependencies_json)
            .ok()
            .flatten()
            .is_none_or(|metadata| metadata.owner_kind == "user")
    })
}

fn apply_result_from_change(
    change: &AutomationChangeSetRow,
    summary: &Value,
    idempotent: bool,
) -> AutomationApplyResult {
    let resource_ids_by_ref = summary
        .get("resourceIdsByRef")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    AutomationApplyResult {
        change_id: change.id.clone(),
        status: change.status.clone(),
        runtime_generation: change.runtime_generation.unwrap_or_default(),
        resource_ids_by_ref,
        expires_at: change.expires_at.clone(),
        idempotent,
    }
}

fn change_view(
    change: AutomationChangeSetRow,
    items: Vec<AutomationChangeItemRow>,
    experiment: Option<AutomationExperimentRow>,
    verifications: Vec<AutomationVerificationRow>,
) -> AutomationChangeView {
    let experiment_value = experiment.as_ref().map(|experiment| {
        json!({
            "id": experiment.id,
            "changeId": experiment.change_id,
            "objective": experiment.objective,
            "baselineSessionIds": serde_json::from_str::<Value>(&experiment.baseline_session_ids).unwrap_or(Value::Null),
            "status": experiment.status,
            "cleanupState": experiment.cleanup_state,
            "createdAt": experiment.created_at,
            "updatedAt": experiment.updated_at,
        })
    });
    let verification_values = verifications
        .into_iter()
        .map(|verification| {
            json!({
                "id": verification.id,
                "experimentId": verification.experiment_id,
                "mode": verification.mode,
                "request": serde_json::from_str::<Value>(&verification.request_json).unwrap_or(Value::Null),
                "assertions": serde_json::from_str::<Value>(&verification.assertions_json).unwrap_or(Value::Null),
                "result": serde_json::from_str::<Value>(&verification.result_json).unwrap_or(Value::Null),
                "evidenceSessionIds": serde_json::from_str::<Value>(&verification.evidence_session_ids).unwrap_or(Value::Null),
                "limitations": serde_json::from_str::<Value>(&verification.limitations_json).unwrap_or(Value::Null),
                "createdAt": verification.created_at,
            })
        })
        .collect();
    let items = items
        .into_iter()
        .map(|item| AutomationChangeItemView {
            resource_kind: item.resource_kind,
            resource_id: item.resource_id,
            operation: item.operation,
            version_before: item.version_before,
            version_after: item.version_after,
            before: item
                .before_json
                .and_then(|value| serde_json::from_str::<Value>(&value).ok()),
            after: item
                .after_json
                .and_then(|value| serde_json::from_str::<Value>(&value).ok()),
            dependencies: serde_json::from_str::<Value>(&item.dependencies_json)
                .unwrap_or(Value::Null),
        })
        .collect();
    AutomationChangeView {
        change_id: change.id,
        scope: change.scope,
        workspace_id: change.workspace_id,
        lifecycle: change.lifecycle,
        status: change.status,
        plan_hash: change.plan_hash,
        scope_hash_before: change.scope_hash_before.clone(),
        scope_hash_after: change.scope_hash_after.clone(),
        runtime_generation: change.runtime_generation,
        created_at: change.created_at,
        activated_at: change.activated_at,
        expires_at: change.expires_at,
        items,
        experiment: experiment_value,
        verifications: verification_values,
        rollback_scope_hash: change.scope_hash_after,
    }
}

fn expired_verification(
    change: &AutomationChangeSetRow,
    params: &VerifyAutomationChangeParams,
    limitation: &str,
    runtime_generation: u64,
) -> AutomationVerificationResult {
    AutomationVerificationResult {
        verification_id: None,
        change_id: change.id.clone(),
        experiment_id: String::new(),
        mode: params.mode.clone(),
        evidence_level: params.mode.clone(),
        runtime_generation,
        status: "expired".to_string(),
        requests: Vec::new(),
        baseline_session_ids: params.baseline_session_ids.clone(),
        evidence_session_ids: params.external_session_ids.clone(),
        limitations: vec![limitation.to_string()],
    }
}

fn offline_request_parts(
    request: &VerificationRequest,
    baseline: Option<&aiproxy_proxy_core::ProxySessionDetail>,
) -> Result<
    (
        String,
        String,
        Vec<aiproxy_proxy_core::OfflineHeader>,
        Vec<u8>,
    ),
    AutomationError,
> {
    let method = request
        .method
        .clone()
        .or_else(|| baseline.map(|detail| detail.summary.method.clone()))
        .unwrap_or_else(|| "GET".to_string());
    let url = request
        .url
        .clone()
        .or_else(|| baseline.map(|detail| detail.summary.url.clone()))
        .ok_or_else(|| {
            AutomationError::new(
                "INVALID_ARGUMENT",
                "offline request requires url or baselineSessionId",
            )
        })?;
    let mut headers = if request.headers.is_empty() {
        baseline
            .map(|detail| {
                detail
                    .request_headers
                    .iter()
                    .filter(|header| !header.name.starts_with(':'))
                    .map(|header| aiproxy_proxy_core::OfflineHeader {
                        name: header.name.clone(),
                        value: header.value.clone(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        request
            .headers
            .iter()
            .map(|header| aiproxy_proxy_core::OfflineHeader {
                name: header.name.clone(),
                value: header.value.clone(),
            })
            .collect()
    };
    let mut body = match &request.body {
        Some(body) => body.as_bytes().to_vec(),
        None => baseline
            .and_then(|detail| detail.request_body.as_ref())
            .map(|body| body.read_bytes())
            .transpose()
            .map_err(AutomationError::internal)?
            .unwrap_or_default(),
    };
    if !request.json_set.is_empty() {
        let mut value: Value = serde_json::from_slice(&body).map_err(|error| {
            AutomationError::new(
                "INVALID_ARGUMENT",
                format!("jsonSet requires a JSON request body: {error}"),
            )
        })?;
        for (path, replacement) in &request.json_set {
            set_json_path(&mut value, path, replacement.clone())?;
        }
        body = serde_json::to_vec(&value).map_err(|error| {
            AutomationError::internal(format!("serialize jsonSet body: {error}"))
        })?;
        headers.retain(|header| !header.name.eq_ignore_ascii_case("content-length"));
    }
    Ok((method, url, headers, body))
}

fn offline_baseline_response(
    detail: &aiproxy_proxy_core::ProxySessionDetail,
) -> Result<aiproxy_proxy_core::OfflineResponseInput, AutomationError> {
    let body = detail
        .response_body
        .as_ref()
        .map(|body| body.read_bytes())
        .transpose()
        .map_err(AutomationError::internal)?
        .unwrap_or_default();
    Ok(OfflineResponseInput {
        status: detail.summary.status_code,
        headers: detail
            .response_headers
            .iter()
            .filter(|header| !header.name.starts_with(':'))
            .map(|header| aiproxy_proxy_core::OfflineHeader {
                name: header.name.clone(),
                value: header.value.clone(),
            })
            .collect(),
        body_base64: Some(BASE64_STANDARD.encode(body)),
    })
}

fn matched_rule_ids(
    rewrite_traces: &[aiproxy_proxy_core::RewriteTrace],
    map_traces: &[aiproxy_proxy_core::MapTrace],
    targets: &HashSet<String>,
) -> Vec<String> {
    let mut ids = rewrite_traces
        .iter()
        .map(|trace| trace.rule_id.clone())
        .chain(map_traces.iter().map(|trace| trace.rule_id.clone()))
        .filter(|id| targets.contains(id))
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids
}

fn classify_match_status(
    targets: &HashSet<String>,
    matched: &[String],
    rewrite_traces: &[aiproxy_proxy_core::RewriteTrace],
    map_traces: &[aiproxy_proxy_core::MapTrace],
) -> String {
    if targets.is_empty() {
        return "insufficient_evidence".to_string();
    }
    if !matched.is_empty() {
        return "passed".to_string();
    }
    if !rewrite_traces.is_empty() || !map_traces.is_empty() {
        "shadowed".to_string()
    } else {
        "not_matched".to_string()
    }
}

#[derive(Debug, Clone)]
enum Observation {
    Missing,
    Value(Value),
}

fn build_offline_observations(
    result: &aiproxy_proxy_core::OfflineEvaluationResult,
    matched: &[String],
) -> HashMap<(String, String), Observation> {
    let mut observations = HashMap::new();
    observations.insert(
        ("status".to_string(), String::new()),
        result
            .response_status
            .map(|value| Observation::Value(json!(value)))
            .unwrap_or(Observation::Missing),
    );
    for header in &result.request_headers {
        observations.insert(
            (
                "requestHeader".to_string(),
                header.name.to_ascii_lowercase(),
            ),
            Observation::Value(json!(header.value)),
        );
    }
    for header in &result.response_headers {
        observations.insert(
            (
                "responseHeader".to_string(),
                header.name.to_ascii_lowercase(),
            ),
            Observation::Value(json!(header.value)),
        );
    }
    if let Ok(url) = url::Url::parse(&result.final_url) {
        for (name, value) in url.query_pairs() {
            observations.insert(
                ("queryParam".to_string(), name.to_string()),
                Observation::Value(json!(value.to_string())),
            );
        }
    }
    let body = BASE64_STANDARD
        .decode(&result.response_body_base64)
        .unwrap_or_default();
    observations.insert(
        ("responseBody".to_string(), String::new()),
        Observation::Value(json!(String::from_utf8_lossy(&body))),
    );
    observations.insert(
        ("ruleTrace".to_string(), String::new()),
        Observation::Value(json!({
            "rewrite": result.rewrite_traces,
            "map": result.map_traces,
            "matchedRuleIds": matched,
        })),
    );
    observations.insert(
        ("durationMs".to_string(), String::new()),
        Observation::Value(json!(0)),
    );
    observations
}

fn build_session_observations(
    detail: &aiproxy_proxy_core::ProxySessionDetail,
    matched: &[String],
) -> HashMap<(String, String), Observation> {
    let mut observations = HashMap::new();
    observations.insert(
        ("status".to_string(), String::new()),
        Observation::Value(json!(detail.summary.status_code)),
    );
    for header in &detail.request_headers {
        observations.insert(
            (
                "requestHeader".to_string(),
                header.name.to_ascii_lowercase(),
            ),
            Observation::Value(json!(header.value)),
        );
    }
    for header in &detail.response_headers {
        observations.insert(
            (
                "responseHeader".to_string(),
                header.name.to_ascii_lowercase(),
            ),
            Observation::Value(json!(header.value)),
        );
    }
    if let Ok(url) = url::Url::parse(&detail.summary.url) {
        for (name, value) in url.query_pairs() {
            observations.insert(
                ("queryParam".to_string(), name.to_string()),
                Observation::Value(json!(value.to_string())),
            );
        }
    }
    let body = detail
        .response_body
        .as_ref()
        .map(|body| body.read_bytes())
        .transpose()
        .ok()
        .flatten()
        .unwrap_or_default();
    observations.insert(
        ("responseBody".to_string(), String::new()),
        Observation::Value(json!(String::from_utf8_lossy(&body))),
    );
    observations.insert(
        ("ruleTrace".to_string(), String::new()),
        Observation::Value(json!({
            "rewrite": detail.rewrite_traces,
            "map": detail.map_traces,
            "matchedRuleIds": matched,
        })),
    );
    observations.insert(
        ("durationMs".to_string(), String::new()),
        Observation::Value(json!(detail.summary.duration_ms as u64)),
    );
    observations
}

fn evaluate_assertions(
    assertions: &[AutomationAssertion],
    observations: &HashMap<(String, String), Observation>,
) -> Vec<AutomationAssertionResult> {
    assertions
        .iter()
        .map(|assertion| {
            let key = (
                assertion.subject.clone(),
                assertion
                    .path
                    .as_deref()
                    .unwrap_or_default()
                    .to_ascii_lowercase(),
            );
            let observation = observations.get(&key).cloned().unwrap_or_else(|| {
                observations
                    .get(&(assertion.subject.clone(), String::new()))
                    .cloned()
                    .unwrap_or(Observation::Missing)
            });
            let observation = match (assertion.subject.as_str(), assertion.path.as_deref()) {
                ("responseBody", Some(path)) | ("ruleTrace", Some(path)) => match observation {
                    Observation::Value(Value::String(body)) => serde_json::from_str::<Value>(&body)
                        .ok()
                        .and_then(|value| json_path_get(&value, path))
                        .map(Observation::Value)
                        .unwrap_or(Observation::Missing),
                    Observation::Value(value) => json_path_get(&value, path)
                        .map(Observation::Value)
                        .unwrap_or(Observation::Missing),
                    Observation::Missing => Observation::Missing,
                },
                _ => observation,
            };
            evaluate_assertion(assertion, observation)
        })
        .collect()
}

fn evaluate_assertion(
    assertion: &AutomationAssertion,
    observation: Observation,
) -> AutomationAssertionResult {
    let actual = match &observation {
        Observation::Missing => None,
        Observation::Value(value) => Some(value.clone()),
    };
    if assertion.operator == "notExists" {
        let passed = matches!(observation, Observation::Missing);
        return AutomationAssertionResult {
            id: assertion.id.clone(),
            subject: assertion.subject.clone(),
            path: assertion.path.clone(),
            passed,
            message: if passed {
                "value does not exist".to_string()
            } else {
                "value exists but was expected to be absent".to_string()
            },
            actual,
        };
    }
    if assertion.operator == "exists" {
        let passed = matches!(observation, Observation::Value(_));
        return AutomationAssertionResult {
            id: assertion.id.clone(),
            subject: assertion.subject.clone(),
            path: assertion.path.clone(),
            passed,
            message: if passed {
                "value exists".to_string()
            } else {
                "value does not exist".to_string()
            },
            actual,
        };
    }
    let Some(actual_value) = actual.clone() else {
        return AutomationAssertionResult {
            id: assertion.id.clone(),
            subject: assertion.subject.clone(),
            path: assertion.path.clone(),
            passed: false,
            message: "value does not exist".to_string(),
            actual,
        };
    };
    let expected = assertion.expected.clone().unwrap_or(Value::Null);
    let passed = match assertion.operator.as_str() {
        "equals" => values_equal(&actual_value, &expected),
        "contains" => value_contains(&actual_value, &expected),
        "gte" => numeric_compare(&actual_value, &expected).is_some_and(|value| value >= 0),
        "lte" => numeric_compare(&actual_value, &expected).is_some_and(|value| value <= 0),
        _ => false,
    };
    AutomationAssertionResult {
        id: assertion.id.clone(),
        subject: assertion.subject.clone(),
        path: assertion.path.clone(),
        passed,
        message: if passed {
            "assertion passed".to_string()
        } else {
            format!(
                "expected {} {}, actual {}",
                assertion.operator, expected, actual_value
            )
        },
        actual,
    }
}

fn values_equal(actual: &Value, expected: &Value) -> bool {
    if actual == expected {
        return true;
    }
    if let (Some(actual), Some(expected)) = (actual.as_str(), expected.as_str()) {
        return actual == expected;
    }
    let actual_number = actual
        .as_f64()
        .or_else(|| actual.as_str().and_then(|value| value.parse::<f64>().ok()));
    let expected_number = expected.as_f64().or_else(|| {
        expected
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
    });
    matches!((actual_number, expected_number), (Some(actual), Some(expected)) if actual == expected)
}

fn value_contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::String(actual), Value::String(expected)) => actual.contains(expected),
        (Value::Array(actual), expected) => {
            actual.iter().any(|value| values_equal(value, expected))
        }
        (actual, expected) => actual.to_string().contains(&expected.to_string()),
    }
}

fn numeric_compare(actual: &Value, expected: &Value) -> Option<i32> {
    let actual = actual
        .as_f64()
        .or_else(|| actual.as_str().and_then(|value| value.parse::<f64>().ok()))?;
    let expected = expected.as_f64().or_else(|| {
        expected
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
    })?;
    Some(if actual > expected {
        1
    } else if actual < expected {
        -1
    } else {
        0
    })
}

fn set_json_path(root: &mut Value, path: &str, value: Value) -> Result<(), AutomationError> {
    let path = path.trim().trim_start_matches('$').trim_start_matches('.');
    if path.is_empty() {
        *root = value;
        return Ok(());
    }
    let mut current = root;
    let segments = path
        .split('.')
        .map(|segment| segment.trim())
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    for (index, segment) in segments.iter().enumerate() {
        if index + 1 == segments.len() {
            let object = current.as_object_mut().ok_or_else(|| {
                AutomationError::new(
                    "INVALID_ARGUMENT",
                    format!("jsonSet path {path} does not address an object"),
                )
            })?;
            object.insert((*segment).to_string(), value);
            return Ok(());
        }
        current = current
            .as_object_mut()
            .and_then(|object| object.get_mut(*segment))
            .ok_or_else(|| {
                AutomationError::new(
                    "INVALID_ARGUMENT",
                    format!("jsonSet path {path} does not exist"),
                )
            })?;
    }
    Ok(())
}

fn json_path_get(root: &Value, path: &str) -> Option<Value> {
    let mut normalized = path.trim().trim_start_matches('$').trim();
    if normalized.is_empty() {
        return Some(root.clone());
    }
    let mut current = root;
    while !normalized.is_empty() {
        normalized = normalized.trim_start_matches('.');
        if normalized.is_empty() {
            break;
        }
        if let Some(rest) = normalized.strip_prefix('[') {
            let end = rest.find(']')?;
            let index = rest[..end].parse::<usize>().ok()?;
            current = current.get(index)?;
            normalized = &rest[end + 1..];
            continue;
        }
        let end = normalized.find(['.', '[']).unwrap_or(normalized.len());
        let key = &normalized[..end];
        current = current.get(key)?;
        normalized = &normalized[end..];
    }
    Some(current.clone())
}

fn remove_staged_assets(root: &Path, change_id: &str) -> std::io::Result<()> {
    let path = root.join(change_id);
    if path.exists() {
        std::fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiproxy_agent_control::{
        AgentRuleAction, AutomationDelete, AutomationRewriteMatch, AutomationUpsert,
        AutomationUpserts, CreateAgentRuleParams,
    };
    use aiproxy_db::body_store::BodyStore;
    use aiproxy_db::workspaces::WorkspaceRow;
    use aiproxy_proxy_core::{ProxyHeaderEntry, ProxySessionDetail, ProxySessionSummary};
    use std::sync::Arc;
    use tempfile::TempDir;

    const WORKSPACE_ID: &str = "workspace-test";

    struct TestHarness {
        state: AppState,
        body_store: Arc<BodyStore>,
        _directory: TempDir,
    }

    fn test_harness() -> TestHarness {
        let directory = tempfile::tempdir().unwrap();
        let conn = aiproxy_db::rusqlite::Connection::open_in_memory().unwrap();
        aiproxy_db::schema::run_migrations(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        aiproxy_db::workspaces::upsert_workspace(
            &conn,
            &WorkspaceRow {
                id: WORKSPACE_ID.to_string(),
                name: "Automation tests".to_string(),
                proxy_port: 8888,
                ssl_enabled: false,
                http2_enabled: true,
                system_proxy_enabled: false,
                verify_upstream_tls: false,
                tls_verify_hosts: "[]".to_string(),
                ssl_blind_hosts: "[]".to_string(),
                upstream_proxy: String::new(),
                ssl_proxying: String::new(),
                storage_path: directory.path().display().to_string(),
                created_at: now.clone(),
                updated_at: now,
            },
        )
        .unwrap();
        let body_store = Arc::new(BodyStore::new(directory.path().join("bodies")));
        body_store.ensure_dir().unwrap();
        let state = AppState::new(Arc::new(Mutex::new(conn)), Arc::clone(&body_store));
        TestHarness {
            state,
            body_store,
            _directory: directory,
        }
    }

    fn automation_permissions() -> AutomationPermissions {
        AutomationPermissions {
            manage_automation: true,
            manage_user_automation: true,
            manage_proxied_verification: true,
            ..AutomationPermissions::default()
        }
    }

    fn rewrite_resource(name: &str, host: &str, enabled: bool) -> AutomationRewriteResource {
        AutomationRewriteResource {
            enabled: Some(enabled),
            name: name.to_string(),
            note: None,
            priority: 10,
            r#match: AutomationRewriteMatch {
                methods: vec!["GET".to_string()],
                stage: "request".to_string(),
                url_pattern: format!("https://{host}/v1/*"),
                match_type: Some("wildcard".to_string()),
            },
            rewrite_type: Some("header".to_string()),
            actions: vec![json!({
                "rewriteType": "header",
                "payload": {
                    "headerName": "X-Agent-Experiment",
                    "operation": "set",
                    "target": "request",
                    "value": "active"
                }
            })],
            payload: json!({}),
        }
    }

    fn rewrite_plan(
        key: &str,
        lifecycle: &str,
        resource: AutomationRewriteResource,
    ) -> AutomationPlan {
        AutomationPlan {
            scope: "workspace".to_string(),
            workspace_id: Some(WORKSPACE_ID.to_string()),
            lifecycle: lifecycle.to_string(),
            ttl_seconds: (lifecycle == "ephemeral").then_some(600),
            idempotency_key: key.to_string(),
            upserts: AutomationUpserts {
                rewrite: vec![AutomationUpsert {
                    id: None,
                    expected_version: None,
                    r#ref: Some("rewrite".to_string()),
                    resource,
                }],
                ..AutomationUpserts::default()
            },
            deletes: Vec::new(),
            activation: None,
            assets: Vec::new(),
        }
    }

    fn validate(
        harness: &TestHarness,
        plan: &AutomationPlan,
        permissions: &AutomationPermissions,
    ) -> Result<AutomationValidationResult, AutomationError> {
        tauri::async_runtime::block_on(harness.state.validate_automation_plan(
            ValidateAutomationPlanParams { plan: plan.clone() },
            ("test-agent", "1.0"),
            permissions.clone(),
        ))
    }

    fn apply_validated(
        harness: &TestHarness,
        plan: &AutomationPlan,
        permissions: &AutomationPermissions,
    ) -> Result<AutomationApplyResult, AutomationError> {
        let validation = validate(harness, plan, permissions)?;
        assert!(validation.can_apply);
        tauri::async_runtime::block_on(harness.state.apply_automation_plan(
            ApplyAutomationPlanParams {
                plan: plan.clone(),
                expected_plan_hash: validation.plan_hash,
                expected_scope_hash: validation.scope_hash,
            },
            ("test-agent", "1.0"),
            permissions.clone(),
        ))
    }

    fn rollback(
        harness: &TestHarness,
        change_id: &str,
        permissions: Option<AutomationPermissions>,
    ) -> Result<AutomationApplyResult, AutomationError> {
        let change = harness
            .state
            .get_automation_change(GetAutomationChangeParams {
                change_id: change_id.to_string(),
            })
            .unwrap();
        tauri::async_runtime::block_on(harness.state.rollback_automation_change(
            RollbackAutomationChangeParams {
                change_id: change_id.to_string(),
                expected_scope_hash: change.rollback_scope_hash,
            },
            permissions,
        ))
    }

    #[test]
    fn ephemeral_rewrite_uses_runtime_only_and_rolls_back_cleanly() {
        let harness = test_harness();
        let plan = rewrite_plan(
            "ephemeral-runtime-only-0001",
            "ephemeral",
            rewrite_resource("Ephemeral", "api.example.com", true),
        );
        let result = apply_validated(&harness, &plan, &automation_permissions()).unwrap();
        let rule_id = result.resource_ids_by_ref.get("rewrite").unwrap();

        let conn = harness.state.lock_db_for_ipc().unwrap();
        assert!(aiproxy_db::rules::load_all_rewrite_rules(&conn)
            .unwrap()
            .is_empty());
        let metadata = automation::load_automation_resource(&conn, "rewrite", rule_id)
            .unwrap()
            .expect("ephemeral metadata should remain for experiment audit");
        assert_eq!(metadata.owner_kind, "agent");
        drop(conn);
        assert!(harness
            .state
            .read_rewrite_manager()
            .list_rules()
            .iter()
            .any(|rule| &rule.id == rule_id));

        rollback(&harness, &result.change_id, None).unwrap();
        assert!(harness.state.read_rewrite_manager().list_rules().is_empty());
        let conn = harness.state.lock_db_for_ipc().unwrap();
        assert!(
            automation::load_automation_resource(&conn, "rewrite", rule_id)
                .unwrap()
                .is_none()
        );
        let change = automation::load_automation_change_set(&conn, &result.change_id)
            .unwrap()
            .unwrap();
        assert_eq!(change.status, "reverted");
    }

    #[test]
    fn agent_rewrite_publishes_with_an_exact_host_lock_and_paired_generation() {
        let harness = test_harness();
        let result = apply_validated(
            &harness,
            &rewrite_plan(
                "host-lock-generation-001",
                "persistent",
                rewrite_resource("Host locked", "api.example.com", true),
            ),
            &automation_permissions(),
        )
        .unwrap();
        let rule_id = result.resource_ids_by_ref.get("rewrite").unwrap();
        let locked = harness
            .state
            .read_rewrite_manager()
            .list_rules_with_host_locks();
        let (_, host_lock) = locked
            .iter()
            .find(|(rule, _)| &rule.id == rule_id)
            .expect("published Agent rule");
        assert_eq!(host_lock.as_deref(), Some("api.example.com"));
        assert_eq!(
            harness.state.read_rewrite_manager().runtime_generation(),
            harness.state.read_map_manager().runtime_generation()
        );
        assert_eq!(
            result.runtime_generation,
            harness.state.read_rewrite_manager().runtime_generation()
        );
    }

    #[test]
    fn legacy_temporary_agent_rules_survive_automation_publication() {
        let harness = test_harness();
        let legacy = harness
            .state
            .read_agent_rule_registry()
            .create(
                CreateAgentRuleParams {
                    url_pattern: "https://legacy.example.com/v1/*".to_string(),
                    methods: vec!["GET".to_string()],
                    name: None,
                    ttl_seconds: Some(600),
                    match_type: None,
                    action: AgentRuleAction::SetRequestHeader {
                        name: "x-legacy-agent".to_string(),
                        value: "1".to_string(),
                    },
                },
                WORKSPACE_ID,
                "legacy-test",
            )
            .unwrap();

        apply_validated(
            &harness,
            &rewrite_plan(
                "legacy-survives-publish-001",
                "persistent",
                rewrite_resource("Persistent", "api.example.com", true),
            ),
            &automation_permissions(),
        )
        .unwrap();

        let rules = harness
            .state
            .read_rewrite_manager()
            .list_rules_with_host_locks();
        let (_, host_lock) = rules
            .iter()
            .find(|(rule, _)| rule.id == legacy.rule_id)
            .expect("legacy Agent rule should remain in the runtime");
        assert_eq!(host_lock.as_deref(), Some("legacy.example.com"));
        assert!(harness
            .state
            .read_agent_rule_registry()
            .contains_rule(&legacy.rule_id));
    }

    #[test]
    fn wildcard_agent_hosts_are_rejected_before_apply() {
        let harness = test_harness();
        let mut resource = rewrite_resource("Wildcard", "api.example.com", true);
        resource.r#match.url_pattern = "https://*.example.com/v1/*".to_string();
        assert_eq!(
            validate(
                &harness,
                &rewrite_plan("wildcard-host-rejected-001", "persistent", resource),
                &automation_permissions(),
            )
            .unwrap_err()
            .code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn rewrite_redirect_targets_must_stay_on_the_matched_host() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let mut cross_host = rewrite_resource("Cross host redirect", "api.example.com", true);
        cross_host.rewrite_type = Some("redirect".to_string());
        cross_host.actions = vec![json!({
            "rewriteType": "redirect",
            "payload": {
                "preservePath": true,
                "preserveQuery": true,
                "targetUrl": "https://other.example.com/v1/items"
            }
        })];
        assert_eq!(
            validate(
                &harness,
                &rewrite_plan("cross-host-redirect-001", "persistent", cross_host,),
                &permissions,
            )
            .unwrap_err()
            .code,
            "FEATURE_NOT_AVAILABLE"
        );

        let mut same_host = rewrite_resource("Same host redirect", "api.example.com", true);
        same_host.rewrite_type = Some("redirect".to_string());
        same_host.actions = vec![json!({
            "rewriteType": "redirect",
            "payload": {
                "preservePath": true,
                "preserveQuery": true,
                "targetUrl": "https://api.example.com/v2/items"
            }
        })];
        validate(
            &harness,
            &rewrite_plan("same-host-redirect-0001", "persistent", same_host),
            &permissions,
        )
        .unwrap();
    }

    #[test]
    fn persistent_updates_cannot_target_ephemeral_resources() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let created = apply_validated(
            &harness,
            &rewrite_plan(
                "ephemeral-update-source-001",
                "ephemeral",
                rewrite_resource("Ephemeral source", "api.example.com", true),
            ),
            &permissions,
        )
        .unwrap();
        let resource_id = created.resource_ids_by_ref.get("rewrite").unwrap().clone();
        let current = harness
            .state
            .get_automation_resource(GetAutomationResourceParams {
                kind: "rewrite".to_string(),
                id: resource_id.clone(),
            })
            .unwrap();
        let mut update = rewrite_plan(
            "persistent-cross-lifecycle-001",
            "persistent",
            rewrite_resource("Persistent replacement", "api.example.com", true),
        );
        update.upserts.rewrite[0].id = Some(resource_id.clone());
        update.upserts.rewrite[0].expected_version = Some(current.summary.version.clone());
        let error = validate(&harness, &update, &permissions).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("ephemeral"), "{}", error.message);
        assert_eq!(
            harness
                .state
                .read_rewrite_manager()
                .list_rules()
                .into_iter()
                .find(|rule| rule.id == resource_id)
                .unwrap()
                .name,
            "Ephemeral source"
        );
    }

    #[test]
    fn plans_reject_duplicate_resource_mutations() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let mut duplicate = rewrite_plan(
            "duplicate-resource-update-001",
            "persistent",
            rewrite_resource("First", "api.example.com", true),
        );
        duplicate.upserts.rewrite[0].id = Some("same-rule".to_string());
        duplicate.upserts.rewrite[0].expected_version = Some("version-1".to_string());
        let mut second = duplicate.upserts.rewrite[0].clone();
        second.resource = rewrite_resource("Second", "api.example.com", true);
        second.expected_version = Some("version-2".to_string());
        duplicate.upserts.rewrite.push(second);
        let error = validate(&harness, &duplicate, &permissions).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("duplicate"), "{}", error.message);

        let mut overlap = rewrite_plan(
            "upsert-delete-overlap-0001",
            "persistent",
            rewrite_resource("Overlap", "api.example.com", true),
        );
        overlap.upserts.rewrite[0].id = Some("overlap-rule".to_string());
        overlap.upserts.rewrite[0].expected_version = Some("version".to_string());
        overlap.deletes.push(AutomationDelete {
            kind: "rewrite".to_string(),
            id: "overlap-rule".to_string(),
            expected_version: "version".to_string(),
        });
        let error = validate(&harness, &overlap, &permissions).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(
            error.message.contains("both update and delete"),
            "{}",
            error.message
        );
    }

    #[test]
    fn clear_removes_updated_agent_resources_instead_of_restoring_old_versions() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let created = apply_validated(
            &harness,
            &rewrite_plan(
                "clear-update-create-0001",
                "persistent",
                rewrite_resource("Version A", "api.example.com", true),
            ),
            &permissions,
        )
        .unwrap();
        let resource_id = created.resource_ids_by_ref.get("rewrite").unwrap().clone();
        let current = harness
            .state
            .get_automation_resource(GetAutomationResourceParams {
                kind: "rewrite".to_string(),
                id: resource_id.clone(),
            })
            .unwrap();
        let mut update = rewrite_plan(
            "clear-update-update-0001",
            "persistent",
            rewrite_resource("Version B", "api.example.com", true),
        );
        update.upserts.rewrite[0].id = Some(resource_id.clone());
        update.upserts.rewrite[0].expected_version = Some(current.summary.version.clone());
        let updated = apply_validated(&harness, &update, &permissions).unwrap();

        let cleared = tauri::async_runtime::block_on(harness.state.clear_agent_automation(
            ClearAgentAutomationParams {
                scope: "workspace".to_string(),
                workspace_id: Some(WORKSPACE_ID.to_string()),
                lifecycle: "all".to_string(),
            },
        ))
        .unwrap();
        assert_eq!(cleared.cleared_resource_count, 1);
        assert!(harness
            .state
            .read_rewrite_manager()
            .list_rules()
            .iter()
            .all(|rule| rule.id != resource_id));
        let conn = harness.state.lock_db_for_ipc().unwrap();
        assert!(aiproxy_db::rules::load_all_rewrite_rules(&conn)
            .unwrap()
            .iter()
            .all(|rule| rule.id != resource_id));
        assert!(
            automation::load_automation_resource(&conn, "rewrite", &resource_id)
                .unwrap()
                .is_none()
        );
        for change_id in [&created.change_id, &updated.change_id] {
            assert_eq!(
                automation::load_automation_change_set(&conn, change_id)
                    .unwrap()
                    .unwrap()
                    .status,
                "aborted"
            );
        }
    }

    #[test]
    fn ephemeral_plans_reject_updates_deletes_and_future_resource_kinds() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let mut update = rewrite_plan(
            "ephemeral-update-rejected-001",
            "ephemeral",
            rewrite_resource("Update", "api.example.com", true),
        );
        update.upserts.rewrite[0].id = Some("existing-rule".to_string());
        update.upserts.rewrite[0].expected_version = Some("version".to_string());
        assert_eq!(
            validate(&harness, &update, &permissions).unwrap_err().code,
            "INVALID_ARGUMENT"
        );

        let mut delete = rewrite_plan(
            "ephemeral-delete-rejected-001",
            "ephemeral",
            rewrite_resource("Delete", "api.example.com", true),
        );
        delete.upserts = AutomationUpserts::default();
        delete.deletes.push(AutomationDelete {
            kind: "rewrite".to_string(),
            id: "existing-rule".to_string(),
            expected_version: "version".to_string(),
        });
        assert_eq!(
            validate(&harness, &delete, &permissions).unwrap_err().code,
            "INVALID_ARGUMENT"
        );

        for (field, expected) in [
            ("script", "FEATURE_NOT_AVAILABLE"),
            ("dns", "FEATURE_NOT_AVAILABLE"),
            ("throttleProfile", "FEATURE_NOT_AVAILABLE"),
            ("breakpoint", "FEATURE_NOT_AVAILABLE"),
        ] {
            let mut plan = rewrite_plan(
                &format!("unsupported-kind-{field}-001"),
                "persistent",
                rewrite_resource("Unsupported", "api.example.com", true),
            );
            match field {
                "script" => plan.upserts.script.push(json!({})),
                "dns" => plan.upserts.dns.push(json!({})),
                "throttleProfile" => plan.upserts.throttle_profile.push(json!({})),
                "breakpoint" => plan.upserts.breakpoint.push(json!({})),
                _ => unreachable!(),
            }
            assert_eq!(
                validate(&harness, &plan, &permissions).unwrap_err().code,
                expected
            );
        }
    }

    #[test]
    fn idempotent_replay_returns_active_change_and_rejects_reverted_plans() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let plan = rewrite_plan(
            "idempotency-replay-0001",
            "persistent",
            rewrite_resource("Idempotent", "api.example.com", true),
        );
        let first = apply_validated(&harness, &plan, &permissions).unwrap();
        let second = apply_validated(&harness, &plan, &permissions).unwrap();
        assert!(second.idempotent);
        assert_eq!(second.status, "active");
        assert_eq!(first.change_id, second.change_id);

        rollback(&harness, &first.change_id, Some(permissions.clone())).unwrap();
        let after_rollback = apply_validated(&harness, &plan, &permissions).unwrap_err();
        assert_eq!(after_rollback.code, "CHANGE_NOT_APPLICABLE");
        assert!(harness.state.read_rewrite_manager().list_rules().is_empty());

        let mut conflicting = plan.clone();
        conflicting.upserts.rewrite[0].resource.name = "Different plan".to_string();
        assert_eq!(
            apply_validated(&harness, &conflicting, &permissions)
                .unwrap_err()
                .code,
            "IDEMPOTENCY_CONFLICT"
        );
    }

    #[test]
    fn publish_failure_retry_returns_the_activated_change() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let plan = rewrite_plan(
            "publish-retry-0001",
            "persistent",
            rewrite_resource("Retry", "api.example.com", true),
        );
        let first = apply_validated(&harness, &plan, &permissions).unwrap();
        {
            let conn = harness.state.lock_db_for_ipc().unwrap();
            aiproxy_db::automation::update_automation_change_status(
                &conn,
                &first.change_id,
                "publish_failed",
                None,
                None,
                None,
                None,
            )
            .unwrap();
        }

        let retried = tauri::async_runtime::block_on(harness.state.apply_automation_plan(
            ApplyAutomationPlanParams {
                plan,
                expected_plan_hash: String::new(),
                expected_scope_hash: String::new(),
            },
            ("test-agent", "1.0"),
            permissions.clone(),
        ))
        .unwrap();

        assert!(retried.idempotent);
        assert_eq!(retried.status, "active");
        assert!(retried.runtime_generation > 0);
    }

    #[test]
    fn plans_reject_resources_from_another_workspace() {
        let harness = test_harness();
        let permissions = automation_permissions();
        {
            let conn = harness.state.lock_db_for_ipc().unwrap();
            aiproxy_db::workspaces::upsert_workspace(
                &conn,
                &WorkspaceRow {
                    id: "ws-2".to_string(),
                    name: "Other workspace".to_string(),
                    proxy_port: 8889,
                    ssl_enabled: false,
                    http2_enabled: true,
                    system_proxy_enabled: false,
                    verify_upstream_tls: false,
                    tls_verify_hosts: "[]".to_string(),
                    ssl_blind_hosts: "[]".to_string(),
                    upstream_proxy: String::new(),
                    ssl_proxying: String::new(),
                    storage_path: harness._directory.path().display().to_string(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                },
            )
            .unwrap();
        }
        let foreign = RewriteRule {
            actions: Some(vec![json!({
                "rewriteType": "header",
                "payload": {
                    "headerName": "X-Other",
                    "operation": "set",
                    "target": "request",
                    "value": "other"
                }
            })]),
            enabled: true,
            id: "foreign-rewrite-1".to_string(),
            name: "Other workspace rule".to_string(),
            note: None,
            payload: json!({}),
            priority: 10,
            r#match: RewriteRuleMatch {
                methods: vec!["GET".to_string()],
                stage: "request".to_string(),
                url_pattern: "https://other.example.com/*".to_string(),
                match_type: Some("wildcard".to_string()),
            },
            rewrite_type: "header".to_string(),
            workspace_id: "ws-2".to_string(),
        };
        harness
            .state
            .read_rewrite_manager()
            .save_rule_with_host_lock(foreign.clone(), "other.example.com");

        let mut plan = rewrite_plan(
            "cross-workspace-0001",
            "persistent",
            rewrite_resource("Cross", "api.example.com", true),
        );
        plan.upserts.rewrite[0].id = Some(foreign.id.clone());
        plan.upserts.rewrite[0].expected_version = Some("sha256:bogus".to_string());

        let error = validate(&harness, &plan, &permissions).unwrap_err();
        assert_eq!(error.code, "SCOPE_CONFLICT");
    }

    #[test]
    fn persistent_plans_cannot_delete_ephemeral_resources() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let ephemeral = rewrite_plan(
            "ephemeral-delete-0001",
            "ephemeral",
            rewrite_resource("Temporary", "api.example.com", true),
        );
        apply_validated(&harness, &ephemeral, &permissions).unwrap();
        let rule = harness
            .state
            .read_rewrite_manager()
            .list_rules()
            .into_iter()
            .next()
            .expect("ephemeral rule should be published");
        let version = PreparedResource::Rewrite(rule.clone()).version().unwrap();

        let mut delete_plan = rewrite_plan(
            "persistent-delete-0001",
            "persistent",
            rewrite_resource("Delete", "api.example.com", true),
        );
        delete_plan.upserts.rewrite.clear();
        delete_plan.deletes = vec![AutomationDelete {
            kind: "rewrite".to_string(),
            id: rule.id.clone(),
            expected_version: version,
        }];

        let error = validate(&harness, &delete_plan, &permissions).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn offline_verification_marks_response_rules_unverified_without_a_baseline() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let mut resource = rewrite_resource("Response shape", "api.example.com", true);
        resource.r#match.stage = "response".to_string();
        let plan = rewrite_plan("offline-response-0001", "persistent", resource);
        let applied = apply_validated(&harness, &plan, &permissions).unwrap();

        let result = tauri::async_runtime::block_on(harness.state.verify_automation_change(
            VerifyAutomationChangeParams {
                change_id: applied.change_id,
                mode: "offline".to_string(),
                baseline_session_ids: Vec::new(),
                requests: vec![VerificationRequest {
                    r#ref: "req-1".to_string(),
                    baseline_session_id: None,
                    method: Some("GET".to_string()),
                    url: Some("https://api.example.com/v1/items".to_string()),
                    headers: Vec::new(),
                    body: None,
                    json_set: BTreeMap::new(),
                }],
                external_session_ids: Vec::new(),
                assertions: vec![AutomationAssertion {
                    id: "status".to_string(),
                    subject: "status".to_string(),
                    path: None,
                    operator: "exists".to_string(),
                    expected: None,
                }],
            },
            permissions,
        ))
        .unwrap();

        assert_eq!(result.status, "insufficient_evidence");
        assert_eq!(result.requests[0].status, "insufficient_evidence");
        assert!(
            result
                .limitations
                .iter()
                .any(|line| line.contains("baselineSessionId")),
            "limitations: {:?}",
            result.limitations
        );
    }

    #[test]
    fn rewrite_row_preserves_legacy_payload() {
        let rule = RewriteRule {
            actions: None,
            enabled: true,
            id: "legacy-rewrite-1".to_string(),
            name: "Legacy rule".to_string(),
            note: None,
            payload: json!({
                "rewriteType": "header",
                "payload": {
                    "headerName": "X-Legacy",
                    "operation": "set",
                    "target": "request",
                    "value": "legacy"
                }
            }),
            priority: 10,
            r#match: RewriteRuleMatch {
                methods: vec!["GET".to_string()],
                stage: "request".to_string(),
                url_pattern: "https://legacy.example.com/*".to_string(),
                match_type: Some("wildcard".to_string()),
            },
            rewrite_type: "header".to_string(),
            workspace_id: WORKSPACE_ID.to_string(),
        };

        let row = rewrite_row(&rule);
        let stored: Value = serde_json::from_str(&row.payload).unwrap();
        assert!(stored.is_object());
        assert_eq!(stored["payload"]["headerName"], "X-Legacy");
    }

    #[test]
    fn updating_a_user_rule_does_not_transfer_ownership_and_rollback_requires_permission() {
        let harness = test_harness();
        let original = RewriteRule {
            actions: Some(vec![json!({
                "rewriteType": "header",
                "payload": {
                    "headerName": "X-User",
                    "operation": "set",
                    "target": "request",
                    "value": "original"
                }
            })]),
            enabled: true,
            id: "user-rewrite-1".to_string(),
            name: "User rule".to_string(),
            note: None,
            payload: json!({}),
            priority: 20,
            r#match: RewriteRuleMatch {
                match_type: Some("wildcard".to_string()),
                methods: vec!["GET".to_string()],
                stage: "request".to_string(),
                url_pattern: "https://api.example.com/v1/*".to_string(),
            },
            rewrite_type: "header".to_string(),
            workspace_id: WORKSPACE_ID.to_string(),
        };
        let expected_version = hash_json(&serde_json::to_value(&original).unwrap()).unwrap();
        {
            let conn = harness.state.lock_db_for_ipc().unwrap();
            aiproxy_db::rules::save_rewrite_rule(&conn, &rewrite_row(&original)).unwrap();
        }
        harness
            .state
            .read_rewrite_manager()
            .set_rules(vec![original.clone()]);
        let mut plan = rewrite_plan(
            "user-rule-update-0001",
            "persistent",
            rewrite_resource("Agent renamed user rule", "api.example.com", true),
        );
        plan.upserts.rewrite[0].id = Some(original.id.clone());
        plan.upserts.rewrite[0].expected_version = Some(expected_version);
        let result = apply_validated(&harness, &plan, &automation_permissions()).unwrap();

        let conn = harness.state.lock_db_for_ipc().unwrap();
        assert!(
            automation::load_automation_resource(&conn, "rewrite", &original.id)
                .unwrap()
                .is_none()
        );
        drop(conn);

        let denied_permissions = AutomationPermissions {
            manage_user_automation: false,
            ..automation_permissions()
        };
        assert_eq!(
            rollback(&harness, &result.change_id, Some(denied_permissions))
                .unwrap_err()
                .code,
            "CONTROL_PERMISSION_DENIED"
        );
        rollback(&harness, &result.change_id, Some(automation_permissions())).unwrap();
        let conn = harness.state.lock_db_for_ipc().unwrap();
        let restored = aiproxy_db::rules::load_all_rewrite_rules(&conn)
            .unwrap()
            .into_iter()
            .find(|rule| rule.id == original.id)
            .unwrap();
        assert_eq!(restored.name, original.name);
    }

    #[test]
    fn promoted_changes_cannot_be_rolled_back() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let plan = rewrite_plan(
            "promote-change-0001",
            "persistent",
            rewrite_resource("Promote", "api.example.com", true),
        );
        let result = apply_validated(&harness, &plan, &permissions).unwrap();
        tauri::async_runtime::block_on(
            harness
                .state
                .promote_automation_change(result.change_id.clone()),
        )
        .unwrap();
        assert_eq!(
            rollback(&harness, &result.change_id, Some(permissions))
                .unwrap_err()
                .code,
            "ROLLBACK_CONFLICT"
        );
    }

    #[test]
    fn mixed_user_and_agent_changes_cannot_be_promoted() {
        let harness = test_harness();
        let original = RewriteRule {
            actions: Some(vec![json!({
                "rewriteType": "header",
                "payload": {
                    "headerName": "X-User",
                    "operation": "set",
                    "target": "request",
                    "value": "original"
                }
            })]),
            enabled: true,
            id: "user-rewrite-mixed".to_string(),
            name: "User mixed rule".to_string(),
            note: None,
            payload: json!({}),
            priority: 20,
            r#match: RewriteRuleMatch {
                match_type: Some("wildcard".to_string()),
                methods: vec!["GET".to_string()],
                stage: "request".to_string(),
                url_pattern: "https://api.example.com/v1/*".to_string(),
            },
            rewrite_type: "header".to_string(),
            workspace_id: WORKSPACE_ID.to_string(),
        };
        let expected_version = hash_json(&serde_json::to_value(&original).unwrap()).unwrap();
        {
            let conn = harness.state.lock_db_for_ipc().unwrap();
            aiproxy_db::rules::save_rewrite_rule(&conn, &rewrite_row(&original)).unwrap();
        }
        harness
            .state
            .read_rewrite_manager()
            .set_rules(vec![original.clone()]);
        let mut plan = rewrite_plan(
            "mixed-promotion-0001",
            "persistent",
            rewrite_resource("Agent created", "other.example.com", true),
        );
        plan.upserts.rewrite.push(AutomationUpsert {
            id: Some(original.id.clone()),
            expected_version: Some(expected_version),
            r#ref: Some("user-update".to_string()),
            resource: AutomationRewriteResource {
                name: "Agent updated user rule".to_string(),
                ..rewrite_resource("Agent updated user rule", "api.example.com", true)
            },
        });
        let result = apply_validated(&harness, &plan, &automation_permissions()).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(
                harness.state.promote_automation_change(result.change_id)
            )
            .unwrap_err()
            .code,
            "STATE_CONFLICT"
        );
    }

    #[test]
    fn ttl_cleanup_removes_overlapping_ephemeral_changes() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let first = apply_validated(
            &harness,
            &rewrite_plan(
                "ttl-overlap-first-0001",
                "ephemeral",
                rewrite_resource("TTL first", "api.example.com", true),
            ),
            &permissions,
        )
        .unwrap();
        let second = apply_validated(
            &harness,
            &rewrite_plan(
                "ttl-overlap-second-001",
                "ephemeral",
                rewrite_resource("TTL second", "api.example.com", true),
            ),
            &permissions,
        )
        .unwrap();
        {
            let conn = harness.state.lock_db_for_ipc().unwrap();
            for change_id in [&first.change_id, &second.change_id] {
                conn.execute(
                    "UPDATE automation_change_sets SET expires_at='2000-01-01T00:00:00Z' WHERE id=?1",
                    aiproxy_db::rusqlite::params![change_id],
                )
                .unwrap();
            }
        }
        let cleaned =
            tauri::async_runtime::block_on(harness.state.cleanup_expired_automation()).unwrap();
        assert_eq!(cleaned, 2);
        assert!(harness.state.read_rewrite_manager().list_rules().is_empty());
    }

    #[test]
    fn unrelated_host_expiry_does_not_block_manual_rollback() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let target = apply_validated(
            &harness,
            &rewrite_plan(
                "unrelated-target-0001",
                "persistent",
                rewrite_resource("Target", "api.example.com", true),
            ),
            &permissions,
        )
        .unwrap();
        apply_validated(
            &harness,
            &rewrite_plan(
                "unrelated-ephemeral-001",
                "ephemeral",
                rewrite_resource("Other host", "other.example.com", true),
            ),
            &permissions,
        )
        .unwrap();
        rollback(&harness, &target.change_id, Some(permissions)).unwrap();
    }

    #[test]
    fn managed_assets_are_removed_after_persistent_rollback() {
        let harness = test_harness();
        let mut plan = rewrite_plan(
            "managed-asset-map-0001",
            "persistent",
            rewrite_resource("Unused", "api.example.com", true),
        );
        plan.upserts.rewrite.clear();
        plan.assets = vec![AutomationAsset {
            r#ref: "mock".to_string(),
            file_name: "mock.json".to_string(),
            content_base64: BASE64_STANDARD.encode(br#"{"ok":true}"#),
            content_type: Some("application/json".to_string()),
        }];
        plan.upserts.map = vec![AutomationUpsert {
            id: None,
            expected_version: None,
            r#ref: Some("map".to_string()),
            resource: AutomationMapResource {
                enabled: Some(true),
                mode: "local".to_string(),
                name: "Managed mock".to_string(),
                note: None,
                preserve_path: true,
                preserve_query: true,
                priority: 10,
                source_pattern: "https://api.example.com/v1/items".to_string(),
                approved_path: None,
                target_value: None,
                managed_asset_ref: Some("mock".to_string()),
                match_type: Some("exact".to_string()),
            },
        }];
        let result = apply_validated(&harness, &plan, &automation_permissions()).unwrap();
        let asset_dir = harness
            .state
            .automation_asset_root()
            .join(&result.change_id);
        assert!(asset_dir.join("mock.json").is_file());
        rollback(&harness, &result.change_id, Some(automation_permissions())).unwrap();
        assert!(!asset_dir.exists());
    }

    #[test]
    fn offline_verification_uses_the_shared_rule_pipeline() {
        let harness = test_harness();
        let plan = rewrite_plan(
            "offline-verification-0001",
            "persistent",
            rewrite_resource("Offline rewrite", "api.example.com", true),
        );
        let result = apply_validated(&harness, &plan, &automation_permissions()).unwrap();
        let verification = tauri::async_runtime::block_on(harness.state.verify_automation_change(
            VerifyAutomationChangeParams {
                change_id: result.change_id,
                mode: "offline".to_string(),
                baseline_session_ids: Vec::new(),
                requests: vec![VerificationRequest {
                    r#ref: "request-1".to_string(),
                    baseline_session_id: None,
                    method: Some("GET".to_string()),
                    url: Some("https://api.example.com/v1/items".to_string()),
                    headers: Vec::new(),
                    body: None,
                    json_set: BTreeMap::new(),
                }],
                external_session_ids: Vec::new(),
                assertions: vec![AutomationAssertion {
                    id: "header-set".to_string(),
                    subject: "requestHeader".to_string(),
                    path: Some("x-agent-experiment".to_string()),
                    operator: "equals".to_string(),
                    expected: Some(json!("active")),
                }],
            },
            automation_permissions(),
        ))
        .unwrap();
        assert_eq!(verification.status, "passed");
        assert_eq!(verification.evidence_level, "offline");
        assert_eq!(
            verification.runtime_generation,
            harness.state.read_rewrite_manager().runtime_generation()
        );
        assert_eq!(verification.requests[0].matched_rule_ids.len(), 1);
        assert!(!verification.limitations.is_empty());
    }

    #[test]
    fn verification_rejects_a_change_whose_target_was_superseded() {
        let harness = test_harness();
        let permissions = automation_permissions();
        let first = apply_validated(
            &harness,
            &rewrite_plan(
                "verify-stale-target-0001",
                "persistent",
                rewrite_resource("Initial target", "api.example.com", true),
            ),
            &permissions,
        )
        .unwrap();
        let rule_id = first.resource_ids_by_ref.get("rewrite").unwrap().clone();
        let current = harness
            .state
            .get_automation_resource(GetAutomationResourceParams {
                kind: "rewrite".to_string(),
                id: rule_id.clone(),
            })
            .unwrap();
        let mut update = rewrite_plan(
            "verify-stale-target-0002",
            "persistent",
            rewrite_resource("Superseding target", "api.example.com", true),
        );
        update.upserts.rewrite[0].id = Some(rule_id);
        update.upserts.rewrite[0].expected_version = Some(current.summary.version);
        apply_validated(&harness, &update, &permissions).unwrap();

        let error = tauri::async_runtime::block_on(harness.state.verify_automation_change(
            VerifyAutomationChangeParams {
                change_id: first.change_id,
                mode: "offline".to_string(),
                baseline_session_ids: Vec::new(),
                requests: vec![VerificationRequest {
                    r#ref: "request-1".to_string(),
                    baseline_session_id: None,
                    method: Some("GET".to_string()),
                    url: Some("https://api.example.com/v1/items".to_string()),
                    headers: Vec::new(),
                    body: None,
                    json_set: BTreeMap::new(),
                }],
                external_session_ids: Vec::new(),
                assertions: vec![AutomationAssertion {
                    id: "header-set".to_string(),
                    subject: "requestHeader".to_string(),
                    path: Some("x-agent-experiment".to_string()),
                    operator: "equals".to_string(),
                    expected: Some(json!("active")),
                }],
            },
            permissions,
        ))
        .unwrap_err();
        assert_eq!(error.code, "RESOURCE_VERSION_MISMATCH");
    }

    #[test]
    fn external_verification_rejects_replay_and_stale_sessions() {
        let harness = test_harness();
        let result = apply_validated(
            &harness,
            &rewrite_plan(
                "external-evidence-0001",
                "persistent",
                rewrite_resource("External", "api.example.com", true),
            ),
            &automation_permissions(),
        )
        .unwrap();
        let change = harness
            .state
            .get_automation_change(GetAutomationChangeParams {
                change_id: result.change_id.clone(),
            })
            .unwrap();
        let activated_at = change.activated_at.clone().unwrap();
        let after = (chrono::DateTime::parse_from_rfc3339(&activated_at).unwrap()
            + chrono::Duration::seconds(1))
        .to_rfc3339();
        insert_session(&harness, "replay-session", &after, Some("agentReplay"));
        insert_session(
            &harness,
            "stale-session",
            "2000-01-01T00:00:00Z",
            Some("proxy"),
        );
        let make_params = |session_id: &str| VerifyAutomationChangeParams {
            change_id: result.change_id.clone(),
            mode: "external".to_string(),
            baseline_session_ids: Vec::new(),
            requests: Vec::new(),
            external_session_ids: vec![session_id.to_string()],
            assertions: vec![AutomationAssertion {
                id: "status-ok".to_string(),
                subject: "status".to_string(),
                path: None,
                operator: "equals".to_string(),
                expected: Some(json!(200)),
            }],
        };
        assert_eq!(
            tauri::async_runtime::block_on(
                harness.state.verify_automation_change(
                    make_params("replay-session"),
                    automation_permissions(),
                )
            )
            .unwrap_err()
            .code,
            "INSUFFICIENT_EVIDENCE"
        );
        assert_eq!(
            tauri::async_runtime::block_on(
                harness.state.verify_automation_change(
                    make_params("stale-session"),
                    automation_permissions(),
                )
            )
            .unwrap_err()
            .code,
            "INSUFFICIENT_EVIDENCE"
        );
    }

    fn insert_session(
        harness: &TestHarness,
        id: &str,
        started_at: &str,
        timing_source: Option<&str>,
    ) {
        let summary = ProxySessionSummary {
            id: id.to_string(),
            method: "GET".to_string(),
            host: "api.example.com".to_string(),
            path: "/v1/items".to_string(),
            protocol: "HTTP/2".to_string(),
            scheme: "https".to_string(),
            http_version: "2".to_string(),
            transport_protocol: "tcp".to_string(),
            application_protocol: "http".to_string(),
            started_at: started_at.to_string(),
            finished_at: started_at.to_string(),
            duration_ms: 12,
            size_bytes: 2,
            status_code: 200,
            url: "https://api.example.com/v1/items".to_string(),
            response_mime_type: Some("application/json".to_string()),
            failure: None,
        };
        let detail = ProxySessionDetail {
            client_address: None,
            cookies: Vec::new(),
            id: id.to_string(),
            query_params: Vec::new(),
            raw_request_head: None,
            raw_response_head: None,
            request_body: None,
            request_headers: vec![ProxyHeaderEntry {
                name: "Host".to_string(),
                value: "api.example.com".to_string(),
                is_pseudo: None,
            }],
            response_body: None,
            response_headers: Vec::new(),
            map_traces: Vec::new(),
            rewrite_traces: Vec::new(),
            server_ip: None,
            tls_cipher_suite: None,
            tls_protocol: None,
            summary: summary.clone(),
            script_traces: Vec::new(),
            throttle_traces: Vec::new(),
            timing: None,
            timing_source: timing_source.map(str::to_string),
            trailers: None,
            h2_stream_id: None,
            via_upstream_proxy: None,
            failure: None,
        };
        let summary_row = crate::bootstrap::converters::proxy_summary_to_row(&summary);
        let detail_row =
            crate::bootstrap::converters::proxy_detail_to_row(&detail, harness.body_store.as_ref());
        let conn = harness.state.lock_db_for_ipc().unwrap();
        aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row).unwrap();
    }

    #[test]
    fn proxy_target_validation_enforces_methods_and_origins() {
        let origins = vec!["https://api.example.com".to_string()];
        assert_eq!(
            validate_proxy_verification_target(
                "POST",
                "https://api.example.com/v1/items",
                &origins,
            )
            .unwrap_err()
            .code,
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            validate_proxy_verification_target(
                "GET",
                "https://other.example.com/v1/items",
                &origins,
            )
            .unwrap_err()
            .code,
            "ORIGIN_NOT_ALLOWED"
        );
        let (method, https) = validate_proxy_verification_target(
            "get",
            "https://api.example.com/v1/items?token=secret",
            &origins,
        )
        .unwrap();
        assert_eq!(method, "GET");
        assert!(https);
    }

    #[test]
    fn proxy_verification_rejects_cross_host_rewrite_traces() {
        let traces = vec![aiproxy_proxy_core::RewriteTrace {
            duration_ms: 1,
            entries: vec![aiproxy_proxy_core::RewriteTraceEntry {
                after: Some("https://other.example.com/v1/items".to_string()),
                before: Some("https://api.example.com/v1/items".to_string()),
                kind: "redirect".to_string(),
                key: Some("url".to_string()),
                message: None,
                sequence: 0,
            }],
            outcome: "success".to_string(),
            rule_id: "redirect-rule".to_string(),
            rule_name: "Redirect".to_string(),
            rewrite_type: "redirect".to_string(),
            stage: "request".to_string(),
        }];
        let error = ensure_proxy_transformation_stays_on_origin(
            "https://api.example.com/v1/items",
            "https://api.example.com/v1/items",
            &traces,
        )
        .unwrap_err();
        assert_eq!(error.code, "CONTROL_PERMISSION_DENIED");
        assert_eq!(error.details.unwrap()["targetHost"], "other.example.com");
    }

    #[test]
    fn host_conflict_helpers_cover_wildcards() {
        assert_eq!(
            pattern_host("https://*.Example.com:443/v1/*").as_deref(),
            Some("*.example.com")
        );
        assert!(host_conflicts("*.example.com", Some("api.example.com")));
        assert!(host_conflicts("api.example.com", None));
        assert!(!host_conflicts(
            "api.example.com",
            Some("other.example.com")
        ));
    }
}
