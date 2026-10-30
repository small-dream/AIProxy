use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const AGENT_ACCESS_CONFIG_VERSION: u32 = 3;
const MIN_SUPPORTED_CONFIG_VERSION: u32 = 2;
// Control permissions are additive and older readers ignore unknown fields.
// Keep the on-disk envelope at the oldest supported version so an older
// read-only sidecar can still read the same configuration after this app is
// upgraded. Readers normalize the in-memory contract to version 3.
const BACKWARD_COMPATIBLE_DISK_VERSION: u32 = MIN_SUPPORTED_CONFIG_VERSION;
pub const DEFAULT_MAX_SESSIONS: usize = 100;
pub const DEFAULT_MAX_BODY_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub body_dir: PathBuf,
    pub config_path: PathBuf,
    pub audit_path: PathBuf,
}

impl AppPaths {
    pub fn resolve(
        data_dir: Option<PathBuf>,
        config_path: Option<PathBuf>,
    ) -> Result<Self, String> {
        let data_dir = match data_dir {
            Some(path) => path,
            None => aiproxy_db::connection::resolve_db_dir()
                .map_err(|error| format!("resolve data directory: {error}"))?,
        };
        let config_path = config_path.unwrap_or_else(|| data_dir.join("agent-access.json"));

        Ok(Self {
            db_path: data_dir.join("aiproxy.db"),
            body_dir: data_dir.join("bodies"),
            audit_path: data_dir.join("agent-audit.jsonl"),
            data_dir,
            config_path,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessPermissions {
    pub read_sessions: bool,
    pub read_bodies: bool,
    pub read_raw_bodies: bool,
    pub read_web_socket: bool,
    pub export_snapshots: bool,
    #[serde(default)]
    pub control_capture: bool,
    #[serde(default)]
    pub control_system_proxy: bool,
    #[serde(default)]
    pub manage_certificates: bool,
    #[serde(default)]
    pub delete_sessions: bool,
    /// Allow replaying captured requests against their original upstream host.
    #[serde(default)]
    pub send_requests: bool,
    /// Allow creating and removing temporary in-memory Agent rules.
    #[serde(default)]
    pub manage_rules: bool,
}

impl Default for AgentAccessPermissions {
    fn default() -> Self {
        Self {
            read_sessions: true,
            read_bodies: false,
            read_raw_bodies: false,
            read_web_socket: false,
            export_snapshots: false,
            control_capture: false,
            control_system_proxy: false,
            manage_certificates: false,
            delete_sessions: false,
            send_requests: false,
            manage_rules: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessLimits {
    pub max_sessions: usize,
    pub max_body_bytes: usize,
    pub max_response_bytes: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RedactionAction {
    Redact,
    Hash,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactionPattern {
    pub name: String,
    pub pattern: String,
    pub action: RedactionAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessRedaction {
    pub detect_sensitive_values: bool,
    pub hash_identifiers: bool,
    pub custom_sensitive_keys: Vec<String>,
    pub custom_patterns: Vec<RedactionPattern>,
}

impl Default for AgentAccessRedaction {
    fn default() -> Self {
        Self {
            detect_sensitive_values: true,
            hash_identifiers: true,
            custom_sensitive_keys: Vec::new(),
            custom_patterns: Vec::new(),
        }
    }
}

impl Default for AgentAccessLimits {
    fn default() -> Self {
        Self {
            max_sessions: DEFAULT_MAX_SESSIONS,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessConfig {
    pub version: u32,
    pub enabled: bool,
    pub transport: String,
    pub permissions: AgentAccessPermissions,
    pub limits: AgentAccessLimits,
    #[serde(default)]
    pub redaction: AgentAccessRedaction,
    pub updated_at: Option<String>,
}

impl Default for AgentAccessConfig {
    fn default() -> Self {
        Self {
            version: AGENT_ACCESS_CONFIG_VERSION,
            enabled: false,
            transport: "stdio".to_string(),
            permissions: AgentAccessPermissions::default(),
            limits: AgentAccessLimits::default(),
            redaction: AgentAccessRedaction::default(),
            updated_at: None,
        }
    }
}

impl AgentAccessConfig {
    pub fn normalized(mut self) -> Self {
        // Reading a supported older version upgrades the in-memory contract.
        // Control permissions are absent in v2 and deserialize as false, so
        // this never grants authority implicitly.
        self.version = AGENT_ACCESS_CONFIG_VERSION;
        if !self.permissions.read_bodies {
            self.permissions.read_raw_bodies = false;
        }
        self.limits.max_sessions = self.limits.max_sessions.clamp(1, DEFAULT_MAX_SESSIONS);
        self.limits.max_body_bytes = self.limits.max_body_bytes.clamp(1, DEFAULT_MAX_BODY_BYTES);
        self.limits.max_response_bytes = self
            .limits
            .max_response_bytes
            .clamp(1, DEFAULT_MAX_RESPONSE_BYTES);
        self.redaction.custom_sensitive_keys = self
            .redaction
            .custom_sensitive_keys
            .into_iter()
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
            .take(50)
            .collect();
        self.redaction.custom_sensitive_keys.sort();
        self.redaction.custom_sensitive_keys.dedup();
        self.redaction.custom_patterns = self
            .redaction
            .custom_patterns
            .into_iter()
            .filter(|rule| !rule.name.trim().is_empty() && !rule.pattern.trim().is_empty())
            .take(20)
            .map(|mut rule| {
                rule.name = rule.name.trim().to_string();
                rule.pattern = rule.pattern.trim().to_string();
                rule
            })
            .collect();
        self
    }
}

#[derive(Debug, Clone)]
pub enum ConfigReadError {
    Missing,
    Invalid(String),
}

impl ConfigReadError {
    pub fn message(&self) -> String {
        match self {
            Self::Missing => "Agent Access configuration does not exist".to_string(),
            Self::Invalid(message) => message.clone(),
        }
    }
}

pub fn read_config(path: &Path) -> Result<AgentAccessConfig, ConfigReadError> {
    let contents = std::fs::read_to_string(path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => ConfigReadError::Missing,
        _ => ConfigReadError::Invalid(format!("read Agent Access configuration: {error}")),
    })?;
    let config: AgentAccessConfig = serde_json::from_str(&contents).map_err(|error| {
        ConfigReadError::Invalid(format!("parse Agent Access configuration: {error}"))
    })?;
    if config.version < MIN_SUPPORTED_CONFIG_VERSION || config.version > AGENT_ACCESS_CONFIG_VERSION
    {
        return Err(ConfigReadError::Invalid(format!(
            "unsupported Agent Access configuration version {}",
            config.version
        )));
    }
    if config.transport != "stdio" {
        return Err(ConfigReadError::Invalid(
            "only the stdio transport is supported".to_string(),
        ));
    }
    // v2 predates Agent control. Missing control flags deserialize as false,
    // so upgrading the in-memory version never grants new authority.
    Ok(config.normalized())
}

/// Persist Agent Access configuration with an atomic replacement.
///
/// The file contains no secrets, but it controls which traffic an Agent may
/// read, so it is owner-only on Unix and restricted to the current user on
/// Windows. Callers must not pass arbitrary paths: the desktop command and the
/// sidecar both resolve this file under the AIProxy data directory.
pub fn write_config(path: &Path, config: &AgentAccessConfig) -> Result<(), String> {
    let mut config = config.clone().normalized();
    config.version = BACKWARD_COMPATIBLE_DISK_VERSION;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create Agent Access directory: {error}"))?;
    }

    let contents = serde_json::to_vec_pretty(&config)
        .map_err(|error| format!("serialize Agent Access configuration: {error}"))?;
    write_private_file_atomic(path, &contents)
        .map_err(|error| format!("write Agent Access configuration: {error}"))?;

    #[cfg(windows)]
    restrict_windows_acl(path);

    Ok(())
}

fn write_private_file_atomic(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    let mut file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "invalid config path"))?
        .to_os_string();
    file_name.push(format!(".tmp-{}", std::process::id()));
    let temp_path = path.with_file_name(file_name);

    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let write_result = (|| {
        let mut file = options.open(&temp_path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600))?;
        }
        replace_file(&temp_path, path)
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_result
}

fn replace_file(from: &Path, to: &Path) -> Result<(), std::io::Error> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        // Windows does not replace an existing destination with rename().
        Err(error) if cfg!(windows) => {
            if to.exists() {
                std::fs::remove_file(to)?;
            }
            std::fs::rename(from, to).map_err(|_| error)
        }
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn restrict_windows_acl(path: &Path) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.trim().is_empty() {
        tracing::warn!("could not restrict Agent Access config ACL: USERNAME is unavailable");
        return;
    }
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let principal = if domain.trim().is_empty() {
        user
    } else {
        format!("{domain}\\{user}")
    };
    let result = std::process::Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(format!("{principal}:F"))
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match result {
        Ok(output) if output.status.success() => {}
        Ok(output) => tracing::warn!(
            status = ?output.status.code(),
            "failed to restrict Agent Access config ACL"
        ),
        Err(error) => tracing::warn!(%error, "failed to run icacls for Agent Access config"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_body_requires_body_permission() {
        let config = AgentAccessConfig {
            permissions: AgentAccessPermissions {
                read_bodies: false,
                read_raw_bodies: true,
                ..AgentAccessPermissions::default()
            },
            ..AgentAccessConfig::default()
        }
        .normalized();
        assert!(!config.permissions.read_raw_bodies);
    }

    #[test]
    fn limits_are_clamped() {
        let config = AgentAccessConfig {
            limits: AgentAccessLimits {
                max_sessions: 999,
                max_body_bytes: usize::MAX,
                max_response_bytes: 0,
            },
            ..AgentAccessConfig::default()
        }
        .normalized();
        assert_eq!(config.limits.max_sessions, DEFAULT_MAX_SESSIONS);
        assert_eq!(config.limits.max_body_bytes, DEFAULT_MAX_BODY_BYTES);
        assert_eq!(config.limits.max_response_bytes, 1);
    }

    #[test]
    fn redaction_rules_are_normalized_and_bounded() {
        let config = AgentAccessConfig {
            redaction: AgentAccessRedaction {
                custom_sensitive_keys: vec![
                    " Employee_ID ".into(),
                    "employee_id".into(),
                    "".into(),
                ],
                custom_patterns: vec![
                    RedactionPattern {
                        name: " employee-number ".into(),
                        pattern: " EMP-[0-9]{8} ".into(),
                        action: RedactionAction::Hash,
                    },
                    RedactionPattern {
                        name: "".into(),
                        pattern: "ignored".into(),
                        action: RedactionAction::Redact,
                    },
                ],
                ..AgentAccessRedaction::default()
            },
            ..AgentAccessConfig::default()
        }
        .normalized();

        assert_eq!(config.redaction.custom_sensitive_keys, ["employee_id"]);
        assert_eq!(config.redaction.custom_patterns.len(), 1);
        assert_eq!(config.redaction.custom_patterns[0].name, "employee-number");
        assert_eq!(config.redaction.custom_patterns[0].pattern, "EMP-[0-9]{8}");
        assert_eq!(
            config.redaction.custom_patterns[0].action,
            RedactionAction::Hash
        );
    }

    #[test]
    fn write_config_round_trips_and_creates_missing_parents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested").join("agent-access.json");
        let config = AgentAccessConfig {
            enabled: true,
            permissions: AgentAccessPermissions {
                read_bodies: true,
                ..AgentAccessPermissions::default()
            },
            ..AgentAccessConfig::default()
        };

        write_config(&path, &config).unwrap();
        let loaded = read_config(&path).unwrap();
        assert!(loaded.enabled);
        assert!(loaded.permissions.read_bodies);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn written_config_stays_readable_by_old_sidecars() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-access.json");
        let config = AgentAccessConfig {
            enabled: true,
            permissions: AgentAccessPermissions {
                read_bodies: true,
                control_capture: true,
                control_system_proxy: true,
                manage_certificates: true,
                delete_sessions: true,
                ..AgentAccessPermissions::default()
            },
            ..AgentAccessConfig::default()
        };

        write_config(&path, &config).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["version"], BACKWARD_COMPATIBLE_DISK_VERSION);
        assert_eq!(raw["permissions"]["controlCapture"], true);

        // Older readers ignore the additive control fields; the new reader
        // upgrades the envelope without losing any granted permissions.
        let loaded = read_config(&path).unwrap();
        assert_eq!(loaded.version, AGENT_ACCESS_CONFIG_VERSION);
        assert!(loaded.permissions.control_capture);
        assert!(loaded.permissions.control_system_proxy);
        assert!(loaded.permissions.manage_certificates);
        assert!(loaded.permissions.delete_sessions);
    }

    #[test]
    fn v2_config_upgrades_to_v3_without_implicit_control_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-access.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "version": 2,
                "enabled": true,
                "transport": "stdio",
                "permissions": {
                    "readSessions": true,
                    "readBodies": true,
                    "readRawBodies": false,
                    "readWebSocket": true,
                    "exportSnapshots": false
                },
                "limits": {
                    "maxSessions": 100,
                    "maxBodyBytes": 262144,
                    "maxResponseBytes": 1048576
                },
                "redaction": AgentAccessRedaction::default(),
                "updatedAt": null
            })
            .to_string(),
        )
        .unwrap();

        let loaded = read_config(&path).unwrap();
        assert_eq!(loaded.version, AGENT_ACCESS_CONFIG_VERSION);
        assert!(loaded.enabled);
        assert!(loaded.permissions.read_bodies);
        assert!(!loaded.permissions.control_capture);
        assert!(!loaded.permissions.control_system_proxy);
        assert!(!loaded.permissions.manage_certificates);
        assert!(!loaded.permissions.delete_sessions);
    }
}
