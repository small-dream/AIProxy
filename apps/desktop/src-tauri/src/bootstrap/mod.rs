use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
    pub active_workspace_id: Option<String>,
    pub port: u16,
    pub running: bool,
    pub ssl_enabled: bool,
    pub system_proxy_enabled: bool,
}

impl Default for BootstrapStatus {
    fn default() -> Self {
        Self {
            active_workspace_id: Some("default".to_string()),
            port: 8888,
            running: false,
            ssl_enabled: false,
            system_proxy_enabled: false,
        }
    }
}

#[derive(Debug)]
pub struct AppState {
    status: std::sync::Mutex<BootstrapStatus>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            status: std::sync::Mutex::new(BootstrapStatus::default()),
        }
    }

    pub fn read_status(&self) -> BootstrapStatus {
        self.status
            .lock()
            .expect("bootstrap status mutex should not be poisoned")
            .clone()
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

        status.clone()
    }

    pub fn stop_proxy(&self, workspace_id: String) -> BootstrapStatus {
        let mut status = self
            .status
            .lock()
            .expect("bootstrap status mutex should not be poisoned");

        status.running = false;
        status.active_workspace_id = Some(workspace_id);

        status.clone()
    }
}
