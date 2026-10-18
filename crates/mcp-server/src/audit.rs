use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

const AUDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const AUDIT_RETAINED_FILES: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry<'a> {
    pub timestamp: String,
    pub client_name: &'a str,
    pub client_version: &'a str,
    pub tool: &'a str,
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
        let line = serde_json::to_vec(entry).map_err(std::io::Error::other)?;
        file.write_all(&line)?;
        file.write_all(b"\n")?;
        Ok(())
    }
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
            tool: "search_sessions",
            returned_bytes: Some(128),
            ..AuditEntry::default()
        })
        .unwrap();
        let contents = fs::read_to_string(log.path()).unwrap();
        assert!(contents.contains("search_sessions"));
        assert!(!contents.contains("authorization"));
    }
}
