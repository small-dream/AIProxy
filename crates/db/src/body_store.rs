use std::fs;
use std::path::{Path, PathBuf};

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
        let full_path = self.base_dir.join(relative_path);
        fs::read(&full_path)
            .map_err(|e| format!("failed to read body file {}: {e}", full_path.display()))
    }

    /// Remove all body files for a session.
    pub fn remove_bodies(&self, session_id: &str) -> Result<(), String> {
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
        Path::new(&self.base_dir).join(relative_path).exists()
    }
}

/// Minimum body size (bytes) to store on disk instead of inline in the DB.
pub const BODY_FILE_THRESHOLD: usize = 64 * 1024;

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
}
