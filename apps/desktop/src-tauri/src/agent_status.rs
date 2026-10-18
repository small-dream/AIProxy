use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;

use crate::bootstrap::{AppState, BootstrapStatus};

pub const STATUS_FILE_NAME: &str = "agent-status.json";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Heartbeat consumed by `aiproxy-mcp` to report `meta.captureStatus` and
/// `meta.captureUpdatedAt`. It contains no traffic data.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusFile {
    pub app_running: bool,
    pub capturing: bool,
    pub proxy_port: u16,
    pub workspace_id: Option<String>,
    pub capture_started_at: Option<String>,
    pub updated_at: String,
}

pub fn snapshot(status: &BootstrapStatus) -> AgentStatusFile {
    AgentStatusFile {
        app_running: true,
        capturing: status.running,
        proxy_port: status.port,
        workspace_id: status.active_workspace_id.clone(),
        capture_started_at: status.started_at.clone(),
        updated_at: Utc::now().to_rfc3339(),
    }
}

/// Write the current proxy state. Best-effort: failures are logged and never
/// block proxy start/stop.
pub fn write_from_state(state: &AppState) {
    let mut file = snapshot(&state.read_status());
    file.updated_at = Utc::now().to_rfc3339();
    if let Err(error) = write_status(&file) {
        tracing::warn!(
            component = "desktop.agent_status",
            event = "agent_status_write_failed",
            error = %error,
            "agent_status_write_failed"
        );
    }
}

/// Mark the desktop app as stopped on shutdown so the next Agent call does not
/// claim capture is still running.
pub fn write_shutdown(state: &AppState) {
    let mut file = snapshot(&state.read_status());
    file.app_running = false;
    file.capturing = false;
    file.updated_at = Utc::now().to_rfc3339();
    let _ = write_status(&file);
}

pub fn spawn_heartbeat(state: Arc<AppState>) {
    let _ = std::thread::Builder::new()
        .name("agent-status-heartbeat".to_string())
        .spawn(move || loop {
            write_from_state(&state);
            std::thread::sleep(HEARTBEAT_INTERVAL);
        });
}

fn write_status(file: &AgentStatusFile) -> std::io::Result<()> {
    let path = status_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut rendered = serde_json::to_vec_pretty(file)?;
    rendered.push(b'\n');

    let mut file_name = path.file_name().unwrap_or_default().to_os_string();
    file_name.push(format!(
        ".tmp-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let temp_path = path.with_file_name(file_name);

    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut handle = options.open(&temp_path)?;
        handle.write_all(&rendered)?;
        handle.sync_all()?;
        replace_file(&temp_path, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn replace_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if cfg!(windows) && to.exists() => {
            std::fs::remove_file(to)?;
            std::fs::rename(from, to).map_err(|_| error)
        }
        Err(error) => Err(error),
    }
}

fn status_path() -> std::io::Result<PathBuf> {
    aiproxy_db::connection::resolve_db_dir()
        .map(|directory| directory.join(STATUS_FILE_NAME))
        .map_err(|error| std::io::Error::other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_marks_running_capture() {
        let status = BootstrapStatus {
            running: true,
            port: 9090,
            active_workspace_id: Some("default".to_string()),
            ..BootstrapStatus::default()
        };
        let file = snapshot(&status);
        assert!(file.app_running);
        assert!(file.capturing);
        assert_eq!(file.proxy_port, 9090);
        assert_eq!(file.workspace_id.as_deref(), Some("default"));
        assert!(!file.updated_at.is_empty());
    }

    #[test]
    fn snapshot_marks_stopped_capture() {
        let file = snapshot(&BootstrapStatus {
            running: false,
            ..BootstrapStatus::default()
        });
        assert!(file.app_running);
        assert!(!file.capturing);
    }
}
