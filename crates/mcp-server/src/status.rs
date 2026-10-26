use std::path::Path;

use chrono::{DateTime, Utc};
use serde::Deserialize;

pub const STATUS_FILE_NAME: &str = "agent-status.json";
const STALE_AFTER_SECONDS: i64 = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureStatus {
    pub status: &'static str,
    pub updated_at: Option<String>,
    pub app_running: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusFile {
    #[serde(default)]
    app_running: bool,
    #[serde(default)]
    capturing: bool,
    updated_at: Option<String>,
}

/// Read the desktop heartbeat written to the data directory. A missing,
/// unreadable, or stale file is `unknown`; a fresh file with `app_running` and
/// `capturing` false is `stopped`. The MCP server never guesses live capture.
pub fn read_capture_status(data_dir: &Path) -> CaptureStatus {
    let path = data_dir.join(STATUS_FILE_NAME);
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return CaptureStatus {
            status: "unknown",
            updated_at: None,
            app_running: false,
        };
    };
    let Ok(file) = serde_json::from_str::<StatusFile>(&contents) else {
        return CaptureStatus {
            status: "unknown",
            updated_at: None,
            app_running: false,
        };
    };
    let updated_at = file.updated_at.clone();
    if !is_fresh(file.updated_at.as_deref()) {
        return CaptureStatus {
            status: "unknown",
            updated_at,
            app_running: false,
        };
    }
    let status = if file.app_running && file.capturing {
        "running"
    } else {
        "stopped"
    };
    CaptureStatus {
        status,
        updated_at,
        app_running: file.app_running,
    }
}

fn is_fresh(updated_at: Option<&str>) -> bool {
    let Some(updated_at) = updated_at else {
        return false;
    };
    let Ok(timestamp) = DateTime::parse_from_rfc3339(updated_at) else {
        return false;
    };
    let age = Utc::now().signed_duration_since(timestamp.with_timezone(&Utc));
    age.num_seconds() <= STALE_AFTER_SECONDS
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn write_status(dir: &Path, app_running: bool, capturing: bool, updated_at: String) {
        let payload = serde_json::json!({
            "appRunning": app_running,
            "capturing": capturing,
            "proxyPort": 8888,
            "updatedAt": updated_at,
        });
        std::fs::write(dir.join(STATUS_FILE_NAME), payload.to_string()).unwrap();
    }

    #[test]
    fn missing_status_file_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_capture_status(dir.path()).status, "unknown");
    }

    #[test]
    fn fresh_running_and_stopped_files_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        write_status(dir.path(), true, true, Utc::now().to_rfc3339());
        let status = read_capture_status(dir.path());
        assert_eq!(status.status, "running");
        assert!(status.updated_at.is_some());

        write_status(dir.path(), true, false, Utc::now().to_rfc3339());
        assert_eq!(read_capture_status(dir.path()).status, "stopped");

        write_status(dir.path(), false, true, Utc::now().to_rfc3339());
        assert_eq!(read_capture_status(dir.path()).status, "stopped");
    }

    #[test]
    fn stale_status_file_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let old = (Utc::now() - Duration::seconds(600)).to_rfc3339();
        write_status(dir.path(), true, true, old);
        assert_eq!(read_capture_status(dir.path()).status, "unknown");
    }
}
