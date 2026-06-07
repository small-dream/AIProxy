mod cache;
mod converters;
mod events;
mod repository;

use cache::SessionCache;
use converters::{
    breakpoint_row_to_rule, detail_row_to_proxy, dns_mapping_row_to_rule,
    estimate_session_detail_row_text_bytes, map_row_to_rule, proxy_detail_to_row,
    proxy_summary_to_row, rewrite_row_to_rule, script_row_to_rule, spill_session_bodies_to_disk,
    summary_row_to_proxy, throttle_row_to_profile, throttle_row_to_rule, workspace_row_to_data,
};
use events::{
    emit_session_remove, emit_session_upsert, emit_sessions_cleared, emit_sessions_removed,
};
use repository::Repository;

use aiproxy_db::rules::{
    MapRunRow, RewriteRunEntryRow, RewriteRunRow, ScriptRunEntryRow, ScriptRunRow, ThrottleRunRow,
};
use aiproxy_db::sessions::SessionDetailRow;
use aiproxy_proxy_core::{
    BreakpointManager, DnsManager, MapManager, MapTrace, ProxyServerHandle, ProxySessionDetail,
    ProxySessionSummary, RewriteManager, RewriteTrace, ScriptManager, ScriptRunEntryKind,
    ScriptRunOutcome, ScriptTrace, ScriptTraceStage, ThrottleManager, ThrottleTrace, TlsManager,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::async_runtime::JoinHandle;

use crate::session_stats;
use crate::system_proxy::SystemProxySnapshot;
use crate::workspace::WorkspaceManager;

pub(crate) const SESSION_BATCH_SIZE: usize = 50;

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

#[derive(Debug)]
pub struct AppState {
    runtime: Mutex<Option<RuntimeHandles>>,
    cache: SessionCache,
    status: Mutex<BootstrapStatus>,
    system_proxy_snapshot: Mutex<Option<SystemProxySnapshot>>,
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

    /// Clear all session data from SQLite and BodyStore.
    /// Used at startup and shutdown to ensure no session data persists across restarts.
    pub fn clear_session_storage(&self) {
        self.repository.clear_all_sessions();
    }

    /// Load all persisted data from SQLite into the in-memory managers.
    fn init_from_db(&self) {
        // Clear all session data from previous runs (sessions are ephemeral)
        self.clear_session_storage();

        let conn = self.repository.db().lock().expect("db mutex should not be poisoned");

        // Load workspaces
        if let Ok(rows) = aiproxy_db::workspaces::load_all_workspaces(&conn) {
            if !rows.is_empty() {
                self.workspace_manager
                    .set_workspaces(rows.into_iter().map(workspace_row_to_data).collect());
            }
        }

        // Load rewrite rules
        if let Ok(rows) = aiproxy_db::rules::load_all_rewrite_rules(&conn) {
            self.rewrite_manager
                .set_rules(rows.into_iter().map(rewrite_row_to_rule).collect());
        }

        // Load map rules
        if let Ok(rows) = aiproxy_db::rules::load_all_map_rules(&conn) {
            self.map_manager
                .set_rules(rows.into_iter().map(map_row_to_rule).collect());
        }

        // Load script rules
        if let Ok(rows) = aiproxy_db::rules::load_all_script_rules(&conn) {
            self.script_manager
                .set_rules(rows.into_iter().map(script_row_to_rule).collect());
        }

        // Load throttle profiles
        if let Ok(rows) = aiproxy_db::rules::load_all_throttle_profiles(&conn) {
            self.throttle_manager
                .set_profiles(rows.into_iter().map(throttle_row_to_profile).collect());
        }

        if let Ok(rows) = aiproxy_db::rules::load_all_throttle_rules(&conn) {
            self.throttle_manager
                .set_rules(rows.into_iter().map(throttle_row_to_rule).collect());
        }

        // Load breakpoint rules
        if let Ok(rows) = aiproxy_db::rules::load_breakpoint_rules(&conn) {
            self.breakpoint_manager
                .set_rules(rows.into_iter().map(breakpoint_row_to_rule).collect());
        }

        // Load DNS mappings
        if let Ok(rows) = aiproxy_db::rules::load_all_dns_mappings(&conn) {
            self.dns_manager
                .set_rules(rows.into_iter().map(dns_mapping_row_to_rule).collect());
        }
    }

    pub fn read_status(&self) -> BootstrapStatus {
        self.status
            .lock()
            .expect("bootstrap status mutex should not be poisoned")
            .clone()
    }

    pub fn read_sessions(&self) -> Vec<ProxySessionSummary> {
        self.cache.read_summaries()
    }

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

        // Fallback: load from DB
        let detail = {
            let conn = self.repository.db().lock().expect("db mutex should not be poisoned");
            let row = match aiproxy_db::sessions::load_session_detail(&conn, session_id) {
                Ok(Some(row)) => {
                    tracing::debug!(
                        component = "desktop.persistence",
                        event = "session_detail_db_hit",
                        session_id = %session_id,
                        "session_detail_db_hit"
                    );
                    row
                }
                Ok(None) => {
                    tracing::warn!(
                        component = "desktop.persistence",
                        event = "session_detail_db_miss",
                        session_id = %session_id,
                        "session_detail_db_miss"
                    );
                    return None;
                }
                Err(error) => {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "load_session_detail_failed",
                        session_id = %session_id,
                        error = %error,
                        "load_session_detail_failed"
                    );
                    return None;
                }
            };

            let summary = self
                .cache
                .find_summary(session_id)
                .or_else(|| {
                    match aiproxy_db::sessions::load_session_summary(&conn, session_id) {
                        Ok(Some(row)) => {
                            tracing::debug!(
                                component = "desktop.persistence",
                                event = "session_summary_db_hit",
                                session_id = %session_id,
                                "session_summary_db_hit"
                            );
                            Some(summary_row_to_proxy(row))
                        }
                        Ok(None) => {
                            tracing::warn!(
                                component = "desktop.persistence",
                                event = "session_summary_db_miss",
                                session_id = %session_id,
                                "session_summary_db_miss"
                            );
                            None
                        }
                        Err(error) => {
                            tracing::error!(
                                component = "desktop.persistence",
                                event = "load_session_summary_failed",
                                session_id = %session_id,
                                error = %error,
                                "load_session_summary_failed"
                            );
                            None
                        }
                    }
                })?;

            detail_row_to_proxy(&row, summary, self.repository.body_store().as_ref())
        };

        self.cache.insert_detail(session_id.to_string(), detail.clone());
        tracing::debug!(
            component = "desktop.sessions",
            event = "session_detail_db_backfill_succeeded",
            session_id = %session_id,
            "session_detail_db_backfill_succeeded"
        );

        Some(detail)
    }

    pub fn clear_sessions(&self) {
        let ids_to_clear = self.cache.clear_summaries();
        let ids_set: HashSet<String> = ids_to_clear.iter().cloned().collect();
        self.cache.remove_details(&ids_set);

        if let Some(handle) = self.read_app_handle() {
            emit_sessions_cleared(&handle);
        }

        if ids_to_clear.is_empty() {
            return;
        }

        let db = Arc::clone(self.repository.db());
        let body_store = Arc::clone(self.repository.body_store());
        tauri::async_runtime::spawn_blocking(move || {
            {
                let conn = db.lock().expect("db mutex should not be poisoned");
                if let Err(error) =
                    aiproxy_db::sessions::delete_sessions_by_ids(&conn, &ids_to_clear)
                {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "clear_sessions_db_failed",
                        error = %error,
                        "clear_sessions_db_failed"
                    );
                }
            }

            for id in &ids_to_clear {
                if let Err(error) = body_store.remove_bodies(id) {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "clear_sessions_body_remove_failed",
                        session_id = %id,
                        error = %error,
                        "clear_sessions_body_remove_failed"
                    );
                }
            }
        });
    }

    pub fn delete_sessions_except(&self, keep_session_id: &str) {
        let ids_to_remove = self.cache.retain_summaries(keep_session_id);
        let ids_set: HashSet<String> = ids_to_remove.iter().cloned().collect();
        self.cache.remove_details(&ids_set);

        // Delete from DB and body files
        {
            let conn = self.repository.db().lock().expect("db mutex should not be poisoned");
            let _ = aiproxy_db::sessions::delete_sessions_by_ids(&conn, &ids_to_remove);
        }
        for id in &ids_to_remove {
            let _ = self.repository.body_store().remove_bodies(id);
        }

        if let Some(handle) = self.read_app_handle() {
            emit_sessions_removed(&handle, ids_to_remove);
        }
    }

    /// Use `upsert_session_async` instead. This sync variant exists for tests only.
    #[deprecated(note = "use upsert_session_async to avoid blocking the async runtime")]
    #[allow(dead_code)]
    pub fn upsert_session(&self, mut session_detail: ProxySessionDetail) {
        let active_workspace_id = self
            .read_status()
            .active_workspace_id
            .unwrap_or_else(|| "default".to_string());

        self.persist_session_to_db(&mut session_detail, &active_workspace_id);
        self.update_session_cache_and_emit(&session_detail);
    }

    /// Async version of `upsert_session` that offloads blocking IO (body spill + SQLite)
    /// to a blocking thread via `tauri::async_runtime::spawn_blocking`, keeping the
    /// async runtime free for other work.
    ///
    /// `update_session_cache_and_emit` runs after `spawn_blocking` returns so that the
    /// session_details / sessions mutexes are not held inside the blocking thread.
    pub async fn upsert_session_async(&self, mut session_detail: ProxySessionDetail) {
        let active_workspace_id = self
            .read_status()
            .active_workspace_id
            .unwrap_or_else(|| "default".to_string());

        let db = Arc::clone(self.repository.db());
        let body_store = Arc::clone(self.repository.body_store());

        // Move blocking IO into the blocking thread pool.
        // body spill uses std::fs (sync), row build is pure CPU, SQLite is sync —
        // all belong in spawn_blocking.
        // Return session_detail so we can use it for cache update afterwards.
        let session_detail = tauri::async_runtime::spawn_blocking(move || {
            let spill_started_at = Instant::now();
            if let Err(error) = spill_session_bodies_to_disk(&mut session_detail, &body_store) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "session_body_spill_failed",
                    error = %error,
                    "session_body_spill_failed"
                );
            }
            let spill_elapsed_us = spill_started_at.elapsed().as_micros();

            let summary_row = proxy_summary_to_row(&session_detail.summary);
            let row_build_started_at = Instant::now();
            let detail_row = proxy_detail_to_row(&session_detail, &body_store);
            let row_build_elapsed_us = row_build_started_at.elapsed().as_micros();
            log_session_storage_stats(
                &session_detail,
                &detail_row,
                spill_elapsed_us,
                row_build_elapsed_us,
            );

            let conn = db.lock().expect("db mutex should not be poisoned");
            if let Err(e) = aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "session_upsert_db_failed",
                    error = %e,
                    "session_upsert_db_failed"
                );
            }

            if let Err(e) = persist_script_traces(
                &conn,
                &session_detail.id,
                &active_workspace_id,
                &session_detail.summary,
                &session_detail.script_traces,
            ) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "script_trace_upsert_db_failed",
                    error = %e,
                    "script_trace_upsert_db_failed"
                );
            }

            if let Err(e) = persist_rewrite_traces(
                &conn,
                &session_detail.id,
                &active_workspace_id,
                &session_detail.summary,
                &session_detail.rewrite_traces,
            ) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "rewrite_trace_upsert_db_failed",
                    error = %e,
                    "rewrite_trace_upsert_db_failed"
                );
            }

            if let Err(e) = persist_map_traces(
                &conn,
                &session_detail.id,
                &active_workspace_id,
                &session_detail.summary,
                &session_detail.map_traces,
            ) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "map_trace_upsert_db_failed",
                    error = %e,
                    "map_trace_upsert_db_failed"
                );
            }

            if let Err(e) = persist_throttle_traces(
                &conn,
                &session_detail.id,
                &active_workspace_id,
                &session_detail.throttle_traces,
            ) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "throttle_trace_upsert_db_failed",
                    error = %e,
                    "throttle_trace_upsert_db_failed"
                );
            }

            // Return session_detail for cache update in async context.
            session_detail
        })
        .await
        .expect("persist_session spawn_blocking should not panic");

        // Update caches and emit in the async context (not inside spawn_blocking)
        // to avoid nested mutex locks across threads.
        self.update_session_cache_and_emit(&session_detail);
    }

    /// Persist a single session to the database (spill bodies, build rows, INSERT).
    #[allow(dead_code)]
    fn persist_session_to_db(
        &self,
        session_detail: &mut ProxySessionDetail,
        active_workspace_id: &str,
    ) {
        let spill_started_at = Instant::now();
        if let Err(error) = spill_session_bodies_to_disk(session_detail, self.repository.body_store().as_ref()) {
            tracing::error!(
                component = "desktop.persistence",
                event = "session_body_spill_failed",
                error = %error,
                "session_body_spill_failed"
            );
        }
        let spill_elapsed_us = spill_started_at.elapsed().as_micros();

        let summary_row = proxy_summary_to_row(&session_detail.summary);
        let row_build_started_at = Instant::now();
        let detail_row = proxy_detail_to_row(session_detail, self.repository.body_store().as_ref());
        let row_build_elapsed_us = row_build_started_at.elapsed().as_micros();
        log_session_storage_stats(
            session_detail,
            &detail_row,
            spill_elapsed_us,
            row_build_elapsed_us,
        );

        let conn = self.repository.db().lock().expect("db mutex should not be poisoned");
        if let Err(e) = aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row) {
            tracing::error!(
                component = "desktop.persistence",
                event = "session_upsert_db_failed",
                error = %e,
                "session_upsert_db_failed"
            );
        }

        if let Err(e) = persist_script_traces(
            &conn,
            &session_detail.id,
            active_workspace_id,
            &session_detail.summary,
            &session_detail.script_traces,
        ) {
            tracing::error!(
                component = "desktop.persistence",
                event = "script_trace_upsert_db_failed",
                error = %e,
                "script_trace_upsert_db_failed"
            );
        }

        if let Err(e) = persist_rewrite_traces(
            &conn,
            &session_detail.id,
            active_workspace_id,
            &session_detail.summary,
            &session_detail.rewrite_traces,
        ) {
            tracing::error!(
                component = "desktop.persistence",
                event = "rewrite_trace_upsert_db_failed",
                error = %e,
                "rewrite_trace_upsert_db_failed"
            );
        }

        if let Err(e) = persist_map_traces(
            &conn,
            &session_detail.id,
            active_workspace_id,
            &session_detail.summary,
            &session_detail.map_traces,
        ) {
            tracing::error!(
                component = "desktop.persistence",
                event = "map_trace_upsert_db_failed",
                error = %e,
                "map_trace_upsert_db_failed"
            );
        }

        if let Err(e) = persist_throttle_traces(
            &conn,
            &session_detail.id,
            active_workspace_id,
            &session_detail.throttle_traces,
        ) {
            tracing::error!(
                component = "desktop.persistence",
                event = "throttle_trace_upsert_db_failed",
                error = %e,
                "throttle_trace_upsert_db_failed"
            );
        }

        drop(conn);
    }

    /// Update the in-memory caches and emit frontend events for a session.
    /// Detail is NOT inserted into the LRU here. Only the summary Vec is updated.
    /// Detail enters the LRU only when the user explicitly views it via read_session_detail().
    fn update_session_cache_and_emit(&self, session_detail: &ProxySessionDetail) {
        let session_summary = session_detail.summary.clone();
        let focused_hosts = self.read_focused_hosts();

        let removed_ids = self.cache.upsert_summary(session_summary.clone(), &focused_hosts);

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

    /// Persist a batch of sessions with a single DB lock acquisition.
    #[allow(dead_code)]
    pub fn upsert_session_batch(&self, sessions: &mut [ProxySessionDetail]) {
        let active_workspace_id = self
            .read_status()
            .active_workspace_id
            .unwrap_or_else(|| "default".to_string());

        // Spill bodies to disk before acquiring DB lock.
        for session in sessions.iter_mut() {
            if let Err(error) = spill_session_bodies_to_disk(session, self.repository.body_store().as_ref()) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "session_body_spill_failed",
                    error = %error,
                    "session_body_spill_failed"
                );
            }
        }

        // Batch DB writes under one lock.
        let conn = self.repository.db().lock().expect("db mutex should not be poisoned");
        for session in sessions.iter() {
            let summary_row = proxy_summary_to_row(&session.summary);
            let detail_row = proxy_detail_to_row(session, self.repository.body_store().as_ref());

            if let Err(e) = aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "session_upsert_db_failed",
                    error = %e,
                    "session_upsert_db_failed"
                );
            }

            if let Err(e) = persist_script_traces(
                &conn,
                &session.id,
                &active_workspace_id,
                &session.summary,
                &session.script_traces,
            ) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "script_trace_upsert_db_failed",
                    error = %e,
                    "script_trace_upsert_db_failed"
                );
            }

            if let Err(e) = persist_rewrite_traces(
                &conn,
                &session.id,
                &active_workspace_id,
                &session.summary,
                &session.rewrite_traces,
            ) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "rewrite_trace_upsert_db_failed",
                    error = %e,
                    "rewrite_trace_upsert_db_failed"
                );
            }

            if let Err(e) = persist_map_traces(
                &conn,
                &session.id,
                &active_workspace_id,
                &session.summary,
                &session.map_traces,
            ) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "map_trace_upsert_db_failed",
                    error = %e,
                    "map_trace_upsert_db_failed"
                );
            }

            if let Err(e) = persist_throttle_traces(
                &conn,
                &session.id,
                &active_workspace_id,
                &session.throttle_traces,
            ) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "throttle_trace_upsert_db_failed",
                    error = %e,
                    "throttle_trace_upsert_db_failed"
                );
            }
        }
        drop(conn);

        // Update caches and emit events per session.
        for session in sessions.iter() {
            self.update_session_cache_and_emit(session);
        }
    }

    /// Async version of `upsert_session_batch` that offloads blocking IO
    /// (body spill + SQLite writes) to a blocking thread.
    pub async fn upsert_session_batch_async(&self, mut sessions: Vec<ProxySessionDetail>) {
        let active_workspace_id = self
            .read_status()
            .active_workspace_id
            .unwrap_or_else(|| "default".to_string());

        let db = Arc::clone(self.repository.db());
        let body_store = Arc::clone(self.repository.body_store());

        // Move all blocking IO into spawn_blocking.
        // Return sessions for cache update in async context afterwards.
        let sessions = tauri::async_runtime::spawn_blocking(move || {
            // Spill bodies to disk.
            for session in sessions.iter_mut() {
                if let Err(error) = spill_session_bodies_to_disk(session, &body_store) {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "session_body_spill_failed",
                        error = %error,
                        "session_body_spill_failed"
                    );
                }
            }

            // Batch DB writes under one lock.
            let conn = db.lock().expect("db mutex should not be poisoned");
            for session in sessions.iter() {
                let summary_row = proxy_summary_to_row(&session.summary);
                let detail_row = proxy_detail_to_row(session, &body_store);

                if let Err(e) =
                    aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row)
                {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "session_upsert_db_failed",
                        error = %e,
                        "session_upsert_db_failed"
                    );
                }

                if let Err(e) = persist_script_traces(
                    &conn,
                    &session.id,
                    &active_workspace_id,
                    &session.summary,
                    &session.script_traces,
                ) {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "script_trace_upsert_db_failed",
                        error = %e,
                        "script_trace_upsert_db_failed"
                    );
                }

                if let Err(e) = persist_rewrite_traces(
                    &conn,
                    &session.id,
                    &active_workspace_id,
                    &session.summary,
                    &session.rewrite_traces,
                ) {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "rewrite_trace_upsert_db_failed",
                        error = %e,
                        "rewrite_trace_upsert_db_failed"
                    );
                }

                if let Err(e) = persist_map_traces(
                    &conn,
                    &session.id,
                    &active_workspace_id,
                    &session.summary,
                    &session.map_traces,
                ) {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "map_trace_upsert_db_failed",
                        error = %e,
                        "map_trace_upsert_db_failed"
                    );
                }

                if let Err(e) = persist_throttle_traces(
                    &conn,
                    &session.id,
                    &active_workspace_id,
                    &session.throttle_traces,
                ) {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "throttle_trace_upsert_db_failed",
                        error = %e,
                        "throttle_trace_upsert_db_failed"
                    );
                }
            }

            // Return sessions for cache update in async context.
            sessions
        })
        .await
        .expect("persist_session_batch spawn_blocking should not panic");

        // Update caches and emit in the async context.
        for session in sessions.iter() {
            self.update_session_cache_and_emit(session);
        }
    }

    pub fn read_db_connection(&self) -> &Arc<Mutex<aiproxy_db::rusqlite::Connection>> {
        self.repository.db()
    }

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

    pub fn has_system_proxy_snapshot(&self) -> bool {
        self.system_proxy_snapshot
            .lock()
            .expect("system proxy snapshot mutex should not be poisoned")
            .is_some()
    }

    pub fn store_system_proxy_snapshot(&self, snapshot: SystemProxySnapshot) {
        let mut system_proxy_snapshot = self
            .system_proxy_snapshot
            .lock()
            .expect("system proxy snapshot mutex should not be poisoned");

        if system_proxy_snapshot.is_none() {
            *system_proxy_snapshot = Some(snapshot);
        }
    }

    pub fn take_system_proxy_snapshot(&self) -> Option<SystemProxySnapshot> {
        self.system_proxy_snapshot
            .lock()
            .expect("system proxy snapshot mutex should not be poisoned")
            .take()
    }

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

fn log_session_storage_stats(
    detail: &ProxySessionDetail,
    row: &SessionDetailRow,
    spill_elapsed_us: u128,
    row_build_elapsed_us: u128,
) {
    if !session_stats::is_enabled() {
        return;
    }

    let request_body_storage = detail
        .request_body
        .as_ref()
        .map_or("none", |body| body.storage_kind());
    let response_body_storage = detail
        .response_body
        .as_ref()
        .map_or("none", |body| body.storage_kind());
    let request_body_resident_bytes = detail
        .request_body
        .as_ref()
        .map_or(0, |body| body.resident_memory_bytes_estimate());
    let response_body_resident_bytes = detail
        .response_body
        .as_ref()
        .map_or(0, |body| body.resident_memory_bytes_estimate());

    session_stats::record(
        "session_storage_stats",
        &[
            ("session_id", detail.id.clone()),
            ("method", detail.summary.method.clone()),
            ("status_code", detail.summary.status_code.to_string()),
            (
                "resident_memory_bytes_estimate",
                detail.resident_memory_bytes_estimate().to_string(),
            ),
            (
                "summary_memory_bytes_estimate",
                detail.summary.resident_memory_bytes_estimate().to_string(),
            ),
            ("request_body_storage", request_body_storage.to_string()),
            (
                "request_body_resident_bytes",
                request_body_resident_bytes.to_string(),
            ),
            ("response_body_storage", response_body_storage.to_string()),
            (
                "response_body_resident_bytes",
                response_body_resident_bytes.to_string(),
            ),
            (
                "db_row_text_bytes",
                estimate_session_detail_row_text_bytes(row).to_string(),
            ),
            (
                "request_body_ref_bytes",
                row.request_body_ref
                    .as_ref()
                    .map_or(0, |value| value.len())
                    .to_string(),
            ),
            (
                "response_body_ref_bytes",
                row.response_body_ref
                    .as_ref()
                    .map_or(0, |value| value.len())
                    .to_string(),
            ),
            (
                "raw_request_head_bytes",
                row.raw_request
                    .as_ref()
                    .map_or(0, |value| value.len())
                    .to_string(),
            ),
            (
                "raw_response_head_bytes",
                row.raw_response
                    .as_ref()
                    .map_or(0, |value| value.len())
                    .to_string(),
            ),
            ("spill_elapsed_us", spill_elapsed_us.to_string()),
            ("row_build_elapsed_us", row_build_elapsed_us.to_string()),
        ],
    );
}

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


fn persist_script_traces(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    summary: &ProxySessionSummary,
    traces: &[ScriptTrace],
) -> Result<(), String> {
    let created_at = summary.finished_at.clone();
    let runs: Vec<ScriptRunRow> = traces
        .iter()
        .enumerate()
        .map(|(index, trace)| ScriptRunRow {
            id: format!("{session_id}-script-run-{index}"),
            session_id: session_id.to_string(),
            rule_id: trace.rule_id.clone(),
            workspace_id: workspace_id.to_string(),
            stage: match trace.stage {
                ScriptTraceStage::Request => "request".to_string(),
                ScriptTraceStage::Response => "response".to_string(),
            },
            outcome: match trace.outcome {
                ScriptRunOutcome::Success => "success".to_string(),
                ScriptRunOutcome::Skipped => "skipped".to_string(),
                ScriptRunOutcome::RuntimeError => "runtimeError".to_string(),
                ScriptRunOutcome::TimedOut => "timedOut".to_string(),
                ScriptRunOutcome::InvalidResult => "invalidResult".to_string(),
            },
            duration_ms: trace.duration_ms,
            created_at: created_at.clone(),
        })
        .collect();

    let entries: Vec<ScriptRunEntryRow> = traces
        .iter()
        .enumerate()
        .flat_map(|(run_index, trace)| {
            trace
                .entries
                .iter()
                .enumerate()
                .map(move |(entry_index, entry)| ScriptRunEntryRow {
                    id: format!("{session_id}-script-run-{run_index}-entry-{entry_index}"),
                    run_id: format!("{session_id}-script-run-{run_index}"),
                    kind: match entry.kind {
                        ScriptRunEntryKind::Log => "log".to_string(),
                        ScriptRunEntryKind::Extraction => "extraction".to_string(),
                        ScriptRunEntryKind::Error => "error".to_string(),
                    },
                    level: entry.level.as_ref().map(|level| match level {
                        aiproxy_proxy_core::ScriptLogLevel::Debug => "debug".to_string(),
                        aiproxy_proxy_core::ScriptLogLevel::Info => "info".to_string(),
                        aiproxy_proxy_core::ScriptLogLevel::Warn => "warn".to_string(),
                        aiproxy_proxy_core::ScriptLogLevel::Error => "error".to_string(),
                    }),
                    key: entry.key.clone(),
                    message: entry.message.clone(),
                    payload_json: entry.payload_json.clone(),
                    seq: entry.sequence,
                })
        })
        .collect();

    aiproxy_db::rules::replace_script_runs_for_session(conn, session_id, &runs, &entries)
}

fn persist_rewrite_traces(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    summary: &ProxySessionSummary,
    traces: &[RewriteTrace],
) -> Result<(), String> {
    let created_at = summary.finished_at.clone();
    let runs: Vec<RewriteRunRow> = traces
        .iter()
        .enumerate()
        .map(|(index, trace)| RewriteRunRow {
            id: format!("{session_id}-rewrite-run-{index}"),
            session_id: session_id.to_string(),
            rule_id: trace.rule_id.clone(),
            rule_name: trace.rule_name.clone(),
            workspace_id: workspace_id.to_string(),
            rewrite_type: trace.rewrite_type.clone(),
            stage: trace.stage.clone(),
            outcome: trace.outcome.clone(),
            duration_ms: trace.duration_ms,
            created_at: created_at.clone(),
        })
        .collect();

    let entries: Vec<RewriteRunEntryRow> = traces
        .iter()
        .enumerate()
        .flat_map(|(run_index, trace)| {
            trace
                .entries
                .iter()
                .enumerate()
                .map(move |(entry_index, entry)| RewriteRunEntryRow {
                    id: format!("{session_id}-rewrite-run-{run_index}-entry-{entry_index}"),
                    run_id: format!("{session_id}-rewrite-run-{run_index}"),
                    kind: entry.kind.clone(),
                    key: entry.key.clone(),
                    before_value: entry.before.clone(),
                    after_value: entry.after.clone(),
                    message: entry.message.clone(),
                    seq: entry.sequence,
                })
        })
        .collect();

    aiproxy_db::rules::replace_rewrite_runs_for_session(conn, session_id, &runs, &entries)
}

fn persist_map_traces(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    summary: &ProxySessionSummary,
    traces: &[MapTrace],
) -> Result<(), String> {
    let created_at = summary.finished_at.clone();
    let runs: Vec<MapRunRow> = traces
        .iter()
        .enumerate()
        .map(|(index, trace)| MapRunRow {
            id: format!("{session_id}-map-run-{index}"),
            session_id: session_id.to_string(),
            workspace_id: workspace_id.to_string(),
            rule_id: trace.rule_id.clone(),
            rule_name: trace.rule_name.clone(),
            mode: trace.mode.clone(),
            outcome: trace.outcome.clone(),
            source_pattern: trace.source_pattern.clone(),
            target_value: trace.target_value.clone(),
            original_url: trace.original_url.clone(),
            mapped_url: trace.mapped_url.clone(),
            local_path: trace.local_path.clone(),
            duration_ms: trace.duration_ms,
            sequence: index as u32,
            created_at: created_at.clone(),
        })
        .collect();

    aiproxy_db::rules::replace_map_runs_for_session(conn, session_id, &runs)
}

fn persist_throttle_traces(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    traces: &[ThrottleTrace],
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let runs: Vec<ThrottleRunRow> = traces
        .iter()
        .enumerate()
        .map(|(index, trace)| ThrottleRunRow {
            id: format!("{session_id}-throttle-{index}"),
            session_id: session_id.to_string(),
            workspace_id: workspace_id.to_string(),
            profile_id: trace.profile_id.clone(),
            profile_name: trace.profile_name.clone(),
            rule_id: trace.rule_id.clone(),
            rule_name: trace.rule_name.clone(),
            stage: trace.stage.clone(),
            outcome: trace.outcome.clone(),
            delay_ms: trace.delay_ms,
            latency_ms: trace.latency_ms,
            transfer_delay_ms: trace.transfer_delay_ms,
            body_bytes: trace.body_bytes,
            message: trace.message.clone(),
            sequence: index as u32,
            created_at: now.clone(),
        })
        .collect();

    aiproxy_db::rules::replace_throttle_runs_for_session(conn, session_id, &runs)
}

#[cfg(test)]
mod tests {
    use super::{proxy_detail_to_row, proxy_summary_to_row, AppState};
    use aiproxy_db::body_store::BodyStore;
    use aiproxy_proxy_core::{ProxySessionDetail, ProxySessionSummary};
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    // Eviction tests moved to cache.rs alongside the SessionCache type.

    #[test]
    fn reads_session_detail_from_db_when_cache_is_empty() {
        let conn = aiproxy_db::rusqlite::Connection::open_in_memory().unwrap();
        aiproxy_db::schema::run_migrations(&conn).unwrap();

        let body_store_dir =
            std::env::temp_dir().join(format!("aiproxy-body-store-{}", Uuid::new_v4()));
        let body_store = Arc::new(BodyStore::new(body_store_dir.clone()));
        body_store.ensure_dir().unwrap();

        // Create AppState first (init_from_db clears session storage on startup)
        let state = AppState::new(Arc::new(Mutex::new(conn)), body_store);

        // Insert test data after AppState creation so it survives the startup cleanup
        let summary = build_summary("db-session", "api.example.com");
        let detail = build_detail(&summary);
        let summary_row = proxy_summary_to_row(&summary);
        let detail_row = proxy_detail_to_row(&detail, state.repository.body_store().as_ref());
        {
            let conn = state.repository.db().lock().expect("db mutex should not be poisoned");
            aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row).unwrap();
        }

        // Clear in-memory caches so the test must fall back to DB
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
