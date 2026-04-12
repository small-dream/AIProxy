use pharles_proxy_core::{ProxyServerHandle, ProxySessionDetail, ProxySessionSummary, TlsManager};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::async_runtime::JoinHandle;

use crate::system_proxy::SystemProxySnapshot;

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

    pub fn insert_session(&self, session_detail: ProxySessionDetail) {
        let session_id = session_detail.id.clone();
        let session_summary = session_detail.summary.clone();

        self.session_details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .insert(session_id, session_detail);

        let mut sessions = self
            .sessions
            .lock()
            .expect("session list mutex should not be poisoned");

        sessions.insert(0, session_summary);

        while sessions.len() > 500 {
            if let Some(removed_session) = sessions.pop() {
                self.session_details
                    .lock()
                    .expect("session detail mutex should not be poisoned")
                    .remove(&removed_session.id);
            }
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
}
