use pharles_proxy_core::{BreakpointManager, MapManager, ProxyServerHandle, ProxySessionDetail, ProxySessionSummary, RewriteManager, ThrottleManager, TlsManager};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{async_runtime::JoinHandle, Emitter};

use crate::system_proxy::SystemProxySnapshot;
use crate::workspace::WorkspaceManager;

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
    throttle_manager: Arc<ThrottleManager>,
    workspace_manager: Arc<WorkspaceManager>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    focused_host: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
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
            throttle_manager: Arc::new(ThrottleManager::new()),
            workspace_manager: Arc::new(WorkspaceManager::new()),
            app_handle: Mutex::new(None),
            focused_host: Mutex::new(None),
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
        self.session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .get(session_id)
            .cloned()
    }

    pub fn clear_sessions(&self) {
        self.session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .clear();

        self.sessions
            .lock()
            .expect("session list mutex should not be poisoned")
            .clear();
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

    pub fn upsert_session(&self, session_detail: ProxySessionDetail) {
        let session_id = session_detail.id.clone();
        let session_summary = session_detail.summary.clone();

        self.session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .insert(session_id.clone(), session_detail.clone());

        let mut sessions = self
            .sessions
            .lock()
            .expect("session list mutex should not be poisoned");

        if let Some(existing_index) = sessions.iter().position(|session| session.id == session_id) {
            sessions[existing_index] = session_summary;
        } else {
            sessions.push(session_summary);
        }

        let focused_host = self.read_focused_host();

        while sessions.len() > 15_000 {
            let eviction_index = select_session_eviction_index(
                &sessions,
                focused_host.as_deref(),
            );
            let removed_session = sessions.remove(eviction_index);
            self.session_details
                .lock()
                .expect("session detail mutex should not be poisoned")
                .remove(&removed_session.id);
            if let Some(handle) = self.read_app_handle() {
                let _ = handle.emit("session-remove", &removed_session.id);
            }
        }

        if let Some(handle) = self.read_app_handle() {
            let _ = handle.emit("session-upsert", session_detail);
        }
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

#[cfg(test)]
mod tests {
    use super::select_session_eviction_index;
    use pharles_proxy_core::ProxySessionSummary;

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
}
