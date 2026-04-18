use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Workspace data stored in memory, matching the TypeScript `Workspace` contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceData {
    pub id: String,
    pub name: String,
    pub proxy_port: u16,
    pub ssl_enabled: bool,
    pub system_proxy_enabled: bool,
    pub storage_path: String,
    pub created_at: String,
    pub updated_at: String,
}

/// In-memory workspace manager. Follows the same pattern as `RewriteManager`,
/// `MapManager`, and `ThrottleManager` in `proxy-core`.
#[derive(Debug)]
pub struct WorkspaceManager {
    workspaces: Mutex<Vec<WorkspaceData>>,
}

impl WorkspaceManager {
    pub fn new() -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        let default_workspace = WorkspaceData {
            id: "default".to_string(),
            name: "Default".to_string(),
            proxy_port: 8888,
            ssl_enabled: false,
            system_proxy_enabled: false,
            storage_path: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };

        Self {
            workspaces: Mutex::new(vec![default_workspace]),
        }
    }

    pub fn set_workspaces(&self, workspaces: Vec<WorkspaceData>) {
        let mut guard = self
            .workspaces
            .lock()
            .expect("workspace list mutex should not be poisoned");
        *guard = workspaces;
    }

    pub fn list(&self) -> Vec<WorkspaceData> {
        self.workspaces
            .lock()
            .expect("workspace list mutex should not be poisoned")
            .clone()
    }

    pub fn create(&self, name: String, proxy_port: u16, ssl_enabled: bool) -> WorkspaceData {
        let now = chrono::Utc::now().to_rfc3339();
        let timestamp = now.replace(['-', ':', '.'], "");
        let random_suffix: String = std::iter::repeat_with(|| {
            let idx = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos()
                % 36) as usize;
            b"0123456789abcdefghijklmnopqrstuvwxyz"[idx] as char
        })
        .take(8)
        .collect();

        let workspace = WorkspaceData {
            id: format!("ws-{timestamp}-{random_suffix}"),
            name,
            proxy_port,
            ssl_enabled,
            system_proxy_enabled: false,
            storage_path: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };

        self.workspaces
            .lock()
            .expect("workspace list mutex should not be poisoned")
            .push(workspace.clone());

        workspace
    }

    pub fn load(&self, workspace_id: &str) -> Option<WorkspaceData> {
        self.workspaces
            .lock()
            .expect("workspace list mutex should not be poisoned")
            .iter()
            .find(|w| w.id == workspace_id)
            .cloned()
    }

    pub fn update(
        &self,
        workspace_id: &str,
        name: Option<String>,
        proxy_port: Option<u16>,
        ssl_enabled: Option<bool>,
    ) -> Result<WorkspaceData, String> {
        let mut workspaces = self
            .workspaces
            .lock()
            .expect("workspace list mutex should not be poisoned");

        let workspace = workspaces
            .iter_mut()
            .find(|w| w.id == workspace_id)
            .ok_or_else(|| format!("workspace {} not found", workspace_id))?;

        if let Some(name) = name {
            workspace.name = name;
        }
        if let Some(port) = proxy_port {
            workspace.proxy_port = port;
        }
        if let Some(ssl) = ssl_enabled {
            workspace.ssl_enabled = ssl;
        }

        workspace.updated_at = chrono::Utc::now().to_rfc3339();

        Ok(workspace.clone())
    }
}
