use super::*;

pub struct ProxyRuntimeConfig {
    pub port: u16,
    pub ssl_enabled: bool,
}

impl ProxyRuntimeConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.port == 0 {
            return Err("proxy port must be greater than zero");
        }

        Ok(())
    }
}

/// Returns the local network IP addresses of this machine.
/// Used to tell mobile devices what IP to configure as their proxy.
pub fn get_local_ip_addresses() -> Vec<String> {
    let mut ips = Vec::new();

    // Use a UDP socket trick to find the preferred outbound local IP.
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        // connect() doesn't actually send data, it just selects the route
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                let ip = local_addr.ip().to_string();
                if ip != "0.0.0.0" {
                    ips.push(ip);
                }
            }
        }
    }

    ips
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionSummary {
    pub id: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub protocol: String,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u128,
    pub size_bytes: usize,
    pub status_code: u16,
    pub url: String,
    pub response_mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHeaderEntry {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyBodyReference {
    pub base64_text: Option<String>,
    pub encoding: Option<String>,
    pub inline_text: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTimingBreakdown {
    pub connect_ms: Option<u128>,
    pub dns_ms: Option<u128>,
    pub request_send_ms: Option<u128>,
    pub response_read_ms: Option<u128>,
    pub tls_ms: Option<u128>,
    pub total_ms: Option<u128>,
    pub waiting_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionDetail {
    pub cookies: Vec<ProxyHeaderEntry>,
    pub id: String,
    pub query_params: Vec<ProxyHeaderEntry>,
    pub raw_request: Option<String>,
    pub raw_response: Option<String>,
    pub request_body: Option<ProxyBodyReference>,
    pub request_headers: Vec<ProxyHeaderEntry>,
    pub response_body: Option<ProxyBodyReference>,
    pub response_headers: Vec<ProxyHeaderEntry>,
    pub server_ip: Option<String>,
    pub summary: ProxySessionSummary,
    pub timing: Option<ProxyTimingBreakdown>,
}

#[derive(Debug)]
pub struct ProxyServerHandle {
    pub(crate) shutdown_sender: Option<oneshot::Sender<()>>,
    pub(crate) join_handle: JoinHandle<()>,
}

impl ProxyServerHandle {
    pub async fn shutdown(mut self) {
        if let Some(shutdown_sender) = self.shutdown_sender.take() {
            let _ = shutdown_sender.send(());
        }

        let _ = self.join_handle.await;
    }
}

#[derive(Debug)]
pub struct StartedProxyServer {
    pub bound_port: u16,
    pub server_handle: ProxyServerHandle,
    pub session_receiver: mpsc::UnboundedReceiver<ProxySessionDetail>,
}

/// TLS manager for HTTPS MITM interception.
pub struct TlsManager {
    pub root_ca: aiproxy_tls_manager::RootCaPair,
    pub storage: Arc<aiproxy_tls_manager::CertStorage>,
    pub server_config: Arc<tokio_rustls::rustls::ServerConfig>,
}

impl std::fmt::Debug for TlsManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsManager").finish()
    }
}

#[derive(Debug)]
pub(crate) struct ParsedProxyRequest {
    pub(crate) body: Vec<u8>,
    pub(crate) headers: HeaderMap,
    pub(crate) host: String,
    pub(crate) method: Method,
    pub(crate) path: String,
    pub(crate) protocol: String,
    pub(crate) query_params: Vec<ProxyHeaderEntry>,
    pub(crate) raw_request: String,
    pub(crate) request_headers: Vec<ProxyHeaderEntry>,
    pub(crate) request_id: String,
    pub(crate) url: Url,
}

#[derive(Debug)]
pub(crate) struct UpstreamResponse {
    pub(crate) response_body: Vec<u8>,
    pub(crate) response_headers: HeaderMap,
    pub(crate) response_read_ms: u128,
    pub(crate) status_code: StatusCode,
    pub(crate) waiting_ms: u128,
}
