use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::bootstrap::lock_recovery::recover_guard;

/// Workspace data stored in memory, matching the TypeScript `Workspace` contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceData {
    pub id: String,
    pub name: String,
    pub proxy_port: u16,
    pub ssl_enabled: bool,
    pub http2_enabled: bool,
    pub system_proxy_enabled: bool,
    /// H3: verify upstream TLS certificates against the system root store on
    /// new connections. Defaults to false (NoOp verifier) for compatibility.
    pub verify_upstream_tls: bool,
    /// H3: hostnames always TLS-verified even when `verify_upstream_tls` is
    /// false. This is the IPC-facing array form (serde-serializes as a JSON
    /// array over the wire); the DB column stores it as a JSON-encoded string,
    /// and the converter (de)serializes between the two.
    pub tls_verify_hosts: Vec<String>,
    /// Upstream (chained) proxy settings, or `None` when never configured.
    /// The DB column stores this as a JSON string; the converter (de)serializes
    /// between the two, mirroring `tls_verify_hosts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_proxy: Option<aiproxy_proxy_core::UpstreamProxySettings>,
    /// Per-host SSL proxying policy, or `None` when never configured — which
    /// resolves to the built-in defaults at proxy start rather than to two
    /// empty lists. Stored and transported like `upstream_proxy`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_proxying: Option<aiproxy_proxy_core::SslProxyingSettings>,
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
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: Vec::new(),
            upstream_proxy: None,
            ssl_proxying: None,
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
            .unwrap_or_else(|e| recover_guard(e, "workspace_list"));
        *guard = workspaces;
    }

    pub fn list(&self) -> Vec<WorkspaceData> {
        self.workspaces
            .lock()
            .unwrap_or_else(|e| recover_guard(e, "workspace_list"))
            .clone()
    }

    pub fn create(
        &self,
        name: String,
        proxy_port: u16,
        ssl_enabled: bool,
        http2_enabled: bool,
    ) -> WorkspaceData {
        let now = chrono::Utc::now().to_rfc3339();
        let timestamp = now.replace(['-', ':', '.'], "");
        let random_suffix = uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("00000000")
            .to_string();

        let workspace = WorkspaceData {
            id: format!("ws-{timestamp}-{random_suffix}"),
            name,
            proxy_port,
            ssl_enabled,
            http2_enabled,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: Vec::new(),
            upstream_proxy: None,
            ssl_proxying: None,
            storage_path: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };

        self.workspaces
            .lock()
            .unwrap_or_else(|e| recover_guard(e, "workspace_list"))
            .push(workspace.clone());

        workspace
    }

    pub fn load(&self, workspace_id: &str) -> Option<WorkspaceData> {
        self.workspaces
            .lock()
            .unwrap_or_else(|e| recover_guard(e, "workspace_list"))
            .iter()
            .find(|w| w.id == workspace_id)
            .cloned()
    }

    /// Remove a workspace from the in-memory list. Used to roll back an
    /// in-memory `create` when the DB persistence fails, so the in-memory state
    /// never advertises a workspace that won't survive a restart.
    pub fn remove(&self, workspace_id: &str) {
        let mut workspaces = self
            .workspaces
            .lock()
            .unwrap_or_else(|e| recover_guard(e, "workspace_list"));
        workspaces.retain(|w| w.id != workspace_id);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        workspace_id: &str,
        name: Option<String>,
        proxy_port: Option<u16>,
        ssl_enabled: Option<bool>,
        http2_enabled: Option<bool>,
        verify_upstream_tls: Option<bool>,
        tls_verify_hosts: Option<Vec<String>>,
        upstream_proxy: Option<aiproxy_proxy_core::UpstreamProxySettings>,
        ssl_proxying: Option<aiproxy_proxy_core::SslProxyingSettings>,
    ) -> Result<WorkspaceData, String> {
        let mut workspaces = self
            .workspaces
            .lock()
            .unwrap_or_else(|e| recover_guard(e, "workspace_list"));

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
        if let Some(h2) = http2_enabled {
            workspace.http2_enabled = h2;
        }
        if let Some(verify) = verify_upstream_tls {
            workspace.verify_upstream_tls = verify;
        }
        if let Some(hosts) = tls_verify_hosts {
            workspace.tls_verify_hosts = hosts;
        }
        if let Some(settings) = upstream_proxy {
            workspace.upstream_proxy = Some(settings);
        }
        if let Some(settings) = ssl_proxying {
            workspace.ssl_proxying = Some(settings);
        }

        workspace.updated_at = chrono::Utc::now().to_rfc3339();

        Ok(workspace.clone())
    }
}
