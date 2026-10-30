use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CONTROL_PROTOCOL_VERSION: u16 = 1;
pub const CONTROL_DESCRIPTOR_FILE: &str = "agent-control.json";
// A configure_workspace request may legitimately carry 500 include rules and
// 500 exclude rules, each up to 1 KiB. Keep a hard bound without rejecting a
// request that passes the public parameter validation.
pub const CONTROL_MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
pub const CONTROL_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const CONTROL_WRITE_TIMEOUT_SECS: u64 = 60;

pub const DIAGNOSTIC_LOG_MAX_LINES: usize = 120;
pub const DIAGNOSTIC_LOG_MAX_BYTES: usize = 64 * 1024;
pub const DIAGNOSTIC_AUDIT_MAX_ENTRIES: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlDescriptor {
    pub protocol_version: u16,
    pub endpoint: String,
    pub token: String,
    pub pid: u32,
    pub app_version: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub protocol_version: u16,
    pub request_id: String,
    pub token: String,
    /// Identity propagated to the desktop audit log. Older sidecars omit it;
    /// the desktop then records the request as an unknown local client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
    pub operation: ControlOperation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
pub enum ControlOperation {
    GetStatus,
    ReadDiagnosticLogs(ReadDiagnosticLogsParams),
    ConfigureWorkspace(ConfigureWorkspaceParams),
    StartCapture(WorkspaceParams),
    StopCapture(WorkspaceParams),
    SetSystemProxy(SetSystemProxyParams),
    GenerateCertificate(GenerateCertificateParams),
    OpenCertificateInstaller,
    RemoveCertificateTrust,
    ClearSessions,
    DeleteSessions(DeleteSessionsParams),
    ReplaySession(ReplaySessionParams),
    CreateAgentRule(CreateAgentRuleParams),
    ListAgentRules,
    RemoveAgentRules(RemoveAgentRulesParams),
}

impl ControlOperation {
    pub fn required_permission(&self) -> Option<ControlPermission> {
        match self {
            Self::GetStatus | Self::ReadDiagnosticLogs(_) => None,
            Self::ConfigureWorkspace(_) | Self::StartCapture(_) | Self::StopCapture(_) => {
                Some(ControlPermission::ControlCapture)
            }
            Self::SetSystemProxy(_) => Some(ControlPermission::ControlSystemProxy),
            Self::GenerateCertificate(_)
            | Self::OpenCertificateInstaller
            | Self::RemoveCertificateTrust => Some(ControlPermission::ManageCertificates),
            Self::ClearSessions | Self::DeleteSessions(_) => {
                Some(ControlPermission::DeleteSessions)
            }
            Self::ReplaySession(_) => Some(ControlPermission::SendRequests),
            Self::CreateAgentRule(_) | Self::ListAgentRules | Self::RemoveAgentRules(_) => {
                Some(ControlPermission::ManageRules)
            }
        }
    }

    pub fn is_write(&self) -> bool {
        !matches!(
            self,
            Self::GetStatus | Self::ReadDiagnosticLogs(_) | Self::ListAgentRules
        )
    }

    pub fn method_name(&self) -> &'static str {
        match self {
            Self::GetStatus => "getStatus",
            Self::ReadDiagnosticLogs(_) => "readDiagnosticLogs",
            Self::ConfigureWorkspace(_) => "configureWorkspace",
            Self::StartCapture(_) => "startCapture",
            Self::StopCapture(_) => "stopCapture",
            Self::SetSystemProxy(_) => "setSystemProxy",
            Self::GenerateCertificate(_) => "generateCertificate",
            Self::OpenCertificateInstaller => "openCertificateInstaller",
            Self::RemoveCertificateTrust => "removeCertificateTrust",
            Self::ClearSessions => "clearSessions",
            Self::DeleteSessions(_) => "deleteSessions",
            Self::ReplaySession(_) => "replaySession",
            Self::CreateAgentRule(_) => "createAgentRule",
            Self::ListAgentRules => "listAgentRules",
            Self::RemoveAgentRules(_) => "removeAgentRules",
        }
    }

    /// MCP tool name used by the audit log and Settings table. Keep this in
    /// sync with the public tool contract instead of exposing the IPC method
    /// name, which uses a different casing convention.
    pub fn audit_tool_name(&self) -> &'static str {
        match self {
            Self::GetStatus => "get_app_status",
            Self::ReadDiagnosticLogs(_) => "diagnose_ai_proxy_issue",
            Self::ConfigureWorkspace(_) => "configure_workspace",
            Self::StartCapture(_) => "start_capture",
            Self::StopCapture(_) => "stop_capture",
            Self::SetSystemProxy(_) => "set_system_proxy",
            Self::GenerateCertificate(_) => "generate_certificate",
            Self::OpenCertificateInstaller => "open_certificate_installer",
            Self::RemoveCertificateTrust => "remove_certificate_trust",
            Self::ClearSessions => "clear_sessions",
            Self::DeleteSessions(_) => "delete_sessions",
            Self::ReplaySession(_) => "replay_session",
            Self::CreateAgentRule(_) => "create_agent_rule",
            Self::ListAgentRules => "list_agent_rules",
            Self::RemoveAgentRules(_) => "remove_agent_rules",
        }
    }

    /// Safe, non-secret summary suitable for audit logs and UI event badges.
    pub fn action_summary(&self) -> String {
        match self {
            Self::GetStatus => "Read AIProxy application status".to_string(),
            Self::ReadDiagnosticLogs(params) => {
                format!(
                    "Read bounded AIProxy diagnostics (lines={})",
                    params.max_lines
                )
            }
            Self::ConfigureWorkspace(params) => format!(
                "Configure workspace {} (port/SSL/HTTP2 policy)",
                params.workspace_id.as_deref().unwrap_or("active")
            ),
            Self::StartCapture(params) => format!(
                "Start capture for workspace {}",
                params.workspace_id.as_deref().unwrap_or("active")
            ),
            Self::StopCapture(params) => format!(
                "Stop capture for workspace {}",
                params.workspace_id.as_deref().unwrap_or("active")
            ),
            Self::SetSystemProxy(params) => {
                format!("Set system proxy enabled={}", params.enabled)
            }
            Self::GenerateCertificate(params) => format!(
                "Generate root certificate (forceRegenerate={})",
                params.force_regenerate
            ),
            Self::OpenCertificateInstaller => "Open the platform certificate installer".to_string(),
            Self::RemoveCertificateTrust => {
                "Remove root certificate trust and switch to HTTP-only capture".to_string()
            }
            Self::ClearSessions => "Delete all sessions and body files".to_string(),
            Self::DeleteSessions(params) => {
                format!("Delete {} sessions by id", params.session_ids.len())
            }
            Self::ReplaySession(params) => {
                let fields = replay_override_fields(params);
                let field_summary = if fields.is_empty() {
                    "none".to_string()
                } else {
                    fields.join(",")
                };
                format!(
                    "Replay session {} directly to its original upstream (overrides={field_summary})",
                    params.session_id
                )
            }
            Self::CreateAgentRule(params) => format!(
                "Create temporary {} rule {}",
                params.action.kind(),
                params.name.as_deref().unwrap_or("(unnamed)")
            ),
            Self::ListAgentRules => "List temporary Agent rules".to_string(),
            Self::RemoveAgentRules(params) => {
                format!("Remove {} temporary Agent rules", params.rule_ids.len())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ControlPermission {
    ControlCapture,
    ControlSystemProxy,
    ManageCertificates,
    DeleteSessions,
    SendRequests,
    ManageRules,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureWorkspaceParams {
    pub workspace_id: Option<String>,
    pub proxy_port: Option<u16>,
    pub ssl_enabled: Option<bool>,
    pub http2_enabled: Option<bool>,
    pub ssl_blind_hosts: Option<Vec<String>>,
    pub ssl_proxying: Option<SslProxyingSettingsDto>,
    pub apply_now: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SslProxyingSettingsDto {
    pub include_enabled: bool,
    pub exclude_enabled: bool,
    pub include: Vec<SslProxyEntryDto>,
    pub exclude: Vec<SslProxyEntryDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SslProxyEntryDto {
    pub pattern: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceParams {
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetSystemProxyParams {
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateCertificateParams {
    pub force_regenerate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadDiagnosticLogsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default)]
    pub max_lines: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<DiagnosticLogLevel>,
    #[serde(default)]
    pub include_app_log: bool,
    #[serde(default)]
    pub include_audit_log: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLogLevel {
    Error,
    Warning,
    Any,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionsParams {
    pub session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeaderOverride {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueryParamOverride {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySessionParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub set_headers: Vec<HeaderOverride>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_headers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub set_query_params: Vec<QueryParamOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub json_set: BTreeMap<String, Value>,
}

fn replay_override_fields(params: &ReplaySessionParams) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if params.method.is_some() {
        fields.push("method");
    }
    if !params.set_headers.is_empty() {
        fields.push("setHeaders");
    }
    if !params.remove_headers.is_empty() {
        fields.push("removeHeaders");
    }
    if !params.set_query_params.is_empty() {
        fields.push("setQueryParams");
    }
    if params.body.is_some() {
        fields.push("body");
    }
    if !params.json_set.is_empty() {
        fields.push("jsonSet");
    }
    fields
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentRuleAction {
    SetRequestHeader {
        name: String,
        value: String,
    },
    RemoveRequestHeader {
        name: String,
    },
    SetQueryParam {
        name: String,
        value: String,
    },
    RemoveQueryParam {
        name: String,
    },
    SetResponseHeader {
        name: String,
        value: String,
    },
    RemoveResponseHeader {
        name: String,
    },
    ReplaceResponseBody {
        content_type: String,
        body: String,
    },
    SetResponseJsonFields {
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        fields: BTreeMap<String, Value>,
    },
    MapRemote {
        target_url: String,
        #[serde(default)]
        preserve_path: bool,
        #[serde(default)]
        preserve_query: bool,
    },
    MockResponseBody {
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
    },
}

impl AgentRuleAction {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::SetRequestHeader { .. } => "setRequestHeader",
            Self::RemoveRequestHeader { .. } => "removeRequestHeader",
            Self::SetQueryParam { .. } => "setQueryParam",
            Self::RemoveQueryParam { .. } => "removeQueryParam",
            Self::SetResponseHeader { .. } => "setResponseHeader",
            Self::RemoveResponseHeader { .. } => "removeResponseHeader",
            Self::ReplaceResponseBody { .. } => "replaceResponseBody",
            Self::SetResponseJsonFields { .. } => "setResponseJsonFields",
            Self::MapRemote { .. } => "mapRemote",
            Self::MockResponseBody { .. } => "mockResponseBody",
        }
    }

    pub fn requires_manage_rules(&self) -> bool {
        matches!(self, Self::MapRemote { .. } | Self::MockResponseBody { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentRuleParams {
    pub url_pattern: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u64>,
    pub action: AgentRuleAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveAgentRulesParams {
    pub rule_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
    pub protocol_version: u16,
    pub request_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

impl ControlResponse {
    pub fn success(request_id: String, data: Value) -> Self {
        Self {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id,
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn failure(request_id: String, error: ControlError) -> Self {
        Self {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id,
            ok: false,
            data: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ControlError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            details: None,
        }
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

pub fn descriptor_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONTROL_DESCRIPTOR_FILE)
}

pub fn read_descriptor(data_dir: &Path) -> Result<ControlDescriptor, String> {
    let path = descriptor_path(data_dir);
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_str(&contents).map_err(|error| format!("parse {}: {error}", path.display()))
}

pub fn write_descriptor(data_dir: &Path, descriptor: &ControlDescriptor) -> Result<(), String> {
    let path = descriptor_path(data_dir);
    write_private_json(&path, descriptor)
}

pub fn remove_descriptor(data_dir: &Path) {
    let _ = std::fs::remove_file(descriptor_path(data_dir));
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }

    let mut rendered = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serialize control descriptor: {error}"))?;
    rendered.push(b'\n');
    let temp_path = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| {
        let mut file = options
            .open(&temp_path)
            .map_err(|error| format!("open {}: {error}", temp_path.display()))?;
        file.write_all(&rendered)
            .map_err(|error| format!("write {}: {error}", temp_path.display()))?;
        file.sync_all()
            .map_err(|error| format!("sync {}: {error}", temp_path.display()))?;
        restrict_windows_acl(&temp_path)?;
        replace_file(&temp_path, path)
            .map_err(|error| format!("replace {}: {error}", path.display()))
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_result
}

fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if cfg!(windows) && to.exists() => {
            std::fs::remove_file(to)?;
            std::fs::rename(from, to).map_err(|_| error)
        }
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn restrict_windows_acl(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.trim().is_empty() {
        return Err(
            "could not restrict the AIProxy control descriptor ACL: USERNAME is unavailable"
                .to_string(),
        );
    }
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let principal = if domain.trim().is_empty() {
        user
    } else {
        format!("{domain}\\{user}")
    };
    let output = std::process::Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(format!("{principal}:F"))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| {
            format!("could not restrict the AIProxy control descriptor ACL: {error}")
        })?;
    if !output.status.success() {
        return Err(format!(
            "could not restrict the AIProxy control descriptor ACL (icacls exit code {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn restrict_windows_acl(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub fn token_matches(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .as_bytes()
        .iter()
        .zip(provided.as_bytes())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

/// Read one newline-delimited JSON frame with a hard byte limit. The limit is
/// enforced while reading so a malicious or broken peer cannot force an
/// unbounded allocation before validation runs.
pub fn read_json_line<R: BufRead>(reader: &mut R, max_bytes: usize) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            if output.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "control request ended before a frame was received",
                ));
            }
            break;
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let take = end.map_or(buffer.len(), |index| index + 1);
        // The newline is framing, not payload. Counting it against the limit
        // would reject a valid frame whose JSON payload is exactly max_bytes.
        let payload_bytes = if end.is_some() { take - 1 } else { take };
        if output.len() + payload_bytes > max_bytes {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("control frame exceeds {max_bytes} bytes"),
            ));
        }
        output.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if end.is_some() {
            break;
        }
    }
    if output.last() == Some(&b'\n') {
        output.pop();
    }
    if output.last() == Some(&b'\r') {
        output.pop();
    }
    Ok(output)
}

pub fn write_json_line<W: Write>(writer: &mut W, value: &impl Serialize) -> std::io::Result<()> {
    write_json_line_with_limit(writer, value, CONTROL_MAX_RESPONSE_BYTES)
}

pub fn write_json_line_with_limit<W: Write>(
    writer: &mut W,
    value: &impl Serialize,
    max_bytes: usize,
) -> std::io::Result<()> {
    let mut rendered = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    if rendered.len() > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("control frame exceeds {max_bytes} bytes"),
        ));
    }
    rendered.push(b'\n');
    writer.write_all(&rendered)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_round_trip_is_private_and_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = ControlDescriptor {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            endpoint: "aiproxy-test-control".to_string(),
            token: "secret".to_string(),
            pid: std::process::id(),
            app_version: "0.0.0".to_string(),
            started_at: "2026-10-26T00:00:00Z".to_string(),
        };
        write_descriptor(dir.path(), &descriptor).unwrap();
        assert_eq!(read_descriptor(dir.path()).unwrap(), descriptor);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(descriptor_path(dir.path()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn token_comparison_rejects_mismatches_and_accepts_equal_values() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("abc", "ab"));
    }

    #[test]
    fn json_line_reader_enforces_the_frame_limit() {
        let mut small = std::io::Cursor::new(b"{\"ok\":true}\n{}".to_vec());
        assert_eq!(read_json_line(&mut small, 32).unwrap(), b"{\"ok\":true}");
        let mut oversized = std::io::Cursor::new(vec![b'a'; 64]);
        assert_eq!(
            read_json_line(&mut oversized, 16).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );

        let exact_payload = b"12345678";
        let exact_frame = [exact_payload.as_slice(), b"\n"].concat();
        assert_eq!(
            read_json_line(&mut std::io::Cursor::new(exact_frame), exact_payload.len()).unwrap(),
            exact_payload
        );
        let over_limit_frame = [b"123456789".as_slice(), b"\n"].concat();
        assert_eq!(
            read_json_line(
                &mut std::io::Cursor::new(over_limit_frame),
                exact_payload.len()
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn json_line_writer_accepts_an_exact_limit_and_rejects_oversized_frames() {
        let mut exact = Vec::new();
        write_json_line_with_limit(&mut exact, &"12345678", 10).unwrap();
        assert_eq!(exact, b"\"12345678\"\n");

        let mut oversized = Vec::new();
        assert_eq!(
            write_json_line_with_limit(&mut oversized, &"123456789", 10)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn maximum_valid_configure_request_fits_the_request_frame_limit() {
        let pattern = "x".repeat(1024);
        let entries = || {
            (0..500)
                .map(|_| SslProxyEntryDto {
                    pattern: pattern.clone(),
                    enabled: true,
                })
                .collect::<Vec<_>>()
        };
        let request = ControlRequest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: "request-1".to_string(),
            token: "a".repeat(64),
            client_name: Some("codex".to_string()),
            client_version: Some("1.0".to_string()),
            operation: ControlOperation::ConfigureWorkspace(ConfigureWorkspaceParams {
                workspace_id: Some("default".to_string()),
                proxy_port: Some(8899),
                ssl_enabled: Some(true),
                http2_enabled: Some(true),
                ssl_blind_hosts: Some(
                    (0..500)
                        .map(|index| format!("host-{index}.example.com"))
                        .collect(),
                ),
                ssl_proxying: Some(SslProxyingSettingsDto {
                    include_enabled: true,
                    exclude_enabled: true,
                    include: entries(),
                    exclude: entries(),
                }),
                apply_now: Some(true),
            }),
        };
        let bytes = serde_json::to_vec(&request).unwrap();
        assert!(bytes.len() > 64 * 1024);
        assert!(bytes.len() <= CONTROL_MAX_REQUEST_BYTES);
    }

    #[test]
    fn write_operations_require_a_permission() {
        assert_eq!(ControlOperation::GetStatus.required_permission(), None);
        assert_eq!(
            ControlOperation::ReadDiagnosticLogs(ReadDiagnosticLogsParams {
                query: None,
                max_lines: 20,
                level: None,
                include_app_log: true,
                include_audit_log: true,
            })
            .required_permission(),
            None
        );
        assert_eq!(
            ControlOperation::StopCapture(WorkspaceParams::default()).required_permission(),
            Some(ControlPermission::ControlCapture)
        );
        assert_eq!(
            ControlOperation::ClearSessions.required_permission(),
            Some(ControlPermission::DeleteSessions)
        );
        assert_eq!(
            ControlOperation::ReplaySession(ReplaySessionParams {
                session_id: "session-1".to_string(),
                method: None,
                set_headers: Vec::new(),
                remove_headers: Vec::new(),
                set_query_params: Vec::new(),
                body: None,
                json_set: BTreeMap::new(),
            })
            .required_permission(),
            Some(ControlPermission::SendRequests)
        );
        assert_eq!(
            ControlOperation::CreateAgentRule(CreateAgentRuleParams {
                url_pattern: "https://api.example.com/*".to_string(),
                methods: Vec::new(),
                match_type: None,
                name: None,
                ttl_seconds: None,
                action: AgentRuleAction::SetRequestHeader {
                    name: "x-agent".to_string(),
                    value: "1".to_string(),
                },
            })
            .required_permission(),
            Some(ControlPermission::ManageRules)
        );
        assert_eq!(
            ControlOperation::ListAgentRules.required_permission(),
            Some(ControlPermission::ManageRules)
        );
        assert!(!ControlOperation::ListAgentRules.is_write());
        assert_eq!(
            ControlOperation::RemoveAgentRules(RemoveAgentRulesParams {
                rule_ids: vec!["rule-1".to_string()],
            })
            .required_permission(),
            Some(ControlPermission::ManageRules)
        );
        assert!(
            ControlOperation::SetSystemProxy(SetSystemProxyParams { enabled: true }).is_write()
        );
    }

    #[test]
    fn audit_tool_names_use_the_public_mcp_contract() {
        let names = [
            ControlOperation::GetStatus,
            ControlOperation::ReadDiagnosticLogs(ReadDiagnosticLogsParams {
                query: None,
                max_lines: 20,
                level: None,
                include_app_log: true,
                include_audit_log: true,
            }),
            ControlOperation::ConfigureWorkspace(Default::default()),
            ControlOperation::StartCapture(Default::default()),
            ControlOperation::StopCapture(Default::default()),
            ControlOperation::SetSystemProxy(SetSystemProxyParams { enabled: true }),
            ControlOperation::GenerateCertificate(Default::default()),
            ControlOperation::OpenCertificateInstaller,
            ControlOperation::RemoveCertificateTrust,
            ControlOperation::ClearSessions,
            ControlOperation::DeleteSessions(DeleteSessionsParams {
                session_ids: vec!["session-1".to_string()],
            }),
            ControlOperation::ReplaySession(ReplaySessionParams {
                session_id: "session-1".to_string(),
                method: None,
                set_headers: Vec::new(),
                remove_headers: Vec::new(),
                set_query_params: Vec::new(),
                body: None,
                json_set: BTreeMap::new(),
            }),
            ControlOperation::CreateAgentRule(CreateAgentRuleParams {
                url_pattern: "https://api.example.com/*".to_string(),
                methods: Vec::new(),
                match_type: None,
                name: None,
                ttl_seconds: None,
                action: AgentRuleAction::SetRequestHeader {
                    name: "x-agent".to_string(),
                    value: "1".to_string(),
                },
            }),
            ControlOperation::ListAgentRules,
            ControlOperation::RemoveAgentRules(RemoveAgentRulesParams {
                rule_ids: vec!["rule-1".to_string()],
            }),
        ]
        .map(|operation| operation.audit_tool_name());

        assert_eq!(
            names,
            [
                "get_app_status",
                "diagnose_ai_proxy_issue",
                "configure_workspace",
                "start_capture",
                "stop_capture",
                "set_system_proxy",
                "generate_certificate",
                "open_certificate_installer",
                "remove_certificate_trust",
                "clear_sessions",
                "delete_sessions",
                "replay_session",
                "create_agent_rule",
                "list_agent_rules",
                "remove_agent_rules",
            ]
        );
    }

    #[test]
    fn control_summaries_omit_replay_and_rule_values() {
        let replay = ControlOperation::ReplaySession(ReplaySessionParams {
            session_id: "session-1".to_string(),
            method: Some("POST".to_string()),
            set_headers: vec![HeaderOverride {
                name: "Authorization".to_string(),
                value: "Bearer TOP_SECRET".to_string(),
            }],
            remove_headers: vec!["Cookie".to_string()],
            set_query_params: vec![QueryParamOverride {
                name: "token".to_string(),
                value: "QUERY_SECRET".to_string(),
            }],
            body: Some("BODY_SECRET".to_string()),
            json_set: BTreeMap::from([(
                "password".to_string(),
                Value::String("JSON_SECRET".to_string()),
            )]),
        })
        .action_summary();
        assert!(replay.contains("method,setHeaders,removeHeaders,setQueryParams,body,jsonSet"));
        assert!(!replay.contains("TOP_SECRET"));
        assert!(!replay.contains("QUERY_SECRET"));
        assert!(!replay.contains("BODY_SECRET"));
        assert!(!replay.contains("JSON_SECRET"));

        let rule = ControlOperation::CreateAgentRule(CreateAgentRuleParams {
            url_pattern: "https://api.example.com/*".to_string(),
            methods: Vec::new(),
            match_type: None,
            name: Some("temporary override".to_string()),
            ttl_seconds: None,
            action: AgentRuleAction::SetRequestHeader {
                name: "Authorization".to_string(),
                value: "Bearer RULE_SECRET".to_string(),
            },
        })
        .action_summary();
        assert!(rule.contains("setRequestHeader"));
        assert!(!rule.contains("RULE_SECRET"));
    }

    #[test]
    fn requests_from_older_sidecars_do_not_require_client_identity() {
        let request: ControlRequest = serde_json::from_value(serde_json::json!({
            "protocolVersion": CONTROL_PROTOCOL_VERSION,
            "requestId": "request-1",
            "token": "token",
            "operation": { "method": "getStatus" }
        }))
        .unwrap();
        assert!(request.client_name.is_none());
        assert!(request.client_version.is_none());
        assert_eq!(request.operation, ControlOperation::GetStatus);
    }
}
