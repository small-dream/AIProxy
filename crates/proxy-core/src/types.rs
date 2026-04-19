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
    let mut ips = ranked_interface_ipv4_addresses();

    // Use a UDP socket trick to find the preferred outbound local IP.
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        // connect() doesn't actually send data, it just selects the route
        if socket.connect(UDP_ROUTE_PROBE_ADDRESS).is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                let ip = local_addr.ip().to_string();
                if ip != "0.0.0.0" && !ips.iter().any(|candidate| candidate == &ip) {
                    ips.push(ip);
                }
            }
        }
    }

    ips
}

#[cfg(unix)]
fn ranked_interface_ipv4_addresses() -> Vec<String> {
    use std::{collections::HashSet, ffi::CStr, net::Ipv4Addr};

    let mut interface_addresses = Vec::new();
    let mut addrs = std::ptr::null_mut();

    // SAFETY: getifaddrs takes a mutable pointer to a linked list head.
    // On failure (result != 0) or null return, we bail early.
    let result = unsafe { libc::getifaddrs(&mut addrs) };
    if result != 0 || addrs.is_null() {
        return Vec::new();
    }

    let mut cursor = addrs;
    while !cursor.is_null() {
        // SAFETY: cursor is non-null and points to a valid ifaddrs node in the
        // linked list returned by getifaddrs. The list is null-terminated.
        let ifaddr = unsafe { &*cursor };

        if !ifaddr.ifa_addr.is_null() {
            // SAFETY: ifa_addr is non-null and was populated by getifaddrs.
            // We only read sa_family, which is always valid for any sockaddr variant.
            let family = unsafe { (*ifaddr.ifa_addr).sa_family as i32 };
            let flags = ifaddr.ifa_flags as i32;

            if family == libc::AF_INET
                && flags & libc::IFF_UP != 0
                && flags & libc::IFF_LOOPBACK == 0
            {
                // SAFETY: ifa_name is a valid C string populated by getifaddrs.
                let interface_name = unsafe { CStr::from_ptr(ifaddr.ifa_name) }
                    .to_string_lossy()
                    .into_owned();
                // SAFETY: We checked sa_family == AF_INET, so ifa_addr points to
                // a valid sockaddr_in. The pointer cast is sound.
                let sockaddr_in = unsafe { &*(ifaddr.ifa_addr as *const libc::sockaddr_in) };
                let ip = Ipv4Addr::from(u32::from_be(sockaddr_in.sin_addr.s_addr));

                if is_usable_ipv4(ip) {
                    interface_addresses.push((score_interface_ipv4(&interface_name, ip), ip));
                }
            }
        }

        cursor = ifaddr.ifa_next;
    }

    // SAFETY: addrs was allocated by getifaddrs and must be freed by freeifaddrs.
    // After this call, the memory is released and must not be accessed again.
    unsafe {
        libc::freeifaddrs(addrs);
    }

    interface_addresses.sort_by(|left, right| right.cmp(left));

    let mut seen = HashSet::new();
    interface_addresses
        .into_iter()
        .filter_map(|(_, ip)| {
            let ip = ip.to_string();
            if seen.insert(ip.clone()) {
                Some(ip)
            } else {
                None
            }
        })
        .collect()
}

#[cfg(not(unix))]
fn ranked_interface_ipv4_addresses() -> Vec<String> {
    Vec::new()
}

fn is_usable_ipv4(ip: std::net::Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified()
}

fn score_interface_ipv4(interface_name: &str, ip: std::net::Ipv4Addr) -> i32 {
    let octets = ip.octets();
    let mut score = if octets[0] == 192 && octets[1] == 168 {
        500
    } else if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        450
    } else if octets[0] == 10 {
        400
    } else if ip.is_private() {
        350
    } else {
        100
    };

    let lowercase_name = interface_name.to_ascii_lowercase();

    if lowercase_name.starts_with("en")
        || lowercase_name.starts_with("eth")
        || lowercase_name.starts_with("wlan")
        || lowercase_name.starts_with("wifi")
    {
        score += 100;
    }

    if lowercase_name.starts_with("utun")
        || lowercase_name.starts_with("tun")
        || lowercase_name.starts_with("tap")
        || lowercase_name.starts_with("docker")
        || lowercase_name.starts_with("veth")
        || lowercase_name.starts_with("br-")
        || lowercase_name.starts_with("bridge")
        || lowercase_name.starts_with("vmnet")
        || lowercase_name.starts_with("awdl")
        || lowercase_name.starts_with("llw")
    {
        score -= 250;
    }

    score
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
    pub ws_message_receiver: mpsc::UnboundedReceiver<crate::ws::WsMessageData>,
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
