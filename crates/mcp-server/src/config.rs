use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const AGENT_ACCESS_CONFIG_VERSION: u32 = 1;
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
}

impl Default for AgentAccessPermissions {
    fn default() -> Self {
        Self {
            read_sessions: true,
            read_bodies: false,
            read_raw_bodies: false,
            read_web_socket: false,
            export_snapshots: false,
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
            updated_at: None,
        }
    }
}

impl AgentAccessConfig {
    pub fn normalized(mut self) -> Self {
        if !self.permissions.read_bodies {
            self.permissions.read_raw_bodies = false;
        }
        self.limits.max_sessions = self.limits.max_sessions.clamp(1, DEFAULT_MAX_SESSIONS);
        self.limits.max_body_bytes = self.limits.max_body_bytes.clamp(1, DEFAULT_MAX_BODY_BYTES);
        self.limits.max_response_bytes = self
            .limits
            .max_response_bytes
            .clamp(1, DEFAULT_MAX_RESPONSE_BYTES);
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
    if config.version != AGENT_ACCESS_CONFIG_VERSION {
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
    Ok(config.normalized())
}

/// Persist Agent Access configuration with an atomic replacement.
///
/// The file contains no secrets, but it controls which traffic an Agent may
/// read, so it is owner-only on Unix and restricted to the current user on
/// Windows. Callers must not pass arbitrary paths: the desktop command and the
/// sidecar both resolve this file under the AIProxy data directory.
pub fn write_config(path: &Path, config: &AgentAccessConfig) -> Result<(), String> {
    let config = config.clone().normalized();
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
}
