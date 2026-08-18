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
    /// Hostnames for which SSL decryption is disabled while `ssl_enabled`
    /// stays on (privacy / certificate-pinning escape hatch). IPC-facing array
    /// form, persisted as a JSON-encoded TEXT column in the DB.
    pub ssl_blind_hosts: Vec<String>,
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
            ssl_blind_hosts: Vec::new(),
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
            ssl_blind_hosts: Vec::new(),
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
        ssl_blind_hosts: Option<Vec<String>>,
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
        if let Some(hosts) = ssl_blind_hosts {
            workspace.ssl_blind_hosts = hosts;
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

    /// Overwrite the in-memory workspace with `snapshot` in full.
    ///
    /// Used to roll back after a failed DB write, where the patch-style
    /// [`WorkspaceManager::update`] cannot express the restore: `None` there
    /// means "field not present in this update", so a previously-unconfigured
    /// `upstream_proxy`/`ssl_proxying` (snapshot value `None`) would leave the
    /// never-persisted edit in memory — exactly the drift the rollback exists
    /// to prevent.
    pub fn restore(&self, snapshot: &WorkspaceData) -> Result<(), String> {
        let mut workspaces = self
            .workspaces
            .lock()
            .unwrap_or_else(|e| recover_guard(e, "workspace_list"));

        let workspace = workspaces
            .iter_mut()
            .find(|w| w.id == snapshot.id)
            .ok_or_else(|| format!("workspace {} not found", snapshot.id))?;

        *workspace = snapshot.clone();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{WorkspaceData, WorkspaceManager};

    fn sample(id: &str) -> WorkspaceData {
        WorkspaceData {
            id: id.to_string(),
            name: "Sample".to_string(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: Vec::new(),
            ssl_blind_hosts: Vec::new(),
            upstream_proxy: None,
            ssl_proxying: None,
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn restore_clears_fields_the_patch_api_cannot_clear() {
        // A workspace that never configured an upstream proxy applies an edit
        // in memory, then the DB write fails. The rollback must be able to put
        // `None` back — `update` would read the snapshot's `None` as "leave
        // unchanged" and keep the never-persisted settings in memory.
        let manager = WorkspaceManager::new();
        manager.set_workspaces(vec![sample("default")]);
        let before = manager.load("default").expect("workspace");

        let proxy = aiproxy_proxy_core::UpstreamProxySettings {
            enabled: true,
            protocol: aiproxy_proxy_core::UpstreamProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: 7890,
            username: None,
            password: None,
            bypass: Vec::new(),
        };
        manager
            .update(
                "default",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(proxy),
                None,
            )
            .expect("update");

        assert!(manager.load("default").unwrap().upstream_proxy.is_some());

        manager.restore(&before).expect("restore");

        let rolled_back = manager.load("default").expect("workspace");
        assert!(
            rolled_back.upstream_proxy.is_none(),
            "restore must clear the never-persisted upstream proxy"
        );
        assert!(
            rolled_back.updated_at == before.updated_at,
            "restore puts back the snapshot, including its timestamp"
        );
    }

    #[test]
    fn restore_reports_unknown_workspaces() {
        let manager = WorkspaceManager::new();
        assert!(manager.restore(&sample("missing")).is_err());
    }
}
