use aiproxy_db::body_store::{BodyStore, BODY_FILE_THRESHOLD};
use aiproxy_db::rules::{
    BreakpointRuleRow, DnsMappingRow, MapRuleRow, RewriteRuleRow, ScriptRuleRow,
    ScriptRunEntryRow, ScriptRunRow, ThrottleProfileRow,
};
use aiproxy_db::sessions::{SessionDetailRow, SessionSummaryRow};
use aiproxy_db::workspaces::WorkspaceRow;
use aiproxy_proxy_core::{
    BreakpointManager, BreakpointRule, BreakpointStage, DnsManager, DnsMappingRule, MapManager,
    MapRule, ProxyServerHandle, ProxySessionDetail, ProxySessionSummary, RewriteManager,
    RewriteRule, RewriteRuleMatch, ScriptEntrypoints, ScriptManager, ScriptRule,
    ScriptRuleLanguage, ScriptRuleSourceType, ScriptRunEntryKind,
    ScriptRunOutcome, ScriptTrace, ScriptTraceStage, ThrottleManager, ThrottleProfileData,
    TlsManager, CompiledScriptRule,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{async_runtime::JoinHandle, Emitter};

use crate::session_stats;
use crate::system_proxy::SystemProxySnapshot;
use crate::workspace::{WorkspaceData, WorkspaceManager};

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
    pub system_proxy_enabled: bool,
    pub started_at: Option<String>,
}

impl Default for BootstrapStatus {
    fn default() -> Self {
        Self {
            active_workspace_id: Some("default".to_string()),
            port: 8888,
            running: false,
            ssl_enabled: false,
            system_proxy_enabled: false,
            started_at: None,
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
    session_details: Arc<Mutex<HashMap<String, ProxySessionDetail>>>,
    sessions: Arc<Mutex<Vec<ProxySessionSummary>>>,
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
    focused_host: Mutex<Option<String>>,
    db: Arc<Mutex<aiproxy_db::rusqlite::Connection>>,
    body_store: Arc<BodyStore>,
}

impl AppState {
    pub fn new(db: Arc<Mutex<aiproxy_db::rusqlite::Connection>>, body_store: Arc<BodyStore>) -> Self {
        let state = Self {
            runtime: Mutex::new(None),
            session_details: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(Vec::new())),
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
            focused_host: Mutex::new(None),
            db,
            body_store,
        };

        state.init_from_db();
        state
    }

    /// Load all persisted data from SQLite into the in-memory managers.
    fn init_from_db(&self) {
        let conn = self.db.lock().expect("db mutex should not be poisoned");

        // Load workspaces
        if let Ok(rows) = aiproxy_db::workspaces::load_all_workspaces(&conn) {
            if !rows.is_empty() {
                self.workspace_manager.set_workspaces(
                    rows.into_iter().map(workspace_row_to_data).collect(),
                );
            }
        }

        // Load rewrite rules
        if let Ok(rows) = aiproxy_db::rules::load_all_rewrite_rules(&conn) {
            self.rewrite_manager.set_rules(
                rows.into_iter().map(rewrite_row_to_rule).collect(),
            );
        }

        // Load map rules
        if let Ok(rows) = aiproxy_db::rules::load_all_map_rules(&conn) {
            self.map_manager.set_rules(
                rows.into_iter().map(map_row_to_rule).collect(),
            );
        }

        // Load script rules
        if let Ok(rows) = aiproxy_db::rules::load_all_script_rules(&conn) {
            self.script_manager.set_rules(
                rows.into_iter().map(script_row_to_rule).collect(),
            );
        }

        // Load throttle profiles
        if let Ok(rows) = aiproxy_db::rules::load_all_throttle_profiles(&conn) {
            self.throttle_manager.set_profiles(
                rows.into_iter().map(throttle_row_to_profile).collect(),
            );
        }

        // Load breakpoint rules
        if let Ok(rows) = aiproxy_db::rules::load_breakpoint_rules(&conn) {
            self.breakpoint_manager.set_rules(
                rows.into_iter().map(breakpoint_row_to_rule).collect(),
            );
        }

        // Load DNS mappings
        if let Ok(rows) = aiproxy_db::rules::load_all_dns_mappings(&conn) {
            self.dns_manager.set_rules(
                rows.into_iter().map(dns_mapping_row_to_rule).collect(),
            );
        }

        // Load recent session summaries
        if let Ok(rows) = aiproxy_db::sessions::load_recent_summaries(&conn, 15_000) {
            let mut sessions = self
                .sessions
                .lock()
                .expect("session list mutex should not be poisoned");
            // Reverse so newest is last (matching the append order during capture)
            *sessions = rows.into_iter().rev().map(summary_row_to_proxy).collect();
        }
    }

    pub fn read_status(&self) -> BootstrapStatus {
        self.status
            .lock()
            .expect("bootstrap status mutex should not be poisoned")
            .clone()
    }

    pub fn read_sessions(&self) -> Vec<ProxySessionSummary> {
        self.sessions
            .lock()
            .expect("session list mutex should not be poisoned")
            .clone()
    }

    pub fn read_session_detail(&self, session_id: &str) -> Option<ProxySessionDetail> {
        // Try in-memory cache first
        if let Some(detail) = self
            .session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .get(session_id)
            .cloned()
        {
            return Some(detail);
        }

        // Fallback: load from DB
        let detail = {
            let conn = self.db.lock().expect("db mutex should not be poisoned");
            let row = aiproxy_db::sessions::load_session_detail(&conn, session_id)
                .ok()
                .flatten()?;

            let summary = self
                .sessions
                .lock()
                .expect("session list mutex should not be poisoned")
                .iter()
                .find(|s| s.id == session_id)
                .cloned()
                .or_else(|| {
                    aiproxy_db::sessions::load_session_summary(&conn, session_id)
                        .ok()
                        .flatten()
                        .map(summary_row_to_proxy)
                })?;

            detail_row_to_proxy(&row, summary, &self.body_store)
        };

        self.session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .insert(session_id.to_string(), detail.clone());

        Some(detail)
    }

    pub fn clear_sessions(&self) {
        // Clear from DB and body files
        {
            let conn = self.db.lock().expect("db mutex should not be poisoned");
            let _ = aiproxy_db::sessions::clear_all_sessions(&conn);
        }
        let _ = self.body_store.clear_all();

        let ids_to_remove: Vec<String> = {
            let sessions = self
                .sessions
                .lock()
                .expect("session list mutex should not be poisoned");
            sessions.iter().map(|session| session.id.clone()).collect()
        };

        self.session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .clear();

        self.sessions
            .lock()
            .expect("session list mutex should not be poisoned")
            .clear();

        if let Some(handle) = self.read_app_handle() {
            for id in &ids_to_remove {
                let _ = handle.emit("session-remove", id);
            }
        }
    }

    pub fn delete_sessions_except(&self, keep_session_id: &str) {
        let ids_to_remove: Vec<String> = {
            let sessions = self
                .sessions
                .lock()
                .expect("session list mutex should not be poisoned");
            sessions
                .iter()
                .filter(|s| s.id != keep_session_id)
                .map(|s| s.id.clone())
                .collect()
        };

        // Delete from DB and body files
        {
            let conn = self.db.lock().expect("db mutex should not be poisoned");
            let _ = aiproxy_db::sessions::delete_sessions_by_ids(&conn, &ids_to_remove);
        }
        for id in &ids_to_remove {
            let _ = self.body_store.remove_bodies(id);
        }

        self.sessions
            .lock()
            .expect("session list mutex should not be poisoned")
            .retain(|s| s.id == keep_session_id);

        let mut details = self
            .session_details
            .lock()
            .expect("session detail mutex should not be poisoned");

        for id in &ids_to_remove {
            details.remove(id);
        }

        if let Some(handle) = self.read_app_handle() {
            for id in &ids_to_remove {
                let _ = handle.emit("session-remove", id);
            }
        }
    }

    pub fn upsert_session(&self, mut session_detail: ProxySessionDetail) {
        let session_id = session_detail.id.clone();
        let session_summary = session_detail.summary.clone();

        let spill_started_at = Instant::now();
        if let Err(error) = spill_session_bodies_to_disk(&mut session_detail, &self.body_store) {
            crate::dev_logger::log_error(
                "desktop.persistence",
                "session_body_spill_failed",
                &[("error", error)],
            );
        }
        let spill_elapsed_us = spill_started_at.elapsed().as_micros();

        // Persist to DB
        {
            let conn = self.db.lock().expect("db mutex should not be poisoned");
            let summary_row = proxy_summary_to_row(&session_summary);
            let row_build_started_at = Instant::now();
            let detail_row = proxy_detail_to_row(&session_detail, &self.body_store);
            let row_build_elapsed_us = row_build_started_at.elapsed().as_micros();
            log_session_storage_stats(
                &session_detail,
                &detail_row,
                spill_elapsed_us,
                row_build_elapsed_us,
            );
            if let Err(e) = aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row)
            {
                crate::dev_logger::log_error(
                    "desktop.persistence",
                    "session_upsert_db_failed",
                    &[("error", e)],
                );
            }

            if let Err(e) = persist_script_traces(
                &conn,
                &session_detail.id,
                self.read_status()
                    .active_workspace_id
                    .as_deref()
                    .unwrap_or("default"),
                &session_detail.summary,
                &session_detail.script_traces,
            ) {
                crate::dev_logger::log_error(
                    "desktop.persistence",
                    "script_trace_upsert_db_failed",
                    &[("error", e)],
                );
            }
        }

        self.session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .insert(session_id.clone(), session_detail.clone());

        let mut sessions = self
            .sessions
            .lock()
            .expect("session list mutex should not be poisoned");

        if let Some(existing_index) = sessions.iter().position(|session| session.id == session_id) {
            sessions[existing_index] = session_summary.clone();
        } else {
            sessions.push(session_summary.clone());
        }

        let focused_host = self.read_focused_host();

        while sessions.len() > 15_000 {
            let eviction_index = select_session_eviction_index(
                &sessions,
                focused_host.as_deref(),
            );
            let removed_session = sessions.remove(eviction_index);

            // Remove from DB and body files
            {
                let conn = self.db.lock().expect("db mutex should not be poisoned");
                let _ = aiproxy_db::sessions::delete_sessions_by_ids(
                    &conn,
                    &[removed_session.id.clone()],
                );
            }
            let _ = self.body_store.remove_bodies(&removed_session.id);

            self.session_details
                .lock()
                .expect("session detail mutex should not be poisoned")
                .remove(&removed_session.id);
            if let Some(handle) = self.read_app_handle() {
                let _ = handle.emit("session-remove", &removed_session.id);
            }
        }

        if let Some(handle) = self.read_app_handle() {
            let _ = handle.emit("session-upsert", session_summary);
        }
    }

    pub fn read_db_connection(&self) -> &Arc<Mutex<aiproxy_db::rusqlite::Connection>> {
        &self.db
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
        workspace_id: String,
    ) -> BootstrapStatus {
        let mut status = self
            .status
            .lock()
            .expect("bootstrap status mutex should not be poisoned");

        status.port = port;
        status.running = true;
        status.ssl_enabled = enable_ssl;
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

    pub fn set_focused_host(&self, host: Option<String>) {
        let mut focused = self
            .focused_host
            .lock()
            .expect("focused_host mutex should not be poisoned");
        *focused = normalize_optional_host(host);
    }

    pub fn read_focused_host(&self) -> Option<String> {
        self.focused_host
            .lock()
            .expect("focused_host mutex should not be poisoned")
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
                row.raw_request.as_ref().map_or(0, |value| value.len()).to_string(),
            ),
            (
                "raw_response_head_bytes",
                row.raw_response.as_ref().map_or(0, |value| value.len()).to_string(),
            ),
            ("spill_elapsed_us", spill_elapsed_us.to_string()),
            ("row_build_elapsed_us", row_build_elapsed_us.to_string()),
        ],
    );
}

fn estimate_session_detail_row_text_bytes(row: &SessionDetailRow) -> usize {
    row.id.len()
        + row.session_summary_id.len()
        + row.query_params.len()
        + row.cookies.len()
        + row.request_headers.len()
        + row.response_headers.len()
        + row.raw_request.as_ref().map_or(0, |value| value.len())
        + row.raw_response.as_ref().map_or(0, |value| value.len())
        + row.server_ip.as_ref().map_or(0, |value| value.len())
        + row.request_body_ref.as_ref().map_or(0, |value| value.len())
        + row.response_body_ref.as_ref().map_or(0, |value| value.len())
        + row.timing.as_ref().map_or(0, |value| value.len())
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

fn select_session_eviction_index(
    sessions: &[ProxySessionSummary],
    focused_host: Option<&str>,
) -> usize {
    let Some(focused_host) = focused_host else {
        return 0;
    };

    sessions
        .iter()
        .position(|session| session.host != focused_host)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Conversion helpers: DB rows <-> domain types
// ---------------------------------------------------------------------------

fn workspace_row_to_data(row: WorkspaceRow) -> WorkspaceData {
    WorkspaceData {
        id: row.id,
        name: row.name,
        proxy_port: row.proxy_port,
        ssl_enabled: row.ssl_enabled,
        system_proxy_enabled: row.system_proxy_enabled,
        storage_path: row.storage_path,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn rewrite_row_to_rule(row: RewriteRuleRow) -> RewriteRule {
    RewriteRule {
        id: row.id,
        enabled: row.enabled,
        name: row.name,
        note: row.note,
        priority: row.priority,
        r#match: RewriteRuleMatch {
            methods: serde_json::from_str(&row.match_methods).unwrap_or_default(),
            stage: row.match_stage,
            url_pattern: row.match_url_pattern,
        },
        rewrite_type: row.rewrite_type,
        workspace_id: row.workspace_id,
        payload: serde_json::from_str(&row.payload).unwrap_or(serde_json::Value::Null),
    }
}

fn map_row_to_rule(row: MapRuleRow) -> MapRule {
    MapRule {
        id: row.id,
        enabled: row.enabled,
        mode: row.mode,
        name: row.name,
        note: row.note,
        preserve_path: row.preserve_path,
        preserve_query: row.preserve_query,
        priority: row.priority,
        source_pattern: row.source_pattern,
        target_value: row.target_value,
        workspace_id: row.workspace_id,
    }
}

fn throttle_row_to_profile(row: ThrottleProfileRow) -> ThrottleProfileData {
    ThrottleProfileData {
        id: row.id,
        download_kbps: row.download_kbps,
        enabled: row.enabled,
        latency_ms: row.latency_ms,
        name: row.name,
        note: row.note,
        packet_loss_ratio: row.packet_loss_ratio,
        preset: row.preset,
        upload_kbps: row.upload_kbps,
        workspace_id: row.workspace_id,
    }
}

fn breakpoint_row_to_rule(row: BreakpointRuleRow) -> BreakpointRule {
    BreakpointRule {
        id: row.id,
        enabled: row.enabled,
        url_pattern: row.url_pattern,
        methods: serde_json::from_str(&row.methods).unwrap_or_default(),
        stage: match row.stage.as_str() {
            "Response" => BreakpointStage::Response,
            _ => BreakpointStage::Request,
        },
    }
}

fn summary_row_to_proxy(row: SessionSummaryRow) -> ProxySessionSummary {
    ProxySessionSummary {
        id: row.id,
        method: row.method,
        host: row.host,
        path: row.path,
        protocol: row.protocol,
        started_at: row.started_at,
        finished_at: row.finished_at,
        duration_ms: row.duration_ms,
        size_bytes: row.size_bytes,
        status_code: row.status_code,
        url: row.url,
        response_mime_type: row.response_mime_type,
    }
}

fn detail_row_to_proxy(
    row: &SessionDetailRow,
    summary: ProxySessionSummary,
    body_store: &BodyStore,
) -> ProxySessionDetail {
    use aiproxy_proxy_core::{ProxyBodyReference, ProxyHeaderEntry, ProxyTimingBreakdown};

    let headers_from_json = |json: &str| -> Vec<ProxyHeaderEntry> {
        serde_json::from_str(json).unwrap_or_default()
    };

    let body_ref_from_json = |json: Option<&str>| -> Option<ProxyBodyReference> {
        json.and_then(|j| {
            let v: serde_json::Value = serde_json::from_str(j).ok()?;
            let file_path = v
                .get("file_path")
                .and_then(|value| value.as_str())
                .map(|path| body_store.resolve_body_path(path).to_string_lossy().into_owned());

            ProxyBodyReference::from_serialized_fields(
                v.get("inline_text").and_then(|value| value.as_str()).map(String::from),
                v.get("base64_text").and_then(|value| value.as_str()).map(String::from),
                v.get("mime_type").and_then(|value| value.as_str()).map(String::from),
                v.get("encoding").and_then(|value| value.as_str()).map(String::from),
                v.get("size_bytes").and_then(|value| value.as_u64()).unwrap_or(0) as usize,
                v.get("truncated").and_then(|value| value.as_bool()).unwrap_or(false),
                file_path,
            )
        })
    };

    let timing = row.timing.as_ref().and_then(|j| {
        let v: serde_json::Value = serde_json::from_str(j).ok()?;
        Some(ProxyTimingBreakdown {
            connect_ms: v.get("connect_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
            dns_ms: v.get("dns_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
            request_send_ms: v.get("request_send_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
            response_read_ms: v.get("response_read_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
            tls_ms: v.get("tls_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
            total_ms: v.get("total_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
            waiting_ms: v.get("waiting_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
        })
    });

    ProxySessionDetail {
        id: row.session_summary_id.clone(),
        query_params: headers_from_json(&row.query_params),
        cookies: headers_from_json(&row.cookies),
        raw_request_head: row.raw_request.as_deref().map(extract_raw_message_head),
        raw_response_head: row.raw_response.as_deref().map(extract_raw_message_head),
        request_body: body_ref_from_json(row.request_body_ref.as_deref()),
        request_headers: headers_from_json(&row.request_headers),
        response_body: body_ref_from_json(row.response_body_ref.as_deref()),
        response_headers: headers_from_json(&row.response_headers),
        server_ip: row.server_ip.clone(),
        script_traces: Vec::new(),
        summary,
        timing,
    }
}

fn proxy_summary_to_row(summary: &ProxySessionSummary) -> SessionSummaryRow {
    SessionSummaryRow {
        id: summary.id.clone(),
        method: summary.method.clone(),
        host: summary.host.clone(),
        path: summary.path.clone(),
        protocol: summary.protocol.clone(),
        started_at: summary.started_at.clone(),
        finished_at: summary.finished_at.clone(),
        duration_ms: summary.duration_ms,
        size_bytes: summary.size_bytes,
        status_code: summary.status_code,
        url: summary.url.clone(),
        response_mime_type: summary.response_mime_type.clone(),
    }
}

fn proxy_detail_to_row(detail: &ProxySessionDetail, body_store: &BodyStore) -> SessionDetailRow {
    let body_to_json = |body: &Option<aiproxy_proxy_core::ProxyBodyReference>| -> Option<String> {
        body.as_ref().map(|b| {
            let mut body_json = serde_json::json!({
                "size_bytes": b.size_bytes,
                "truncated": b.truncated,
            });
            if let Some(ref mime) = b.mime_type {
                body_json["mime_type"] = serde_json::Value::String(mime.clone());
            }
            if let Some(ref enc) = b.encoding {
                body_json["encoding"] = serde_json::Value::String(enc.clone());
            }
            if let Some(file_path) = b.file_path() {
                if let Some(relative_path) = body_store.relative_body_path(std::path::Path::new(file_path)) {
                    body_json["file_path"] = serde_json::Value::String(relative_path);
                }
            } else {
                if let Some(text) = b.inline_text() {
                    body_json["inline_text"] = serde_json::Value::String(text);
                }
                if let Some(b64) = b.base64_text() {
                    body_json["base64_text"] = serde_json::Value::String(b64);
                }
            }
            body_json.to_string()
        })
    };

    let timing_json = detail.timing.as_ref().map(|t| {
        let mut v = serde_json::json!({});
        if let Some(ms) = t.connect_ms { v["connect_ms"] = serde_json::json!(ms); }
        if let Some(ms) = t.dns_ms { v["dns_ms"] = serde_json::json!(ms); }
        if let Some(ms) = t.request_send_ms { v["request_send_ms"] = serde_json::json!(ms); }
        if let Some(ms) = t.response_read_ms { v["response_read_ms"] = serde_json::json!(ms); }
        if let Some(ms) = t.tls_ms { v["tls_ms"] = serde_json::json!(ms); }
        if let Some(ms) = t.total_ms { v["total_ms"] = serde_json::json!(ms); }
        if let Some(ms) = t.waiting_ms { v["waiting_ms"] = serde_json::json!(ms); }
        v.to_string()
    });

    SessionDetailRow {
        id: format!("{}-detail", detail.id),
        session_summary_id: detail.id.clone(),
        query_params: serde_json::to_string(&detail.query_params).unwrap_or_else(|_| "[]".into()),
        cookies: serde_json::to_string(&detail.cookies).unwrap_or_else(|_| "[]".into()),
        request_headers: serde_json::to_string(&detail.request_headers).unwrap_or_else(|_| "[]".into()),
        response_headers: serde_json::to_string(&detail.response_headers).unwrap_or_else(|_| "[]".into()),
        raw_request: detail.raw_request_head.clone(),
        raw_response: detail.raw_response_head.clone(),
        server_ip: detail.server_ip.clone(),
        request_body_ref: body_to_json(&detail.request_body),
        response_body_ref: body_to_json(&detail.response_body),
        timing: timing_json,
    }
}

fn extract_raw_message_head(raw_message: &str) -> String {
    match raw_message.find("\r\n\r\n") {
        Some(index) => raw_message[..index + 4].to_string(),
        None => raw_message.to_string(),
    }
}

fn spill_session_bodies_to_disk(
    detail: &mut ProxySessionDetail,
    body_store: &BodyStore,
) -> Result<(), String> {
    spill_body_reference_to_disk(&detail.id, "request", &mut detail.request_body, body_store)?;
    spill_body_reference_to_disk(&detail.id, "response", &mut detail.response_body, body_store)?;
    Ok(())
}

fn spill_body_reference_to_disk(
    session_id: &str,
    kind: &str,
    body: &mut Option<aiproxy_proxy_core::ProxyBodyReference>,
    body_store: &BodyStore,
) -> Result<(), String> {
    let Some(body) = body.as_mut() else {
        return Ok(());
    };

    if body.file_path().is_some() || body.size_bytes < BODY_FILE_THRESHOLD {
        return Ok(());
    }

    let Some(bytes) = body.in_memory_bytes() else {
        return Ok(());
    };

    let relative_path = body_store.write_body(session_id, kind, bytes)?;
    let full_path = body_store.resolve_body_path(&relative_path);
    body.replace_with_file_path(full_path.to_string_lossy().into_owned());
    Ok(())
}

fn dns_mapping_row_to_rule(row: DnsMappingRow) -> DnsMappingRule {
    DnsMappingRule {
        id: row.id,
        enabled: row.enabled,
        name: row.name,
        note: row.note,
        priority: row.priority,
        host_pattern: row.host_pattern,
        target_ip: row.target_ip,
        workspace_id: row.workspace_id,
    }
}

fn script_row_to_rule(row: ScriptRuleRow) -> CompiledScriptRule {
    let language = match row.language.as_str() {
        "typescript" => ScriptRuleLanguage::TypeScript,
        _ => ScriptRuleLanguage::JavaScript,
    };
    let source_type = match row.source_type.as_str() {
        "fileImport" => ScriptRuleSourceType::FileImport,
        _ => ScriptRuleSourceType::Inline,
    };
    let entrypoints: ScriptEntrypoints = serde_json::from_str(&row.entrypoints).unwrap_or(ScriptEntrypoints {
        on_request: false,
        on_response: false,
    });

    CompiledScriptRule {
        rule: ScriptRule {
            id: row.id,
            workspace_id: row.workspace_id,
            name: row.name,
            note: row.note,
            enabled: row.enabled,
            priority: row.priority,
            r#match: aiproxy_proxy_core::ScriptRuleMatch {
                url_pattern: row.match_url_pattern,
                methods: serde_json::from_str(&row.match_methods).unwrap_or_default(),
                stage: row.match_stage,
            },
            language,
            source_type,
            source_code: row.source_code,
            source_path: row.source_path,
            entrypoints,
        },
        compiled_code: row.compiled_code,
        source_map: row.source_map,
    }
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
            trace.entries.iter().enumerate().map(move |(entry_index, entry)| ScriptRunEntryRow {
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

#[cfg(test)]
mod tests {
    use super::{proxy_detail_to_row, proxy_summary_to_row, select_session_eviction_index, AppState};
    use aiproxy_db::body_store::BodyStore;
    use aiproxy_proxy_core::{ProxySessionDetail, ProxySessionSummary};
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    #[test]
    fn evicts_oldest_unfocused_session_before_focused_one() {
        let sessions = vec![
            build_summary("1", "api.example.com"),
            build_summary("2", "static.example.com"),
            build_summary("3", "api.example.com"),
        ];

        assert_eq!(
            select_session_eviction_index(&sessions, Some("api.example.com")),
            1
        );
    }

    #[test]
    fn falls_back_to_oldest_session_when_all_hosts_are_focused() {
        let sessions = vec![
            build_summary("1", "api.example.com"),
            build_summary("2", "api.example.com"),
        ];

        assert_eq!(
            select_session_eviction_index(&sessions, Some("api.example.com")),
            0
        );
    }

    #[test]
    fn falls_back_to_oldest_session_when_no_focus_exists() {
        let sessions = vec![
            build_summary("1", "api.example.com"),
            build_summary("2", "static.example.com"),
        ];

        assert_eq!(select_session_eviction_index(&sessions, None), 0);
    }

    #[test]
    fn reads_session_detail_from_db_when_summary_cache_is_missing() {
        let conn = aiproxy_db::rusqlite::Connection::open_in_memory().unwrap();
        aiproxy_db::schema::run_migrations(&conn).unwrap();

        let body_store_dir = std::env::temp_dir().join(format!("aiproxy-body-store-{}", Uuid::new_v4()));
        let body_store = Arc::new(BodyStore::new(body_store_dir.clone()));
        body_store.ensure_dir().unwrap();

        let summary = build_summary("db-session", "api.example.com");
        let detail = build_detail(&summary);
        let summary_row = proxy_summary_to_row(&summary);
        let detail_row = proxy_detail_to_row(&detail, body_store.as_ref());
        aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row).unwrap();

        let state = AppState::new(Arc::new(Mutex::new(conn)), body_store);
        state
            .sessions
            .lock()
            .expect("session list mutex should not be poisoned")
            .clear();
        state
            .session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .clear();

        let loaded = state.read_session_detail("db-session").expect("detail should load from db");

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
            id: summary.id.clone(),
            query_params: Vec::new(),
            cookies: Vec::new(),
            raw_request_head: Some("GET / HTTP/1.1".to_string()),
            raw_response_head: Some("HTTP/1.1 200 OK".to_string()),
            request_body: None,
            request_headers: Vec::new(),
            response_body: None,
            response_headers: Vec::new(),
            server_ip: Some("1.2.3.4".to_string()),
            script_traces: Vec::new(),
            summary: summary.clone(),
            timing: None,
        }
    }
}
