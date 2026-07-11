use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lru::LruCache;

use crate::generator::{self, RootCaPair};
use crate::TlsManagerError;

/// H8: upper bound on the inflight single-flight slot table. A stream of
/// unique cold SNI hostnames would otherwise grow this map for the process
/// lifetime (the actual leaf certs live in the bounded `host_cache` LRU, but
/// the inflight slots were never removed). We prune entries whose host is
/// already cached — those are redundant because future resolvers hit the
/// cache fast path — once the table crosses this threshold.
const MAX_INFLIGHT_SLOTS: usize = 1024;

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
    pub(crate) host_cache: Arc<Mutex<LruCache<String, Arc<rustls::sign::CertifiedKey>>>>,
    /// H8: per-host "single-flight" slots that dedupe concurrent leaf signing.
    /// When N concurrent TLS handshakes arrive for the same cold hostname, the
    /// first signer holds the per-host mutex and signs; the rest block on it
    /// and then pick up the freshly-cached cert from `host_cache`. The outer
    /// HashMap mutex is held only long enough to clone/insert the per-host
    /// `Arc<Mutex<()>>` — never across the signing crypto — so unrelated hosts
    /// and the `host_cache` are not serialized behind a signing handshake.
    pub(crate) inflight: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl std::clone::Clone for CertStorage {
    fn clone(&self) -> Self {
        Self {
            cert_dir: self.cert_dir.clone(),
            root_cert_install_path: self.root_cert_install_path.clone(),
            root_cert_path: self.root_cert_path.clone(),
            root_key_path: self.root_key_path.clone(),
            host_cache: Arc::clone(&self.host_cache),
            inflight: Arc::clone(&self.inflight),
        }
    }
}

impl CertStorage {
    /// Resolve the default cert directory from the OS data dir.
    pub fn resolve() -> Result<Self, TlsManagerError> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| TlsManagerError::StorageError("cannot resolve app data dir".into()))?;
        let cert_dir = data_dir.join(CERT_DIR_NAME).join(CERT_SUBDIR);
        Ok(Self {
            root_cert_install_path: cert_dir.join(ROOT_CERT_INSTALL_FILE),
            root_cert_path: cert_dir.join(ROOT_CERT_FILE),
            root_key_path: cert_dir.join(ROOT_KEY_FILE),
            cert_dir,
            host_cache: Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(512).unwrap()))),
            inflight: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Create a CertStorage backed by a unique temporary directory (for testing).
    pub fn new_in_temp_dir() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let temp_dir = std::env::temp_dir()
            .join("aiproxy-test-certs")
            .join(format!("session-{pid}-{nanos}-{id}"));
        Self {
            root_cert_install_path: temp_dir.join(ROOT_CERT_INSTALL_FILE),
            root_cert_path: temp_dir.join(ROOT_CERT_FILE),
            root_key_path: temp_dir.join(ROOT_KEY_FILE),
            cert_dir: temp_dir,
            host_cache: Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(512).unwrap()))),
            inflight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Whether a usable root cert + key pair exists on disk.
    ///
    /// M14: this checks not just file existence but that both files are non-empty
    /// and contain valid PEM fences (`BEGIN CERTIFICATE` / `PRIVATE KEY`). A torn
    /// write (pre-M13 atomic writes) or external corruption could leave a file
    /// that "exists" but is unparseable; treating that as "absent" lets the
    /// bootstrap cleanly regenerate instead of erroring out on `load_from_pem`.
    /// A full `load_from_pem` is avoided here because it re-signs in memory (L7)
    /// and is heavier than wanted for a bootstrap gate.
    pub fn root_cert_exists(&self) -> bool {
        let cert = std::fs::read_to_string(&self.root_cert_path).ok();
        let key = std::fs::read_to_string(&self.root_key_path).ok();
        matches!(cert.as_deref(), Some(s) if !s.is_empty() && s.contains("BEGIN CERTIFICATE"))
            && matches!(key.as_deref(), Some(s) if !s.is_empty() && s.contains("PRIVATE KEY"))
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
        tracing::debug!(
            event = "root_cert_load_started",
            path = %self.root_cert_path.to_string_lossy(),
            "root_cert_load_started"
        );
        std::fs::read_to_string(&self.root_cert_path).map_err(|e| {
            tracing::warn!(
                event = "root_cert_load_failed",
                path = %self.root_cert_path.to_string_lossy(),
                error = %e,
                "root_cert_load_failed"
            );
            TlsManagerError::StorageError(format!("failed to read root cert: {e}"))
        })
    }

    /// Read the root key PEM from disk.
    pub fn load_root_key_pem(&self) -> Result<String, TlsManagerError> {
        tracing::debug!(
            event = "root_key_load_started",
            path = %self.root_key_path.to_string_lossy(),
            "root_key_load_started"
        );
        std::fs::read_to_string(&self.root_key_path).map_err(|e| {
            tracing::warn!(
                event = "root_key_load_failed",
                path = %self.root_key_path.to_string_lossy(),
                error = %e,
                "root_key_load_failed"
            );
            TlsManagerError::StorageError(format!("failed to read root key: {e}"))
        })
    }

    /// Save root certificate and key PEM files to disk.
    pub fn save_root_cert(&self, cert_pem: &str, key_pem: &str) -> Result<(), TlsManagerError> {
        tracing::info!(
            event = "root_cert_save_started",
            path = %self.root_cert_path.to_string_lossy(),
            "root_cert_save_started"
        );

        // Create cert dir with 0700 on unix to keep the private key private.
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder.create(&self.cert_dir).map_err(|e| {
                TlsManagerError::StorageError(format!("failed to create cert dir: {e}"))
            })?;
        }
        #[cfg(not(unix))]
        {
            std::fs::create_dir_all(&self.cert_dir).map_err(|e| {
                TlsManagerError::StorageError(format!("failed to create cert dir: {e}"))
            })?;
        }

        // M13: write all three files atomically (temp + rename) so a crash or
        // power loss mid-save never leaves a truncated/partial cert or key.
        // Write the key first, then the certs, so "root_cert_exists ⇒ key is
        // valid" holds as closely as possible. The key is written as a secret
        // (0600 on unix, H2); the cert files use default permissions.
        write_file_atomic(&self.root_key_path, key_pem, true)?;
        write_file_atomic(&self.root_cert_path, cert_pem, false)?;
        write_file_atomic(&self.root_cert_install_path, cert_pem, false)?;

        // Restrict the private key (0600) and cert dir (0700) to the current
        // user. `ensure_secure_permissions` is unconditional, so it also
        // tightens a pre-existing cert dir that `DirBuilder::create` leaves
        // untouched.
        self.ensure_secure_permissions()?;

        tracing::info!(
            event = "root_cert_save_succeeded",
            "root_cert_save_succeeded"
        );
        Ok(())
    }

    /// Idempotently tighten permissions on the root key file and cert dir to
    /// the current security baseline (key 0600, dir 0700 on unix).
    ///
    /// Called both after `save_root_cert` (new/refreshed certs) and on load
    /// (`try_load_tls_manager`) to migrate pre-existing installs whose key was
    /// written with looser permissions before this baseline existed. Because
    /// it is unconditional, it also fixes a cert dir that already existed with
    /// wider perms (`DirBuilder::create` only sets mode on newly-created dirs).
    ///
    /// On non-unix platforms this is a no-op: Windows relies on the inherited
    /// ACL of the per-user app-data dir. A future hardening pass may set an
    /// explicit owner-only ACL here.
    pub fn ensure_secure_permissions(&self) -> Result<(), TlsManagerError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.root_key_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| {
                TlsManagerError::StorageError(format!("failed to restrict root key perms: {e}"))
            })?;
            std::fs::set_permissions(&self.cert_dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| {
                    TlsManagerError::StorageError(format!("failed to restrict cert dir perms: {e}"))
                })?;
        }
        #[cfg(not(unix))]
        {
            // No-op on non-unix; see method doc.
            let _ = (&self.root_key_path, &self.cert_dir);
        }
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
        let mut cache = self.host_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = cache.get(hostname) {
            return Ok(Arc::clone(cached));
        }

        let (cert_der, key_der) = generator::sign_host_certificate(root_ca, hostname)?;

        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key_der)
            .map_err(|e| TlsManagerError::GenerationFailed(format!("host signing key: {e}")))?;

        let certified_key = Arc::new(rustls::sign::CertifiedKey::new(vec![cert_der], signing_key));

        cache.put(hostname.to_string(), Arc::clone(&certified_key));

        Ok(certified_key)
    }

    /// Clear the in-memory host certificate cache.
    pub fn clear_host_cache(&self) {
        // Lock order: inflight BEFORE host_cache. This MUST match
        // prune_inflight_to_threshold's order (inflight → host_cache) — an
        // inverted order here would deadlock if a CA rotation races a resolver
        // prune. We clear the inflight table first, then the cache, releasing
        // the inflight guard before taking the cache lock.
        {
            let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
            inflight.clear();
        }
        let mut cache = self.host_cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.clear();
    }

    /// H8: cap the inflight single-flight table. Once it exceeds
    /// [`MAX_INFLIGHT_SLOTS`], drop entries whose host is already present in
    /// the cert cache — those slots are redundant (future resolvers hit the
    /// cache fast path). We never remove a slot for a host that is NOT yet
    /// cached, so any in-progress waiter keeps its slot. Called by the
    /// resolver after it inserts the freshly-signed cert, which is the natural
    /// point at which slots become redundant.
    pub(crate) fn prune_inflight_if_needed(&self) {
        self.prune_inflight_to_threshold(MAX_INFLIGHT_SLOTS);
    }

    /// H8: shared prune implementation taking an explicit threshold so the
    /// bound is testable without inserting MAX_INFLIGHT_SLOTS entries. Removes
    /// only slots whose host is already cached; keeps slots for cold hosts so
    /// in-progress waiters are not orphaned.
    pub(crate) fn prune_inflight_to_threshold(&self, threshold: usize) {
        let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if inflight.len() <= threshold {
            return;
        }
        // Determine which hosts are already cached without disturbing LRU
        // ordering (peek does not refresh). Hold the cache lock only for this
        // read; the prune below happens under the inflight lock we already hold.
        let cached_hosts: std::collections::HashSet<String> = {
            let cache = self.host_cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.iter().map(|(k, _)| k.clone()).collect()
        };
        inflight.retain(|host, _| !cached_hosts.contains(host));
    }
}

/// Write a file atomically via temp-file + rename, so a crash mid-write never
/// leaves a truncated/partial file (M13). When `secret` is true the temp file
/// is created with mode 0600 on unix (H2), eliminating the umask exposure
/// window. The temp file is created in the same directory as `path` so the
/// rename is atomic on the same filesystem (POSIX `rename`, Windows
/// `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`).
fn write_file_atomic(path: &Path, contents: &str, secret: bool) -> Result<(), TlsManagerError> {
    let dir = path.parent().ok_or_else(|| {
        TlsManagerError::StorageError("destination path has no parent directory".to_string())
    })?;
    let pid = std::process::id();
    let tmp = dir.join(format!(
        ".{}-{}-{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("aiproxy"),
        pid,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));

    // Write the temp file with the appropriate permissions.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        if secret {
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to create temp file: {e}"))
        })?;
        file.write_all(contents.as_bytes()).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to write temp file: {e}"))
        })?;
        file.sync_all()
            .map_err(|e| TlsManagerError::StorageError(format!("failed to sync temp file: {e}")))?;
    }
    #[cfg(not(unix))]
    {
        let _ = secret; // non-unix relies on inherited ACLs
        std::fs::write(&tmp, contents).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to write temp file: {e}"))
        })?;
    }

    // Rename is atomic on the same filesystem.
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Clean up the temp file on rename failure.
        let _ = std::fs::remove_file(&tmp);
        return Err(TlsManagerError::StorageError(format!(
            "failed to rename temp file into place: {e}"
        )));
    }
    Ok(())
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

    // M14: root_cert_exists must return false for empty/corrupt files, not just
    // missing files. A torn write (pre-M13) or external corruption could leave a
    // file that "exists" but is unparseable; bootstrap should regenerate.
    #[test]
    fn m14_root_cert_exists_false_for_empty_files() {
        let storage = CertStorage::new_in_temp_dir();
        std::fs::create_dir_all(storage.cert_dir()).unwrap();
        std::fs::write(storage.root_cert_path(), "").unwrap();
        std::fs::write(storage.root_key_path(), "").unwrap();
        assert!(
            !storage.root_cert_exists(),
            "empty files must not count as a valid cert pair"
        );
    }

    // M14: files without valid PEM fences must not count as existing.
    #[test]
    fn m14_root_cert_exists_false_for_missing_pem_fence() {
        let storage = CertStorage::new_in_temp_dir();
        std::fs::create_dir_all(storage.cert_dir()).unwrap();
        std::fs::write(storage.root_cert_path(), "not a cert").unwrap();
        std::fs::write(storage.root_key_path(), "not a key").unwrap();
        assert!(
            !storage.root_cert_exists(),
            "files without PEM fences must not count as a valid cert pair"
        );
    }

    // M14: a valid pair (after save_root_cert) must report true. This overlaps
    // with saves_and_loads_root_cert but explicitly pins the M14 contract.
    #[test]
    fn m14_root_cert_exists_true_for_valid_pair() {
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        assert!(storage.root_cert_exists());
    }

    // M13: save_root_cert must write atomically — after a successful save, no
    // stray temp files should remain in the cert dir.
    #[test]
    fn m13_save_root_cert_leaves_no_temp_files() {
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(storage.cert_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temp files should remain after atomic save, found {:?}",
            leftovers.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );
    }

    // H2: the private key must be created with owner-only permissions from the
    // outset, not left world-readable until a later chmod. This test verifies
    // the key file mode immediately after save_root_cert, with no intervening
    // chmod step.
    #[cfg(unix)]
    #[test]
    fn h2_root_key_created_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        let mode = std::fs::metadata(storage.root_key_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "root key must be 0600 immediately after save (got {mode:#o})"
        );
    }

    // H2: write_file_atomic with secret=true creates 0600 files on unix.
    #[cfg(unix)]
    #[test]
    fn h2_write_secret_file_creates_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("aiproxy-h2-secret-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test-key.pem");
        write_file_atomic(&path, "secret contents", true).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "write_file_atomic(secret=true) must create 0600"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cloned_storage_shares_host_cache() {
        let storage = CertStorage::new_in_temp_dir();
        let cloned = storage.clone();
        let root_ca = RootCaPair::generate().unwrap();

        let original_key = storage
            .get_or_create_host_certified_key(&root_ca, "example.com")
            .unwrap();
        let cloned_key = cloned
            .get_or_create_host_certified_key(&root_ca, "example.com")
            .unwrap();

        assert!(Arc::ptr_eq(&original_key, &cloned_key));
    }

    // M8: clearing the host cache must flush ALL clones sharing the underlying
    // Arc<Mutex<host_cache>>. After a root-CA rotation, an in-flight resolver
    // holding an old CertStorage clone would otherwise keep serving leaf certs
    // signed by the OLD root; flushing before installing the new manager forces
    // re-signing with the new root.
    #[test]
    fn clear_host_cache_flushes_all_clones() {
        let storage = CertStorage::new_in_temp_dir();
        let cloned = storage.clone();
        let root_ca = RootCaPair::generate().unwrap();

        // Populate the shared cache via the clone.
        let _ = cloned
            .get_or_create_host_certified_key(&root_ca, "example.com")
            .unwrap();
        {
            let cache = storage.host_cache.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(cache.len(), 1, "cache should hold the populated entry");
        }

        // Clearing via the original must empty the clone's view too.
        storage.clear_host_cache();
        {
            let cache = cloned.host_cache.lock().unwrap_or_else(|e| e.into_inner());
            assert!(
                cache.is_empty(),
                "clear_host_cache must flush shared clones"
            );
        }
    }

    // H8: the per-host single-flight mechanism must (a) hand back the SAME
    // slot Arc for the same hostname across concurrent callers (so they
    // serialize on one sign instead of racing), (b) hand back DIFFERENT slots
    // for different hostnames (so unrelated hosts don't serialize), and
    // (c) be flushed by clear_host_cache so a CA rotation forces fresh signs.
    #[test]
    fn inflight_slot_is_shared_per_host() {
        let storage = CertStorage::new_in_temp_dir();

        // Same host requested twice (concurrently, simulating two handshakes):
        // must return the same slot Arc.
        let slot_a = {
            let mut inflight = storage.inflight.lock().unwrap();
            Arc::clone(
                inflight
                    .entry("a.example.com".to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let slot_a2 = {
            let mut inflight = storage.inflight.lock().unwrap();
            Arc::clone(
                inflight
                    .entry("a.example.com".to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        assert!(
            Arc::ptr_eq(&slot_a, &slot_a2),
            "same-host requests must share one single-flight slot"
        );

        // A different host must get a distinct slot.
        let slot_b = {
            let mut inflight = storage.inflight.lock().unwrap();
            Arc::clone(
                inflight
                    .entry("b.example.com".to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        assert!(
            !Arc::ptr_eq(&slot_a, &slot_b),
            "different hosts must NOT share a single-flight slot"
        );
    }

    // H8: clear_host_cache must also flush the inflight table, so a CA rotation
    // doesn't let a pending single-flight waiter reuse a slot started against
    // the old CA.
    #[test]
    fn clear_host_cache_flushes_inflight_table() {
        let storage = CertStorage::new_in_temp_dir();
        {
            let mut inflight = storage.inflight.lock().unwrap();
            inflight.insert("a.example.com".to_string(), Arc::new(Mutex::new(())));
            inflight.insert("b.example.com".to_string(), Arc::new(Mutex::new(())));
        }
        assert_eq!(
            storage.inflight.lock().unwrap().len(),
            2,
            "precondition: two inflight slots"
        );

        storage.clear_host_cache();

        assert!(
            storage.inflight.lock().unwrap().is_empty(),
            "clear_host_cache must flush the inflight single-flight table"
        );
    }

    // H8: prune_inflight_to_threshold must (a) drop slots whose host is already
    // cached (redundant — future resolvers hit the cache), (b) KEEP slots for
    // hosts NOT yet cached (so an in-progress waiter keeps its slot), and
    // (c) be a no-op when under the threshold. This is the bound that prevents
    // a stream of unique cold SNI hostnames from growing the inflight table
    // unboundedly for the process lifetime.
    #[test]
    fn prune_inflight_drops_cached_hosts_keeps_cold_hosts() {
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();

        // Cache two hosts (so they'd be redundant inflight slots).
        let _ = storage
            .get_or_create_host_certified_key(&root_ca, "cached-a.example.com")
            .unwrap();
        let _ = storage
            .get_or_create_host_certified_key(&root_ca, "cached-b.example.com")
            .unwrap();

        // Seed the inflight table with 3 slots: 2 cached hosts + 1 cold host.
        {
            let mut inflight = storage.inflight.lock().unwrap();
            inflight.insert("cached-a.example.com".into(), Arc::new(Mutex::new(())));
            inflight.insert("cached-b.example.com".into(), Arc::new(Mutex::new(())));
            inflight.insert("cold.example.com".into(), Arc::new(Mutex::new(())));
        }

        // Threshold 1: only triggers because len(3) > 1. Must drop the two
        // cached hosts but keep the cold one.
        storage.prune_inflight_to_threshold(1);
        {
            let inflight = storage.inflight.lock().unwrap();
            assert_eq!(
                inflight.len(),
                1,
                "prune must drop cached-host slots, keep cold-host slots"
            );
            assert!(
                inflight.contains_key("cold.example.com"),
                "cold-host slot must survive prune so its waiter keeps it"
            );
            assert!(
                !inflight.contains_key("cached-a.example.com")
                    && !inflight.contains_key("cached-b.example.com"),
                "cached-host slots must be pruned (redundant vs the cache fast path)"
            );
        }

        // Below the threshold: no-op (does not raise an error or panic).
        storage.prune_inflight_to_threshold(10);
        assert_eq!(
            storage.inflight.lock().unwrap().len(),
            1,
            "prune below threshold must be a no-op"
        );
    }

    // Regression: clear_host_cache (CA rotation) and prune_inflight_to_threshold
    // (resolver post-sign) acquire host_cache + inflight in the SAME order
    // (inflight → host_cache). An inverted order would deadlock under
    // contention. This test hammers both paths concurrently under a deadline;
    // if it deadlocks the test times out rather than completing.
    #[test]
    fn clear_host_cache_and_prune_do_not_deadlock() {
        use std::sync::Arc;
        use std::thread;
        let storage = Arc::new(CertStorage::new_in_temp_dir());
        let root_ca = RootCaPair::generate().unwrap();
        // Pre-populate so prune has something to consider.
        for i in 0..8 {
            let host = format!("host{i}.example.com");
            let _ = storage.get_or_create_host_certified_key(&root_ca, &host);
            storage
                .inflight
                .lock()
                .unwrap()
                .insert(host, Arc::new(Mutex::new(())));
        }

        let s1 = Arc::clone(&storage);
        let s2 = Arc::clone(&storage);
        let h1 = thread::spawn(move || {
            for _ in 0..200 {
                s1.clear_host_cache();
            }
        });
        let h2 = thread::spawn(move || {
            for _ in 0..200 {
                // threshold 0 forces the prune branch every call.
                s2.prune_inflight_to_threshold(0);
            }
        });
        // join would block forever on a real deadlock; the test harness
        // timeout surfaces that as a failure.
        h1.join().expect("clear thread must not deadlock");
        h2.join().expect("prune thread must not deadlock");
    }

    #[test]
    fn lru_cache_evicts_oldest_entries() {
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();

        // Fill cache beyond capacity (512)
        for i in 0..513 {
            let hostname = format!("host{}.example.com", i);
            let _ = storage.get_or_create_host_certified_key(&root_ca, &hostname);
        }

        let mut cache = storage.host_cache.lock().unwrap_or_else(|e| e.into_inner());
        assert!(cache.len() <= 512);
        // The first entry should have been evicted
        assert!(cache.get(&"host0.example.com".to_string()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn root_key_file_has_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        let mode = std::fs::metadata(storage.root_key_path())
            .expect("root key file exists")
            .permissions()
            .mode();
        // Group and other must have no permissions on the private key.
        assert_eq!(
            mode & 0o077,
            0,
            "root key must not be accessible by group/other (mode={mode:o})"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cert_dir_created_with_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        let dir_mode = std::fs::metadata(storage.cert_dir())
            .expect("cert dir exists")
            .permissions()
            .mode();
        assert_eq!(
            dir_mode & 0o077,
            0,
            "cert dir must not be accessible by group/other (mode={dir_mode:o})"
        );
    }

    #[cfg(unix)]
    #[test]
    fn existing_loose_cert_dir_tightened_on_save() {
        use std::os::unix::fs::PermissionsExt;
        let storage = CertStorage::new_in_temp_dir();
        // Pre-create the cert dir with loose perms, mirroring an install made
        // before the 0700 baseline (DirBuilder::create won't tighten it).
        std::fs::create_dir_all(storage.cert_dir()).unwrap();
        std::fs::set_permissions(storage.cert_dir(), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        let dir_mode = std::fs::metadata(storage.cert_dir())
            .expect("cert dir exists")
            .permissions()
            .mode();
        assert_eq!(
            dir_mode & 0o077,
            0,
            "pre-existing loose cert dir must be tightened to 0o700 on save (mode={dir_mode:o})"
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_root_key_permissions_tightened_on_load() {
        use std::os::unix::fs::PermissionsExt;
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        // Simulate a legacy install: write the key with loose 0644 perms.
        std::fs::create_dir_all(storage.cert_dir()).unwrap();
        std::fs::write(storage.root_cert_path(), root_ca.cert_pem()).unwrap();
        std::fs::write(storage.root_key_path(), root_ca.key_pem()).unwrap();
        std::fs::set_permissions(
            storage.root_key_path(),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        // Sanity: the legacy perms are loose before migration.
        let before = std::fs::metadata(storage.root_key_path())
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(before & 0o077, 0, "precondition: legacy key is loose");

        storage.ensure_secure_permissions().unwrap();

        let after = std::fs::metadata(storage.root_key_path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            after & 0o077,
            0,
            "legacy root key must be tightened to 0o600 on load (mode={after:o})"
        );
    }
}
