use std::fs;
use std::path::{Component, Path, PathBuf};

/// Manages session body files on disk.
#[derive(Debug)]
pub struct BodyStore {
    base_dir: PathBuf,
}

impl BodyStore {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Ensure the bodies directory exists.
    pub fn ensure_dir(&self) -> Result<(), String> {
        fs::create_dir_all(&self.base_dir)
            .map_err(|e| format!("failed to create bodies directory: {e}"))?;
        Ok(())
    }

    /// Write a body file for a session. Returns the relative file path.
    pub fn write_body(
        &self,
        session_id: &str,
        kind: &str,
        data: &[u8],
    ) -> Result<String, String> {
        validate_safe_segment(session_id, "session id")?;
        validate_safe_segment(kind, "body kind")?;

        let dir = self.base_dir.join(session_id);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create body directory: {e}"))?;

        let file_path = dir.join(format!("{kind}.body"));
        fs::write(&file_path, data)
            .map_err(|e| format!("failed to write body file: {e}"))?;

        Ok(format!("{session_id}/{kind}.body"))
    }

    /// Read a body file given its relative path.
    pub fn read_body(&self, relative_path: &str) -> Result<Vec<u8>, String> {
        let full_path = self.checked_resolve_body_path(relative_path)?;
        fs::read(&full_path)
            .map_err(|e| format!("failed to read body file {}: {e}", full_path.display()))
    }

    /// Remove all body files for a session.
    pub fn remove_bodies(&self, session_id: &str) -> Result<(), String> {
        validate_safe_segment(session_id, "session id")?;
        let dir = self.base_dir.join(session_id);
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("failed to remove body directory: {e}"))?;
        }
        Ok(())
    }

    /// Remove all body files.
    pub fn clear_all(&self) -> Result<(), String> {
        if self.base_dir.exists() {
            fs::remove_dir_all(&self.base_dir)
                .map_err(|e| format!("failed to clear bodies directory: {e}"))?;
        }
        fs::create_dir_all(&self.base_dir)
            .map_err(|e| format!("failed to recreate bodies directory: {e}"))?;
        Ok(())
    }

    /// Check whether a relative body path points to an existing file.
    pub fn exists(&self, relative_path: &str) -> bool {
        self.checked_resolve_body_path(relative_path)
            .map(|path| path.exists())
            .unwrap_or(false)
    }

    /// Resolve a stored relative body path into an absolute path under the store directory.
    pub fn resolve_body_path(&self, relative_path: &str) -> PathBuf {
        self.checked_resolve_body_path(relative_path)
            .unwrap_or_else(|_| self.base_dir.join("__invalid_body_path__"))
    }

    /// Convert an absolute body path back into the relative path persisted in SQLite.
    pub fn relative_body_path(&self, full_path: &Path) -> Option<String> {
        let base_dir = self.base_dir.canonicalize().ok()?;
        let full_path = full_path.canonicalize().ok()?;

        full_path
            .strip_prefix(base_dir)
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn checked_resolve_body_path(&self, relative_path: &str) -> Result<PathBuf, String> {
        let path = Path::new(relative_path);
        if path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(format!("invalid body path: {relative_path}"));
        }

        Ok(self.base_dir.join(path))
    }
}

fn validate_safe_segment(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value.bytes().any(|byte| byte.is_ascii_alphanumeric())
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("invalid {label}: {value}"));
    }

    Ok(())
}

/// Minimum body size (bytes) to store on disk instead of inline in the DB.
pub const BODY_FILE_THRESHOLD: usize = 256 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_and_read_body() {
        let dir = std::env::temp_dir().join("aiproxy_body_test_wr");
        let _ = fs::remove_dir_all(&dir);
        let store = BodyStore::new(dir.clone());
        store.ensure_dir().unwrap();

        let path = store.write_body("sess-1", "request", b"hello").unwrap();
        assert_eq!(path, "sess-1/request.body");

        let data = store.read_body(&path).unwrap();
        assert_eq!(data, b"hello");
    }

    #[test]
    fn remove_bodies_for_session() {
        let dir = std::env::temp_dir().join("aiproxy_body_test_rm");
        let _ = fs::remove_dir_all(&dir);
        let store = BodyStore::new(dir.clone());
        store.ensure_dir().unwrap();

        store.write_body("sess-1", "request", b"a").unwrap();
        store.write_body("sess-2", "request", b"b").unwrap();

        store.remove_bodies("sess-1").unwrap();

        assert!(!dir.join("sess-1").exists());
        assert!(dir.join("sess-2/request.body").exists());
    }

    #[test]
    fn rejects_paths_that_escape_base_dir() {
        let dir = std::env::temp_dir().join("aiproxy_body_test_traversal");
        let store = BodyStore::new(dir);

        assert!(store.read_body("../../etc/passwd").is_err());
        assert!(!store.exists("../../etc/passwd"));
        assert!(store.write_body("../bad", "request", b"x").is_err());
        assert!(store.write_body("..", "request", b"x").is_err());
    }
}
