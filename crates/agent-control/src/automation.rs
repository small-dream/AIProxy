use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRewriteMatch {
    /// HTTP methods to match. An empty list matches every method.
    #[serde(default)]
    pub methods: Vec<String>,
    /// Request or response stage. An empty string follows the existing default.
    #[serde(default)]
    pub stage: String,
    /// URL pattern evaluated by the shared proxy rule matcher.
    pub url_pattern: String,
    /// Match strategy such as wildcard, exact, contains, or regex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRewriteResource {
    /// Whether the rule participates in the runtime. New resources default to disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Human-readable rule name.
    pub name: String,
    /// Optional note shown in AIProxy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Higher values are evaluated first.
    #[serde(default)]
    pub priority: u32,
    /// URL and stage match criteria.
    pub r#match: AutomationRewriteMatch,
    /// Rewrite category retained for compatibility with the desktop editor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewrite_type: Option<String>,
    /// Ordered rewrite actions. The first release accepts 1-100 actions.
    #[serde(default)]
    pub actions: Vec<Value>,
    /// Editor-specific rewrite payload retained for round-tripping.
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationMapResource {
    /// Whether the rule participates in the runtime. New resources default to disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Map mode. The first release only accepts local.
    pub mode: String,
    /// Human-readable rule name.
    pub name: String,
    /// Optional note shown in AIProxy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Preserve the original request path when resolving a local target.
    #[serde(default)]
    pub preserve_path: bool,
    /// Preserve the original query string when resolving a local target.
    #[serde(default)]
    pub preserve_query: bool,
    /// Higher values are evaluated first.
    #[serde(default)]
    pub priority: u32,
    /// URL pattern evaluated by the shared proxy rule matcher.
    pub source_pattern: String,
    /// User-approved local file path. Mutually exclusive with managedAssetRef.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_path: Option<String>,
    /// Existing Map Local target retained when updating an existing rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_value: Option<String>,
    /// Reference to an asset supplied in the same plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_asset_ref: Option<String>,
    /// Match strategy such as wildcard, exact, contains, or regex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationAsset {
    /// Plan-local reference used by Map Local resources.
    pub r#ref: String,
    /// Safe file name written below the change staging directory.
    pub file_name: String,
    /// Base64-encoded asset bytes.
    pub content_base64: String,
    /// Optional MIME type recorded with the asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationUpsert<T> {
    /// Existing resource id. Omit when creating a resource.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Version returned by get_automation_resource. Required for updates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
    /// Plan-local reference returned in resourceIdsByRef.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    /// Complete resource content for the create or update.
    pub resource: T,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationUpserts {
    /// Rewrite resources to create or update.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rewrite: Vec<AutomationUpsert<AutomationRewriteResource>>,
    /// Map resources to create or update. Only Map Local is available in the first release.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub map: Vec<AutomationUpsert<AutomationMapResource>>,
    /// Reserved DNS resources. The first release returns FEATURE_NOT_AVAILABLE.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dns: Vec<Value>,
    /// Reserved Script resources. The first release returns FEATURE_NOT_AVAILABLE.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub script: Vec<Value>,
    /// Reserved Throttle Profile resources. The first release returns FEATURE_NOT_AVAILABLE.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub throttle_profile: Vec<Value>,
    /// Reserved Throttle Rule resources. The first release returns FEATURE_NOT_AVAILABLE.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub throttle_rule: Vec<Value>,
    /// Reserved Breakpoint resources. Breakpoints are global and writes are unavailable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub breakpoint: Vec<Value>,
}

impl AutomationUpserts {
    pub fn resource_count(&self) -> usize {
        self.rewrite.len()
            + self.map.len()
            + self.dns.len()
            + self.script.len()
            + self.throttle_profile.len()
            + self.throttle_rule.len()
            + self.breakpoint.len()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationDelete {
    /// Resource kind to delete.
    pub kind: String,
    /// Existing resource id.
    pub id: String,
    /// Version returned by get_automation_resource.
    pub expected_version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationPlan {
    /// Resource scope. The first release supports workspace only.
    pub scope: String,
    /// Required when scope is workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// persistent keeps the change until rollback; ephemeral expires after ttlSeconds.
    pub lifecycle: String,
    /// Ephemeral lifetime in seconds, between 60 and 3600. Defaults to 600.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u64>,
    /// Installation-scope idempotency key. Reuse it when retrying a lost response.
    pub idempotency_key: String,
    /// Resources to create or update.
    #[serde(default)]
    pub upserts: AutomationUpserts,
    /// Existing resources to delete. Ephemeral plans cannot delete resources.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deletes: Vec<AutomationDelete>,
    /// Reserved Throttle activation. The first release returns FEATURE_NOT_AVAILABLE.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<Value>,
    /// Managed assets referenced by plan-local refs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<AutomationAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidateAutomationPlanParams {
    /// Complete automation plan to validate without writing state.
    pub plan: AutomationPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyAutomationPlanParams {
    /// Plan previously returned by validate_automation_plan.
    pub plan: AutomationPlan,
    /// Exact planHash returned by validate_automation_plan.
    pub expected_plan_hash: String,
    /// Exact scopeHash returned by validate_automation_plan.
    pub expected_scope_hash: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListAutomationResourcesParams {
    /// Optional resource scope filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Workspace id filter, required when scope is workspace and no global filter is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Optional resource kind filter. The first release supports rewrite and map.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Optional persistent or ephemeral lifecycle filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    /// Opaque pagination cursor returned by the previous call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Page size, between 1 and 100. Defaults to 50.
    #[serde(default = "default_list_limit")]
    pub limit: u32,
}

fn default_list_limit() -> u32 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetAutomationResourceParams {
    /// Resource kind, such as rewrite or map.
    pub kind: String,
    /// Resource id returned by list_automation_resources.
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationRequest {
    /// Caller-defined request reference returned in the verification result.
    pub r#ref: String,
    /// Captured session supplying request defaults and optional baseline response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_session_id: Option<String>,
    /// HTTP method override. Proxy verification accepts GET, HEAD, or OPTIONS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// Absolute http or https URL override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Request headers. Sensitive proxy control headers are ignored during proxy verification.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<AutomationHeader>,
    /// UTF-8 request body override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// JSON fields to replace in the request body.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub json_set: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationHeader {
    /// Header name.
    pub name: String,
    /// Header value. Values are redacted in evidence output when required.
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationAssertion {
    /// Stable assertion id returned in the result.
    pub id: String,
    /// Observation subject: status, requestHeader, responseHeader, responseBody,
    /// queryParam, ruleTrace, or durationMs.
    pub subject: String,
    /// Optional header name, JSON path, query name, or trace path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Comparison operator: equals, contains, exists, notExists, gte, or lte.
    pub operator: String,
    /// Expected value for comparison operators.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyAutomationChangeParams {
    /// Active change set to verify.
    pub change_id: String,
    /// offline, proxy, or external evidence mode.
    pub mode: String,
    /// Baseline session ids available to offline and proxy requests.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub baseline_session_ids: Vec<String>,
    /// Requests to evaluate for offline or proxy modes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requests: Vec<VerificationRequest>,
    /// Recently captured real-client sessions for external mode.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub external_session_ids: Vec<String>,
    /// Assertions evaluated against every request or external session.
    #[serde(default)]
    pub assertions: Vec<AutomationAssertion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetAutomationChangeParams {
    /// Change set id returned by apply_automation_plan.
    pub change_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackAutomationChangeParams {
    /// Persistent change set id to roll back.
    pub change_id: String,
    /// Exact rollbackScopeHash returned by get_automation_change.
    pub expected_scope_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearAgentAutomationParams {
    /// Resource scope. The first release supports workspace only.
    pub scope: String,
    /// Required when scope is workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// persistent, ephemeral, or all.
    pub lifecycle: String,
}
