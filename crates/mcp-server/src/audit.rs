use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use serde::Serialize;

const AUDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const AUDIT_RETAINED_FILES: usize = 3;
static AUDIT_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry<'a> {
    pub timestamp: String,
    pub client_name: &'a str,
    pub client_version: &'a str,
    pub tool: &'a str,
    pub action_summary: Option<String>,
    pub agent_control: bool,
    pub outcome: &'a str,
    pub duration_ms: u64,
    pub returned_bytes: Option<usize>,
    pub redacted: bool,
    pub truncated: bool,
    pub error_code: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct AuditLog {
    path: PathBuf,
}

impl AuditLog {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(&self, entry: &AuditEntry<'_>) -> Result<(), std::io::Error> {
        let _write_guard = audit_write_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        rotate_if_needed(&self.path)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.path)?;
        let mut line = serde_json::to_vec(entry).map_err(std::io::Error::other)?;
        line.push(b'\n');
        // One append-mode write keeps a line contiguous for this process; the
        // in-process lock serializes rotation and append.
        file.write_all(&line)?;
        Ok(())
    }

    /// Confirm the audit destination can be opened for append before a
    /// privileged action runs. This deliberately writes no synthetic entry;
    /// the real success/failure entry is recorded after the action.
    pub fn check_writable(&self) -> Result<(), std::io::Error> {
        let _write_guard = audit_write_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        rotate_if_needed(&self.path)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&self.path)?.sync_all()
    }
}

fn audit_write_lock() -> &'static Mutex<()> {
    AUDIT_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn is_agent_control_tool(tool: &str) -> bool {
    matches!(
        tool,
        "configure_workspace"
            | "start_capture"
            | "stop_capture"
            | "set_system_proxy"
            | "generate_certificate"
            | "open_certificate_installer"
            | "remove_certificate_trust"
            | "clear_sessions"
            | "delete_sessions"
            | "replay_session"
            | "create_agent_rule"
            | "remove_agent_rules"
    )
}

fn rotate_if_needed(path: &Path) -> Result<(), std::io::Error> {
    let size = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if size < AUDIT_MAX_BYTES {
        return Ok(());
    }

    for index in (1..AUDIT_RETAINED_FILES).rev() {
        let from = rotated_path(path, index);
        let to = rotated_path(path, index + 1);
        if from.exists() {
            let _ = fs::rename(from, to);
        }
    }
    let _ = fs::rename(path, rotated_path(path, 1));
    Ok(())
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(format!(".{index}"));
    PathBuf::from(value)
}

impl Default for AuditEntry<'_> {
    fn default() -> Self {
        Self {
            timestamp: Utc::now().to_rfc3339(),
            client_name: "unknown",
            client_version: "unknown",
            tool: "unknown",
            action_summary: None,
            agent_control: false,
            outcome: "success",
            duration_ms: 0,
            returned_bytes: None,
            redacted: true,
            truncated: false,
            error_code: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_entries_are_json_lines_without_payload_fields() {
        let directory = tempfile::tempdir().unwrap();
        let log = AuditLog::new(directory.path().join("agent-audit.jsonl"));
        log.append(&AuditEntry {
            client_name: "codex",
            client_version: "1.0",
            action_summary: Some("Start capture for workspace default".to_string()),
            tool: "search_sessions",
            returned_bytes: Some(128),
            ..AuditEntry::default()
        })
        .unwrap();
        let contents = fs::read_to_string(log.path()).unwrap();
        assert!(contents.contains("search_sessions"));
        assert!(contents.contains("actionSummary"));
        assert!(contents.contains("Start capture for workspace default"));
        assert!(!contents.contains("authorization"));
    }

    #[test]
    fn control_tools_are_marked_without_marking_read_tools() {
        assert!(is_agent_control_tool("start_capture"));
        assert!(is_agent_control_tool("clear_sessions"));
        assert!(!is_agent_control_tool("search_sessions"));
        assert!(!is_agent_control_tool("get_app_status"));
    }

    #[test]
    fn concurrent_appends_keep_every_json_line_intact() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent-audit.jsonl");
        let workers = (0..8)
            .map(|worker| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for index in 0..25 {
                        AuditLog::new(path.clone())
                            .append(&AuditEntry {
                                client_name: "concurrent-test",
                                client_version: "1.0",
                                tool: "delete_sessions",
                                action_summary: Some(format!("worker={worker} index={index}")),
                                ..AuditEntry::default()
                            })
                            .unwrap();
                    }
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap();
        }

        let contents = fs::read_to_string(path).unwrap();
        let entries = contents
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 200);
        assert!(entries
            .iter()
            .all(|entry| entry["tool"] == "delete_sessions"));
    }
}
