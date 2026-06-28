use std::fs;

use crate::DbError;
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
    pub fn ensure_dir(&self) -> Result<(), DbError> {
        fs::create_dir_all(&self.base_dir).map_err(DbError::Io)?;
        Ok(())
    }

    /// Write a body file for a session. Returns the relative file path.
    pub fn write_body(&self, session_id: &str, kind: &str, data: &[u8]) -> Result<String, DbError> {
        validate_safe_segment(session_id, "session id")?;
        validate_safe_segment(kind, "body kind")?;

        let dir = self.base_dir.join(session_id);
        fs::create_dir_all(&dir).map_err(DbError::Io)?;

        let file_path = dir.join(format!("{kind}.body"));
        fs::write(&file_path, data).map_err(DbError::Io)?;

        Ok(format!("{session_id}/{kind}.body"))
    }

    /// Read a body file given its relative path.
    pub fn read_body(&self, relative_path: &str) -> Result<Vec<u8>, DbError> {
        let full_path = self.checked_resolve_body_path(relative_path)?;
        Ok(fs::read(&full_path).map_err(DbError::Io)?)
    }

    /// Remove all body files for a session.
    pub fn remove_bodies(&self, session_id: &str) -> Result<(), DbError> {
        validate_safe_segment(session_id, "session id")?;
        let dir = self.base_dir.join(session_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(DbError::Io)?;
        }
        Ok(())
    }

    /// Remove all body files.
    ///
    /// L11: clears the directory CONTENTS but keeps the directory itself in
    /// place, rather than `remove_dir_all` + `create_dir_all`. The proxy hot
    /// path writes body files concurrently with this clear (driven from the
    /// "clear all sessions" UI command and not serialized by the same lock as
    /// the writes); the old remove-then-recreate left a window in which a
    /// concurrent `write_body` hit a missing parent dir (NotFound). Keeping the
    /// dir present eliminates that window.
    pub fn clear_all(&self) -> Result<(), DbError> {
        let entries = match fs::read_dir(&self.base_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Dir does not exist yet — create it so callers can rely on it.
                fs::create_dir_all(&self.base_dir).map_err(DbError::Io)?;
                return Ok(());
            }
            Err(error) => return Err(DbError::Io(error)),
        };

        for entry in entries {
            let entry = entry.map_err(DbError::Io)?;
            let path = entry.path();
            let result = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            // A concurrent writer may create/remove entries while we iterate;
            // treat a vanished entry (NotFound) as success.
            if let Err(error) = result {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(DbError::Io(error));
                }
            }
        }
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

    fn checked_resolve_body_path(&self, relative_path: &str) -> Result<PathBuf, DbError> {
        // Reject any backslash so resolution behaves identically on every
        // platform. On Windows `Path::components` already treats `\` as a
        // separator (catching `..\` traversal), but on Unix `\` is a normal
        // filename character, so a value like `sess-1\..\..\etc` would
        // otherwise be accepted as a single (odd) filename.
        if relative_path.contains('\\') {
            return Err(DbError::Validation(format!(
                "invalid body path: {relative_path}"
            )));
        }

        let path = Path::new(relative_path);
        if path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(DbError::Validation(format!(
                "invalid body path: {relative_path}"
            )));
        }

        Ok(self.base_dir.join(path))
    }
}

fn validate_safe_segment(value: &str, label: &str) -> Result<(), DbError> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value.bytes().any(|byte| byte.is_ascii_alphanumeric())
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(DbError::Validation(format!("invalid {label}: {value}")));
    }

    Ok(())
}

/// Minimum body size (bytes) to store on disk instead of inline in the DB.
pub const BODY_FILE_THRESHOLD: usize = 256 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // P6-1: Strings containing slash or backslash are always rejected
    proptest! {
        #[test]
        fn slash_or_backslash_rejected(rest in ".*") {
            for ch in &['/', '\\'] {
                let value = format!("{ch}{rest}");
                prop_assert!(validate_safe_segment(&value, "test").is_err(),
                    "expected {:?} to be rejected", value);
            }
        }
    }

    // P6-2: Pure safe strings (must contain at least one alnum char) -> Ok
    proptest! {
        #[test]
        fn safe_alphanumeric_strings_accepted(value in "[a-zA-Z0-9][a-zA-Z0-9_-]*") {
            prop_assert!(validate_safe_segment(&value, "test").is_ok());
        }
    }

    // P6-3: Strings with dots but containing alphanumeric (e.g. "v1.2", "file.txt") -> Ok
    proptest! {
        #[test]
        fn dotted_names_with_alnum_accepted(
            prefix in "[a-zA-Z0-9][a-zA-Z0-9_-]*",
            suffix in "[a-zA-Z0-9][a-zA-Z0-9_-]*"
        ) {
            let value = format!("{prefix}.{suffix}");
            prop_assert!(validate_safe_segment(&value, "test").is_ok());
        }
    }

    // P6-4: Empty, ".", ".." -> Err (fixed-value tests)
    #[test]
    fn empty_string_rejected() {
        assert!(validate_safe_segment("", "test").is_err());
    }

    #[test]
    fn single_dot_rejected() {
        assert!(validate_safe_segment(".", "test").is_err());
    }

    #[test]
    fn double_dot_rejected() {
        assert!(validate_safe_segment("..", "test").is_err());
    }

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

    // L7: a `relative_path` containing a backslash must be rejected on every
    // platform. On Unix `\` is a normal filename char, so `sess-1\..\..\etc`
    // would otherwise be treated as a single (weird) filename rather than
    // flagged — diverging from Windows where `Path::components` splits on `\`.
    #[test]
    fn rejects_backslash_in_body_path() {
        let dir = std::env::temp_dir().join("aiproxy_body_test_backslash");
        let store = BodyStore::new(dir);

        // Pure backslash traversal attempt.
        assert!(store.read_body("sess-1\\..\\..\\etc").is_err());
        // A single filename that merely contains a backslash is also rejected
        // for cross-platform consistency.
        assert!(store.read_body("sess-1\\request.body").is_err());
        assert!(!store.exists("sess-1\\request.body"));
        // `resolve_body_path` must fall back to the invalid sentinel rather
        // than resolving under the base dir.
        let resolved = store.resolve_body_path("sess-1\\..\\..\\etc");
        assert!(
            !resolved.starts_with(&store.base_dir) || resolved == store.base_dir.join("__invalid_body_path__"),
            "backslash path should not resolve under base dir, got {resolved:?}"
        );
    }
}
