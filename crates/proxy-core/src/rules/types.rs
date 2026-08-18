use super::*;

// ---------------------------------------------------------------------------
// Rewrite / Map / Throttle types
// ---------------------------------------------------------------------------

/// A generic rewrite rule matching on URL pattern, methods, and stage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRuleMatch {
    pub methods: Vec<String>,
    pub stage: String,
    pub url_pattern: String,
    #[serde(default)]
    pub match_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRule {
    /// Ordered rewrite actions (new shape, D2). Legacy rows omit this field
    /// and carry `rewrite_type` + `payload` instead; `rewrite_actions()`
    /// expands both shapes.
    #[serde(default)]
    pub actions: Option<Vec<serde_json::Value>>,
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub note: Option<String>,
    pub priority: u32,
    pub r#match: RewriteRuleMatch,
    pub rewrite_type: String,
    pub workspace_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteTraceEntry {
    pub after: Option<String>,
    pub before: Option<String>,
    pub kind: String,
    pub key: Option<String>,
    pub message: Option<String>,
    pub sequence: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteTrace {
    pub duration_ms: u128,
    pub entries: Vec<RewriteTraceEntry>,
    pub outcome: String,
    pub rule_id: String,
    pub rule_name: String,
    pub rewrite_type: String,
    pub stage: String,
}

/// A map rule (local or remote) matching on source URL pattern.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapRule {
    pub id: String,
    pub enabled: bool,
    pub mode: String,
    pub name: String,
    pub note: Option<String>,
    pub preserve_path: bool,
    pub preserve_query: bool,
    pub priority: u32,
    pub source_pattern: String,
    pub target_value: String,
    #[serde(default)]
    pub match_type: Option<String>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MapTrace {
    pub duration_ms: u128,
    pub local_path: Option<String>,
    pub mapped_url: Option<String>,
    pub mode: String,
    pub original_url: String,
    pub outcome: String,
    pub rule_id: String,
    pub rule_name: String,
    pub source_pattern: String,
    pub target_value: String,
}

/// A throttle profile for bandwidth/latency/packet-loss simulation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleProfileData {
    pub id: String,
    pub download_kbps: u32,
    pub enabled: bool,
    pub latency_ms: u32,
    pub name: String,
    pub note: Option<String>,
    pub packet_loss_ratio: f32,
    pub preset: bool,
    pub upload_kbps: u32,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleRuleData {
    pub id: String,
    pub enabled: bool,
    pub methods: Vec<String>,
    pub name: String,
    pub note: Option<String>,
    pub priority: u32,
    pub profile_id: String,
    pub stage: String,
    pub url_pattern: String,
    #[serde(default)]
    pub match_type: Option<String>,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleTrace {
    pub body_bytes: usize,
    pub delay_ms: u64,
    pub latency_ms: u64,
    pub message: Option<String>,
    pub outcome: String,
    pub profile_id: String,
    pub profile_name: String,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub sequence: u32,
    pub stage: String,
    pub transfer_delay_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleRuntimeStats {
    pub dropped_requests: u64,
    pub matched_requests: u64,
    pub request_delay_ms: u64,
    pub response_delay_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ThrottleRuntimeSelection {
    pub(crate) profile: ThrottleProfileData,
    pub(crate) rule: Option<ThrottleRuleData>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ThrottleFailure {
    pub(crate) error: String,
    pub(crate) trace: ThrottleTrace,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewriteHeaderPayload {
    pub(crate) header_name: String,
    pub(crate) operation: String,
    pub(crate) target: String,
    pub(crate) value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewriteQueryPayload {
    pub(crate) operation: String,
    pub(crate) param_name: String,
    pub(crate) value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewriteBodyPayload {
    pub(crate) content_type: String,
    pub(crate) fields: Option<Vec<RewriteBodyFieldPayload>>,
    pub(crate) mode: Option<String>,
    pub(crate) target: String,
    pub(crate) text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewriteBodyFieldPayload {
    pub(crate) operation: Option<String>,
    pub(crate) path: String,
    pub(crate) value: Option<String>,
    pub(crate) value_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewriteRedirectPayload {
    pub(crate) preserve_path: bool,
    pub(crate) preserve_query: bool,
    pub(crate) target_url: String,
}

#[derive(Debug)]
pub(crate) struct RequestRuntimeOutcome {
    pub(crate) local_response: Option<UpstreamResponse>,
    pub(crate) map_traces: Vec<MapTrace>,
    pub(crate) rewrite_traces: Vec<RewriteTrace>,
    pub(crate) throttle_selection: Option<ThrottleRuntimeSelection>,
}

#[derive(Debug)]
pub(crate) struct RequestScriptOutcome {
    pub(crate) local_response: Option<UpstreamResponse>,
    pub(crate) traces: Vec<ScriptTrace>,
}
