//! Application bootstrap: state management, proxy lifecycle, and coordination.
//!
//! This module owns the `AppState` struct and the top-level glue that ties
//! together persistence ([repository]), caching ([cache]), data conversion
//! ([converters]), and frontend event emission ([events]).
//!
//! Heavy persistence work (body spill, SQLite writes, trace persistence) lives
//! in [repository]; in-memory session caching and LRU eviction live in [cache].

mod cache;
mod converters;
mod events;
mod repository;

use cache::SessionCache;
use converters::{
    breakpoint_row_to_rule, detail_row_to_proxy, dns_mapping_row_to_rule, map_row_to_rule,
    rewrite_row_to_rule, script_row_to_rule, summary_row_to_proxy, throttle_row_to_profile,
    throttle_row_to_rule, workspace_row_to_data,
};
use events::{
    emit_session_remove, emit_session_upsert, emit_sessions_cleared, emit_sessions_removed,
};
use repository::Repository;

use aiproxy_proxy_core::{
    BreakpointManager, DnsManager, MapManager, ProxyServerHandle, ProxySessionDetail,
    ProxySessionSummary, RewriteManager, ScriptManager, ThrottleManager, TlsManager,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tauri::async_runtime::JoinHandle;

use crate::system_proxy::SystemProxySnapshot;
use crate::workspace::WorkspaceManager;

pub(crate) const SESSION_BATCH_SIZE: usize = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Snapshot of the certificate state for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateStateSnapshot {
    pub cert_path: Option<String>,
    pub fingerprint: Option<String>,
    pub trusted: bool,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
    pub active_workspace_id: Option<String>,
    pub port: u16,
    pub running: bool,
    pub ssl_enabled: bool,
    pub http2_enabled: bool,
    pub system_proxy_enabled: bool,
    pub started_at: Option<String>,
    pub system_proxy_recovery_warning: Option<String>,
}

impl Default for BootstrapStatus {
    fn default() -> Self {
        Self {
            active_workspace_id: Some("default".to_string()),
            port: 8888,
            running: false,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            started_at: None,
            system_proxy_recovery_warning: None,
        }
    }
}

#[derive(Debug)]
pub struct RuntimeHandles {
    pub collector_handle: JoinHandle<()>,
    pub proxy_server_handle: ProxyServerHandle,
}

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct AppState {
    runtime: Mutex<Option<RuntimeHandles>>,
    cache: SessionCache,
    status: Mutex<BootstrapStatus>,
    system_proxy_snapshot: Mutex<Option<SystemProxySnapshot>>,
    // M17: serializes enable/disable/restart of the system proxy so overlapping
    // IPC calls (menu toggle + stop_proxy, double-click, etc.) cannot interleave
    // and desynchronize the captured snapshot from the actually-applied state.
    // Held for the whole operation; the platform calls are blocking either way.
    system_proxy_op_lock: tokio::sync::Mutex<()>,
    tls_manager: Mutex<Option<Arc<TlsManager>>>,
    cert_status_cache: Mutex<Option<CertificateStateSnapshot>>,
    breakpoint_manager: Arc<BreakpointManager>,
    rewrite_manager: Arc<RewriteManager>,
    map_manager: Arc<MapManager>,
    script_manager: Arc<ScriptManager>,
    throttle_manager: Arc<ThrottleManager>,
    dns_manager: Arc<DnsManager>,
    workspace_manager: Arc<WorkspaceManager>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    focused_hosts: Mutex<HashSet<String>>,
    repository: Repository,
}

impl AppState {
    pub fn new(
        db: Arc<Mutex<aiproxy_db::rusqlite::Connection>>,
        body_store: Arc<aiproxy_db::body_store::BodyStore>,
    ) -> Self {
        let state = Self {
            runtime: Mutex::new(None),
            cache: SessionCache::new(),
            status: Mutex::new(BootstrapStatus::default()),
            system_proxy_snapshot: Mutex::new(None),
            system_proxy_op_lock: tokio::sync::Mutex::new(()),
            tls_manager: Mutex::new(None),
            cert_status_cache: Mutex::new(None),
            breakpoint_manager: Arc::new(BreakpointManager::new()),
            rewrite_manager: Arc::new(RewriteManager::new()),
            map_manager: Arc::new(MapManager::new()),
            script_manager: Arc::new(ScriptManager::new()),
            throttle_manager: Arc::new(ThrottleManager::new()),
            dns_manager: Arc::new(DnsManager::new()),
            workspace_manager: Arc::new(WorkspaceManager::new()),
            app_handle: Mutex::new(None),
            focused_hosts: Mutex::new(HashSet::new()),
            repository: Repository::new(db, body_store),
        };

        state.init_from_db();
        state
    }

    // ── initialisation ──────────────────────────────────────────────

    /// Clear all session data from SQLite and BodyStore.
    /// Used at startup and shutdown to ensure no session data persists across restarts.
    pub fn clear_session_storage(&self) {
        self.repository.clear_all_sessions();
    }

    /// Load all persisted data from SQLite into the in-memory managers.
    fn init_from_db(&self) {
        self.clear_session_storage();

        let conn = self
            .repository
            .db()
            .lock()
            .expect("db mutex should not be poisoned");

        if let Ok(rows) = aiproxy_db::workspaces::load_all_workspaces(&conn) {
            if !rows.is_empty() {
                self.workspace_manager
                    .set_workspaces(rows.into_iter().map(workspace_row_to_data).collect());
            }
        }
        if let Ok(rows) = aiproxy_db::rules::load_all_rewrite_rules(&conn) {
            self.rewrite_manager
                .set_rules(rows.into_iter().map(rewrite_row_to_rule).collect());
        }
        if let Ok(rows) = aiproxy_db::rules::load_all_map_rules(&conn) {
            self.map_manager
                .set_rules(rows.into_iter().map(map_row_to_rule).collect());
        }
        if let Ok(rows) = aiproxy_db::rules::load_all_script_rules(&conn) {
            self.script_manager
                .set_rules(rows.into_iter().map(script_row_to_rule).collect());
        }
        if let Ok(rows) = aiproxy_db::rules::load_all_throttle_profiles(&conn) {
            self.throttle_manager
                .set_profiles(rows.into_iter().map(throttle_row_to_profile).collect());
        }
        if let Ok(rows) = aiproxy_db::rules::load_all_throttle_rules(&conn) {
            self.throttle_manager
                .set_rules(rows.into_iter().map(throttle_row_to_rule).collect());
        }
        if let Ok(rows) = aiproxy_db::rules::load_breakpoint_rules(&conn) {
            self.breakpoint_manager
                .set_rules(rows.into_iter().map(breakpoint_row_to_rule).collect());
        }
        if let Ok(rows) = aiproxy_db::rules::load_all_dns_mappings(&conn) {
            self.dns_manager
                .set_rules(rows.into_iter().map(dns_mapping_row_to_rule).collect());
        }
    }

    // ── status ──────────────────────────────────────────────────────

    pub fn read_status(&self) -> BootstrapStatus {
        self.status
            .lock()
            .expect("bootstrap status mutex should not be poisoned")
            .clone()
    }

    pub fn read_sessions(&self) -> Vec<ProxySessionSummary> {
        self.cache.read_summaries()
    }

    // ── session detail ──────────────────────────────────────────────

    pub fn read_session_detail(&self, session_id: &str) -> Option<ProxySessionDetail> {
        // Try in-memory cache first
        if let Some(detail) = self.cache.try_get_detail(session_id) {
            tracing::debug!(
                component = "desktop.sessions",
                event = "session_detail_memory_cache_hit",
                session_id = %session_id,
                "session_detail_memory_cache_hit"
            );
            return Some(detail);
        }
        tracing::debug!(
            component = "desktop.sessions",
            event = "session_detail_memory_cache_miss",
            session_id = %session_id,
            "session_detail_memory_cache_miss"
        );

        // Fallback: load from DB via Repository
        let row = self.repository.load_session_detail_or_log(session_id)?;

        let summary = self.cache.find_summary(session_id).or_else(|| {
            self.repository
                .load_session_summary_or_log(session_id)
                .map(summary_row_to_proxy)
        })?;

        let detail = detail_row_to_proxy(&row, summary, self.repository.body_store().as_ref());

        self.cache
            .insert_detail(session_id.to_string(), detail.clone());
        tracing::debug!(
            component = "desktop.sessions",
            event = "session_detail_db_backfill_succeeded",
            session_id = %session_id,
            "session_detail_db_backfill_succeeded"
        );

        Some(detail)
    }

    // ── session lifecycle ───────────────────────────────────────────

    pub fn clear_sessions(&self) {
        let ids_to_clear = self.cache.clear_summaries();
        let ids_set: HashSet<String> = ids_to_clear.iter().cloned().collect();
        self.cache.remove_details(&ids_set);

        if let Some(handle) = self.read_app_handle() {
            emit_sessions_cleared(&handle);
        }

        if !ids_to_clear.is_empty() {
            self.repository.spawn_delete_sessions(ids_to_clear);
        }
    }

    // M14: async variant. Cache update + event emission stay inline (fast,
    // lock-only); the heavy DB delete + body-file removal is offloaded to
    // `spawn_blocking` via `delete_sessions_and_bodies_async` so the IPC thread
    // is not blocked on SQLite + file I/O.
    pub async fn delete_sessions_except(&self, keep_session_id: &str) {
        let ids_to_remove = self.cache.retain_summaries(keep_session_id);
        let ids_set: HashSet<String> = ids_to_remove.iter().cloned().collect();
        self.cache.remove_details(&ids_set);

        if let Some(handle) = self.read_app_handle() {
            emit_sessions_removed(&handle, ids_to_remove.clone());
        }

        // Offload DB + body-file deletion to the blocking pool; the cache is
        // already consistent and the event already emitted, so this can run
        // concurrently without affecting the caller.
        self.repository
            .delete_sessions_and_bodies_async(ids_to_remove)
            .await;
    }

    /// Persist one session (async).  All blocking IO is offloaded to the
    /// repository's internal `spawn_blocking`.  Cache update and event emission
    /// happen in the async context after persistence completes.
    pub async fn upsert_session_async(&self, detail: ProxySessionDetail) {
        let active_workspace_id = self
            .read_status()
            .active_workspace_id
            .unwrap_or_else(|| "default".to_string());

        let detail = self
            .repository
            .persist_session_full(detail, &active_workspace_id)
            .await;
        self.update_session_cache_and_emit(&detail);
    }

    /// Persist a batch of sessions (async).  Same offload pattern as
    /// `upsert_session_async`.
    pub async fn upsert_session_batch_async(&self, sessions: Vec<ProxySessionDetail>) {
        let active_workspace_id = self
            .read_status()
            .active_workspace_id
            .unwrap_or_else(|| "default".to_string());

        let sessions = self
            .repository
            .persist_session_batch_full(sessions, &active_workspace_id)
            .await;
        for session in &sessions {
            self.update_session_cache_and_emit(session);
        }
    }

    /// Update the in-memory caches and emit frontend events for a session.
    /// A new detail is NOT inserted into the LRU here — only the summary Vec
    /// is; details enter the LRU only when explicitly viewed via
    /// `read_session_detail()`. An already-cached detail for this session is,
    /// however, refreshed in place so a viewer does not keep reading a stale
    /// snapshot (e.g. one captured before the response body arrived).
    fn update_session_cache_and_emit(&self, session_detail: &ProxySessionDetail) {
        let session_summary = session_detail.summary.clone();
        let focused_hosts = self.read_focused_hosts();

        let removed_ids = self
            .cache
            .upsert_summary(session_summary.clone(), &focused_hosts);

        // A session update (e.g. the response arriving for a request that was
        // captured while still in flight) makes any previously-cached detail
        // stale. Refresh it in place if present so viewers do not keep reading
        // the old snapshot; unviewed sessions are left out of the LRU.
        self.cache
            .refresh_detail_if_cached(&session_detail.id, session_detail.clone());

        if !removed_ids.is_empty() {
            tracing::warn!(
                component = "desktop.sessions",
                event = "session_summary_evicted",
                session_id = %session_detail.id,
                removed_count = removed_ids.len(),
                removed_session_ids = %removed_ids.join(","),
                focused_hosts_count = focused_hosts.len(),
                focused_hosts_sample = %focused_hosts.iter().take(10).cloned().collect::<Vec<_>>().join(","),
                "session_summary_evicted"
            );
            let removed_set: HashSet<String> = removed_ids.iter().cloned().collect();
            self.cache.remove_details(&removed_set);

            for removed_id in &removed_ids {
                if let Some(handle) = self.read_app_handle() {
                    emit_session_remove(&handle, removed_id);
                }
            }
        }

        if let Some(handle) = self.read_app_handle() {
            emit_session_upsert(&handle, session_summary);
        }
    }

    pub fn read_db_connection(&self) -> &Arc<Mutex<aiproxy_db::rusqlite::Connection>> {
        self.repository.db()
    }

    /// M17: returns the lock that serializes system-proxy enable/disable/restart.
    pub fn system_proxy_op_lock(&self) -> &tokio::sync::Mutex<()> {
        &self.system_proxy_op_lock
    }

    // ── runtime handles ─────────────────────────────────────────────

    pub fn set_runtime(&self, runtime_handles: RuntimeHandles) {
        let mut runtime = self
            .runtime
            .lock()
            .expect("runtime mutex should not be poisoned");
        *runtime = Some(runtime_handles);
    }

    pub fn take_runtime(&self) -> Option<RuntimeHandles> {
        self.runtime
            .lock()
            .expect("runtime mutex should not be poisoned")
            .take()
    }

    // ── system proxy snapshot ───────────────────────────────────────

    pub fn has_system_proxy_snapshot(&self) -> bool {
        self.system_proxy_snapshot
            .lock()
            .expect("system proxy snapshot mutex should not be poisoned")
            .is_some()
    }

    pub fn store_system_proxy_snapshot(&self, snapshot: SystemProxySnapshot) {
        let mut guard = self
            .system_proxy_snapshot
            .lock()
            .expect("system proxy snapshot mutex should not be poisoned");
        if guard.is_none() {
            *guard = Some(snapshot);
        }
    }

    pub fn take_system_proxy_snapshot(&self) -> Option<SystemProxySnapshot> {
        self.system_proxy_snapshot
            .lock()
            .expect("system proxy snapshot mutex should not be poisoned")
            .take()
    }

    // ── proxy lifecycle ─────────────────────────────────────────────

    pub fn start_proxy(
        &self,
        port: u16,
        enable_ssl: bool,
        http2_enabled: bool,
        workspace_id: String,
    ) -> BootstrapStatus {
        let mut status = self
            .status
            .lock()
            .expect("bootstrap status mutex should not be poisoned");
        status.port = port;
        status.running = true;
        status.ssl_enabled = enable_ssl;
        status.http2_enabled = http2_enabled;
        status.active_workspace_id = Some(workspace_id);
        status.started_at = Some(chrono::Utc::now().to_rfc3339());
        status.clone()
    }

    pub fn stop_proxy(&self, workspace_id: String) -> BootstrapStatus {
        let mut status = self
            .status
            .lock()
            .expect("bootstrap status mutex should not be poisoned");
        status.running = false;
        status.active_workspace_id = Some(workspace_id);
        status.started_at = None;
        status.clone()
    }

    pub fn set_system_proxy_enabled(&self, enabled: bool) -> BootstrapStatus {
        let mut status = self
            .status
            .lock()
            .expect("bootstrap status mutex should not be poisoned");
        status.system_proxy_enabled = enabled;
        if !enabled {
            status.system_proxy_recovery_warning = None;
        }
        status.clone()
    }

    pub fn set_system_proxy_recovery_warning(&self, warning: Option<String>) -> BootstrapStatus {
        let mut status = self
            .status
            .lock()
            .expect("bootstrap status mutex should not be poisoned");
        status.system_proxy_recovery_warning = warning;
        status.clone()
    }

    // ── TLS / cert ──────────────────────────────────────────────────

    pub fn set_tls_manager(&self, manager: Arc<TlsManager>) {
        let mut tls = self
            .tls_manager
            .lock()
            .expect("tls_manager mutex should not be poisoned");
        *tls = Some(manager);
    }

    pub fn read_tls_manager(&self) -> Option<Arc<TlsManager>> {
        self.tls_manager
            .lock()
            .expect("tls_manager mutex should not be poisoned")
            .clone()
    }

    pub fn update_cert_status(&self, status: CertificateStateSnapshot) {
        let mut cache = self
            .cert_status_cache
            .lock()
            .expect("cert_status mutex should not be poisoned");
        *cache = Some(status);
    }

    // ── manager accessors ───────────────────────────────────────────

    pub fn read_breakpoint_manager(&self) -> Arc<BreakpointManager> {
        Arc::clone(&self.breakpoint_manager)
    }
    pub fn read_rewrite_manager(&self) -> Arc<RewriteManager> {
        Arc::clone(&self.rewrite_manager)
    }
    pub fn read_map_manager(&self) -> Arc<MapManager> {
        Arc::clone(&self.map_manager)
    }
    pub fn read_throttle_manager(&self) -> Arc<ThrottleManager> {
        Arc::clone(&self.throttle_manager)
    }
    pub fn read_script_manager(&self) -> Arc<ScriptManager> {
        Arc::clone(&self.script_manager)
    }
    pub fn read_dns_manager(&self) -> Arc<DnsManager> {
        Arc::clone(&self.dns_manager)
    }
    pub fn read_workspace_manager(&self) -> Arc<WorkspaceManager> {
        Arc::clone(&self.workspace_manager)
    }

    // ── app handle ──────────────────────────────────────────────────

    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        let mut guard = self
            .app_handle
            .lock()
            .expect("app_handle mutex should not be poisoned");
        *guard = Some(handle);
    }

    pub fn read_app_handle(&self) -> Option<tauri::AppHandle> {
        self.app_handle
            .lock()
            .expect("app_handle mutex should not be poisoned")
            .clone()
    }

    // ── focused hosts ───────────────────────────────────────────────

    pub fn set_focused_hosts(&self, hosts: Vec<String>) {
        let mut focused_hosts = self
            .focused_hosts
            .lock()
            .expect("focused_hosts mutex should not be poisoned");
        *focused_hosts = normalize_hosts(hosts);
    }

    pub fn read_focused_hosts(&self) -> HashSet<String> {
        self.focused_hosts
            .lock()
            .expect("focused_hosts mutex should not be poisoned")
            .clone()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn normalize_optional_host(host: Option<String>) -> Option<String> {
    host.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_hosts(hosts: Vec<String>) -> HashSet<String> {
    hosts
        .into_iter()
        .filter_map(|host| normalize_optional_host(Some(host)))
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::converters::{proxy_detail_to_row, proxy_summary_to_row};
    use super::AppState;
    use aiproxy_db::body_store::BodyStore;
    use aiproxy_proxy_core::{ProxySessionDetail, ProxySessionSummary};
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    #[test]
    fn reads_session_detail_from_db_when_cache_is_empty() {
        let conn = aiproxy_db::rusqlite::Connection::open_in_memory().unwrap();
        aiproxy_db::schema::run_migrations(&conn).unwrap();

        let body_store_dir =
            std::env::temp_dir().join(format!("aiproxy-body-store-{}", Uuid::new_v4()));
        let body_store = Arc::new(BodyStore::new(body_store_dir.clone()));
        body_store.ensure_dir().unwrap();

        let state = AppState::new(Arc::new(Mutex::new(conn)), body_store);

        let summary = build_summary("db-session", "api.example.com");
        let detail = build_detail(&summary);
        let summary_row = proxy_summary_to_row(&summary);
        let detail_row = proxy_detail_to_row(&detail, state.repository.body_store().as_ref());
        {
            let conn = state
                .repository
                .db()
                .lock()
                .expect("db mutex should not be poisoned");
            aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row).unwrap();
        }

        state.cache.clear_summaries();
        state.cache.clear_details();

        let loaded = state
            .read_session_detail("db-session")
            .expect("detail should load from db");

        assert_eq!(loaded.id, "db-session");
        assert_eq!(loaded.summary.host, "api.example.com");
        assert_eq!(loaded.server_ip.as_deref(), Some("1.2.3.4"));

        let _ = std::fs::remove_dir_all(body_store_dir);
    }

    fn build_summary(id: &str, host: &str) -> ProxySessionSummary {
        ProxySessionSummary {
            id: id.to_string(),
            method: "GET".to_string(),
            host: host.to_string(),
            path: "/".to_string(),
            protocol: "HTTP/1.1".to_string(),
            scheme: "https".to_string(),
            http_version: "1.1".to_string(),
            transport_protocol: "tcp".to_string(),
            application_protocol: "http".to_string(),
            started_at: "2026-04-15T00:00:00Z".to_string(),
            finished_at: "2026-04-15T00:00:01Z".to_string(),
            duration_ms: 1,
            size_bytes: 1,
            status_code: 200,
            url: format!("https://{host}/"),
            response_mime_type: Some("application/json".to_string()),
        }
    }

    fn build_detail(summary: &ProxySessionSummary) -> ProxySessionDetail {
        ProxySessionDetail {
            client_address: Some("127.0.0.1:54321".to_string()),
            id: summary.id.clone(),
            query_params: Vec::new(),
            cookies: Vec::new(),
            raw_request_head: Some("GET / HTTP/1.1".to_string()),
            raw_response_head: Some("HTTP/1.1 200 OK".to_string()),
            request_body: None,
            request_headers: Vec::new(),
            response_body: None,
            response_headers: Vec::new(),
            map_traces: Vec::new(),
            rewrite_traces: Vec::new(),
            server_ip: Some("1.2.3.4".to_string()),
            script_traces: Vec::new(),
            summary: summary.clone(),
            throttle_traces: Vec::new(),
            tls_cipher_suite: Some("TLS_AES_128_GCM_SHA256".to_string()),
            tls_protocol: Some("TLSv1.3".to_string()),
            timing: None,
            timing_source: None,
            trailers: None,
            h2_stream_id: None,
        }
    }
}
