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
    /// Legacy single-action payload. New-shape rules carry `actions` and the
    /// renderer never sends this field, so it must default to `Null` instead of
    /// making `save_rewrite_rule` reject an otherwise valid rule with
    /// "missing field `payload`". `rewrite_actions()` only reads it when
    /// `actions` is absent or empty, and the DB layer stores `actions` in the
    /// payload column (see `commands::save_rewrite_rule`).
    #[serde(default)]
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
    /// Why the rule failed, when `outcome` is "failed". Absent (not null) on
    /// success so previously persisted traces deserialize unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
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
    /// Packet-loss *percentage* in `0.0..=100.0` (the unit the throttling UI and
    /// the shipped presets use). `0.0` disables loss simulation; `100.0` drops
    /// every request/response matched by the profile.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn actions_payload() -> serde_json::Value {
        serde_json::json!({
            "actions": [{
                "rewriteType": "header",
                "payload": {
                    "headerName": "x-debug",
                    "operation": "set",
                    "target": "request",
                    "value": "1"
                }
            }],
            "enabled": true,
            "id": "rule-1",
            "match": { "methods": [], "stage": "request", "urlPattern": "example.com" },
            "name": "Rule",
            "note": "",
            "priority": 10,
            "rewriteType": "header",
            "workspaceId": "default"
        })
    }

    // P1-1: the renderer only ever sends the new `actions` shape, which has no
    // top-level `payload`. `payload` is a legacy read-compat field, so its
    // absence must not make `save_rewrite_rule` reject the rule (the invoke used
    // to fail with "missing field `payload`" and the rule could never be
    // created).
    #[test]
    fn rewrite_rule_deserializes_actions_shape_without_legacy_payload() {
        let rule: RewriteRule =
            serde_json::from_value(actions_payload()).expect("new-shape rule must deserialize");
        assert_eq!(rule.id, "rule-1");
        assert_eq!(rule.payload, serde_json::Value::Null);
        assert_eq!(rule.actions.as_ref().map(Vec::len), Some(1));
    }

    // Legacy rows persisted before D2 carry `rewriteType` + `payload` and no
    // `actions`; they must keep deserializing (and keep feeding
    // `rewrite_actions`).
    #[test]
    fn rewrite_rule_deserializes_legacy_single_action_shape() {
        let mut legacy = actions_payload();
        let object = legacy.as_object_mut().unwrap();
        object.remove("actions");
        object.insert(
            "payload".to_string(),
            serde_json::json!({
                "headerName": "x-legacy",
                "operation": "remove",
                "target": "request"
            }),
        );

        let rule: RewriteRule =
            serde_json::from_value(legacy).expect("legacy rule must deserialize");
        assert!(rule.actions.is_none());
        assert_eq!(rule.payload["headerName"], "x-legacy");
    }
}
