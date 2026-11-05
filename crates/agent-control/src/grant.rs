use serde::{Deserialize, Serialize};

use crate::ControlOperation;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AgentCapability {
    ReadSessions,
    ReadBodies,
    ReadRawBodies,
    ReadWebSocket,
    ExportSnapshots,
    ControlCapture,
    ControlSystemProxy,
    ManageCertificates,
    DeleteSessions,
    SendRequests,
    ManageRules,
    ManageAutomation,
    ManageUserAutomation,
    ManageScripts,
    ManageCrossHostMappings,
    ManageProxiedVerification,
    ManageGlobalAutomation,
}

impl AgentCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadSessions => "readSessions",
            Self::ReadBodies => "readBodies",
            Self::ReadRawBodies => "readRawBodies",
            Self::ReadWebSocket => "readWebSocket",
            Self::ExportSnapshots => "exportSnapshots",
            Self::ControlCapture => "controlCapture",
            Self::ControlSystemProxy => "controlSystemProxy",
            Self::ManageCertificates => "manageCertificates",
            Self::DeleteSessions => "deleteSessions",
            Self::SendRequests => "sendRequests",
            Self::ManageRules => "manageRules",
            Self::ManageAutomation => "manageAutomation",
            Self::ManageUserAutomation => "manageUserAutomation",
            Self::ManageScripts => "manageScripts",
            Self::ManageCrossHostMappings => "manageCrossHostMappings",
            Self::ManageProxiedVerification => "manageProxiedVerification",
            Self::ManageGlobalAutomation => "manageGlobalAutomation",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentGrantRequestPolicy {
    #[default]
    Deny,
    Ask,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentGrantStatus {
    Pending,
    Approved,
    Executing,
    Succeeded,
    Failed,
    Unknown,
    Expired,
    Revoked,
    Denied,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentGrantApprovalOption {
    Once,
    FifteenMinutes,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AutomationResourceLifecycle {
    Ephemeral,
    Persistent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentGrantCleanupPolicy {
    AgentOwnedOnly,
    Manual,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrantScope {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub session_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connection_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub automation_roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub origins: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrantResourcePolicy {
    pub lifecycle: AutomationResourceLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u64>,
    pub cleanup: AgentGrantCleanupPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrantRequest {
    pub capability: AgentCapability,
    pub action_fingerprint: String,
    pub action_summary: String,
    #[serde(default)]
    pub scope: AgentGrantScope,
    pub reason: String,
    #[serde(default = "default_approval_options")]
    pub approval_options: Vec<AgentGrantApprovalOption>,
    #[serde(default = "default_grant_request_ttl")]
    pub expires_in_seconds: u64,
    #[serde(default)]
    pub non_idempotent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_policy: Option<AgentGrantResourcePolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrant {
    pub id: String,
    pub request_id: String,
    pub capability: AgentCapability,
    pub client_name: String,
    pub client_version: String,
    pub agent_instance_id: String,
    pub action_fingerprint: String,
    pub action_summary: String,
    pub scope: AgentGrantScope,
    pub reason: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<String>,
    pub expires_at: String,
    pub max_uses: u32,
    pub remaining_uses: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_policy: Option<AgentGrantResourcePolicy>,
    pub status: AgentGrantStatus,
    pub approval_option: AgentGrantApprovalOption,
    pub non_idempotent: bool,
    #[serde(default = "default_approval_options")]
    pub approval_options: Vec<AgentGrantApprovalOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeAgentGrantParams {
    pub grant_id: String,
    pub capability: AgentCapability,
    pub action_fingerprint: String,
}

fn default_approval_options() -> Vec<AgentGrantApprovalOption> {
    vec![AgentGrantApprovalOption::Once]
}

fn default_grant_request_ttl() -> u64 {
    30
}

/// Capabilities that can only be approved for a single use. High-risk actions
/// must not receive the 15-minute / 50-use quota even when the client reports
/// them as idempotent; the desktop re-validates approval options at the IPC
/// boundary instead of trusting the sidecar.
pub fn capability_allows_repeat_approval(capability: AgentCapability) -> bool {
    !matches!(
        capability,
        AgentCapability::ReadRawBodies
            | AgentCapability::ControlSystemProxy
            | AgentCapability::ManageCertificates
            | AgentCapability::DeleteSessions
            | AgentCapability::ManageUserAutomation
            | AgentCapability::ManageScripts
            | AgentCapability::ManageCrossHostMappings
            | AgentCapability::ManageGlobalAutomation
    )
}

/// Build the approval options a capability may offer. This is the single
/// source of truth shared by the MCP sidecar's grant request and the desktop's
/// grant store, so a client cannot widen its own quota by lying about
/// `nonIdempotent`.
pub fn allowed_approval_options(
    capability: AgentCapability,
    non_idempotent: bool,
) -> Vec<AgentGrantApprovalOption> {
    if !non_idempotent && capability_allows_repeat_approval(capability) {
        vec![
            AgentGrantApprovalOption::Once,
            AgentGrantApprovalOption::FifteenMinutes,
        ]
    } else {
        vec![AgentGrantApprovalOption::Once]
    }
}

pub fn operation_action_fingerprint(operation: &ControlOperation) -> String {
    let serialized = serde_json::to_vec(operation).unwrap_or_default();
    sha256_hex(&serialized)
}

pub fn capability_action_fingerprint(
    capability: AgentCapability,
    scope: &AgentGrantScope,
) -> String {
    let serialized = serde_json::to_vec(&(capability, scope)).unwrap_or_default();
    sha256_hex(&serialized)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    format!("sha256:{digest:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_risk_capabilities_only_allow_once() {
        assert_eq!(
            allowed_approval_options(AgentCapability::DeleteSessions, false),
            vec![AgentGrantApprovalOption::Once]
        );
        assert_eq!(
            allowed_approval_options(AgentCapability::ManageUserAutomation, false),
            vec![AgentGrantApprovalOption::Once]
        );
        assert_eq!(
            allowed_approval_options(AgentCapability::ReadBodies, false),
            vec![
                AgentGrantApprovalOption::Once,
                AgentGrantApprovalOption::FifteenMinutes
            ]
        );
        assert_eq!(
            allowed_approval_options(AgentCapability::ReadBodies, true),
            vec![AgentGrantApprovalOption::Once]
        );
    }

    #[test]
    fn fingerprints_change_with_operation_parameters() {
        let scope = AgentGrantScope {
            session_ids: vec!["session-a".to_string()],
            ..AgentGrantScope::default()
        };
        let first = capability_action_fingerprint(AgentCapability::ReadBodies, &scope);
        let second = capability_action_fingerprint(
            AgentCapability::ReadBodies,
            &AgentGrantScope {
                session_ids: vec!["session-b".to_string()],
                ..scope
            },
        );
        assert!(first.starts_with("sha256:"));
        assert_ne!(first, second);
    }
}
