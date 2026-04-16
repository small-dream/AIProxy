use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::generator::{self, RootCaPair};
use crate::TlsManagerError;

const CERT_DIR_NAME: &str = "aiproxy";
const CERT_SUBDIR: &str = "certs";
const ROOT_CERT_FILE: &str = "aiproxy-root-ca.pem";
const ROOT_CERT_INSTALL_FILE: &str = "aiproxy-root-ca.cer";
const ROOT_KEY_FILE: &str = "aiproxy-root-ca-key.pem";

/// Manages on-disk root CA storage and in-memory host certificate cache.
pub struct CertStorage {
    cert_dir: PathBuf,
    root_cert_install_path: PathBuf,
    root_cert_path: PathBuf,
    root_key_path: PathBuf,
    /// In-memory cache: hostname → CertifiedKey (for dynamic host certs)
    pub(crate) host_cache: Mutex<HashMap<String, Arc<rustls::sign::CertifiedKey>>>,
}

impl std::clone::Clone for CertStorage {
    fn clone(&self) -> Self {
        Self {
            cert_dir: self.cert_dir.clone(),
            root_cert_install_path: self.root_cert_install_path.clone(),
            root_cert_path: self.root_cert_path.clone(),
            root_key_path: self.root_key_path.clone(),
            host_cache: Mutex::new(HashMap::new()), // fresh cache for clone
        }
    }
}

impl CertStorage {
    /// Resolve the default cert directory from the OS data dir.
    pub fn resolve() -> Result<Self, TlsManagerError> {
        let data_dir = dirs::data_dir().ok_or_else(|| {
            TlsManagerError::StorageError("cannot resolve app data dir".into())
        })?;
        let cert_dir = data_dir.join(CERT_DIR_NAME).join(CERT_SUBDIR);
        Ok(Self {
            root_cert_install_path: cert_dir.join(ROOT_CERT_INSTALL_FILE),
            root_cert_path: cert_dir.join(ROOT_CERT_FILE),
            root_key_path: cert_dir.join(ROOT_KEY_FILE),
            cert_dir,
            host_cache: Mutex::new(HashMap::new()),
        })
    }

    /// Create a CertStorage backed by a unique temporary directory (for testing).
    pub fn new_in_temp_dir() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_dir = std::env::temp_dir()
            .join("aiproxy-test-certs")
            .join(format!("session-{id}"));
        Self {
            root_cert_install_path: temp_dir.join(ROOT_CERT_INSTALL_FILE),
            root_cert_path: temp_dir.join(ROOT_CERT_FILE),
            root_key_path: temp_dir.join(ROOT_KEY_FILE),
            cert_dir: temp_dir,
            host_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn root_cert_exists(&self) -> bool {
        self.root_cert_path.exists() && self.root_key_path.exists()
    }

    pub fn root_cert_path(&self) -> &Path {
        &self.root_cert_path
    }

    pub fn root_cert_install_path(&self) -> &Path {
        &self.root_cert_install_path
    }

    pub fn root_key_path(&self) -> &Path {
        &self.root_key_path
    }

    pub fn cert_dir(&self) -> &Path {
        &self.cert_dir
    }

    /// Read the root certificate PEM from disk.
    pub fn load_root_cert_pem(&self) -> Result<String, TlsManagerError> {
        std::fs::read_to_string(&self.root_cert_path)
            .map_err(|e| TlsManagerError::StorageError(format!("failed to read root cert: {e}")))
    }

    /// Read the root key PEM from disk.
    pub fn load_root_key_pem(&self) -> Result<String, TlsManagerError> {
        std::fs::read_to_string(&self.root_key_path)
            .map_err(|e| TlsManagerError::StorageError(format!("failed to read root key: {e}")))
    }

    /// Save root certificate and key PEM files to disk.
    pub fn save_root_cert(
        &self,
        cert_pem: &str,
        key_pem: &str,
    ) -> Result<(), TlsManagerError> {
        std::fs::create_dir_all(&self.cert_dir).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to create cert dir: {e}"))
        })?;

        std::fs::write(&self.root_cert_path, cert_pem).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to write root cert: {e}"))
        })?;

        std::fs::write(&self.root_cert_install_path, cert_pem).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to write installable root cert: {e}"))
        })?;

        std::fs::write(&self.root_key_path, key_pem).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to write root key: {e}"))
        })?;

        Ok(())
    }

    pub fn ensure_root_cert_install_copy(&self) -> Result<(), TlsManagerError> {
        if self.root_cert_install_path.exists() {
            return Ok(());
        }

        let cert_pem = self.load_root_cert_pem()?;
        std::fs::write(&self.root_cert_install_path, cert_pem).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to backfill installable root cert: {e}"))
        })
    }

    /// Get a cached host CertifiedKey, or generate and cache a new one.
    pub fn get_or_create_host_certified_key(
        &self,
        root_ca: &RootCaPair,
        hostname: &str,
    ) -> Result<Arc<rustls::sign::CertifiedKey>, TlsManagerError> {
        {
            let cache = self.host_cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(cached) = cache.get(hostname) {
                return Ok(Arc::clone(cached));
            }
        }

        let (cert_der, key_der) = generator::sign_host_certificate(root_ca, hostname)?;

        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key_der)
            .map_err(|e| TlsManagerError::GenerationFailed(format!("host signing key: {e}")))?;

        let certified_key = Arc::new(rustls::sign::CertifiedKey::new(
            vec![cert_der],
            signing_key,
        ));

        {
            let mut cache = self.host_cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.insert(hostname.to_string(), Arc::clone(&certified_key));
        }

        Ok(certified_key)
    }

    /// Clear the in-memory host certificate cache.
    pub fn clear_host_cache(&self) {
        let mut cache = self.host_cache.lock().unwrap();
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_storage_path_under_app_data_dir() {
        let storage = CertStorage::resolve().unwrap();
        let path = storage.cert_dir();
        assert!(path.to_string_lossy().contains("aiproxy"));
        assert!(path.to_string_lossy().contains("certs"));
    }

    #[test]
    fn reports_root_cert_missing_when_no_file_exists() {
        let storage = CertStorage::new_in_temp_dir();
        assert!(!storage.root_cert_exists());
    }

    #[test]
    fn saves_and_loads_root_cert() {
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        assert!(storage.root_cert_exists());

        let loaded_pem = storage.load_root_cert_pem().unwrap();
        assert!(loaded_pem.contains("BEGIN CERTIFICATE"));
    }
}
