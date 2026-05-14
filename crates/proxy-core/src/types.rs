use super::*;
use crate::{MapTrace, RewriteTrace, ThrottleTrace};
use aiproxy_rule_engine::ScriptTrace;
use serde::ser::SerializeStruct;
use std::mem::size_of;

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
pub struct ProxyProtocolMetadata {
    pub scheme: String,
    pub http_version: String,
    pub transport_protocol: String,
    pub application_protocol: String,
}

pub fn infer_protocol_metadata(protocol: &str, url: &str) -> ProxyProtocolMetadata {
    let normalized_protocol = protocol.trim().to_ascii_lowercase();
    let url_scheme = Url::parse(url)
        .ok()
        .map(|parsed_url| parsed_url.scheme().to_ascii_lowercase());

    let scheme = match normalized_protocol.as_str() {
        "http" | "https" => normalized_protocol.clone(),
        "ws" => "http".to_string(),
        "wss" => "https".to_string(),
        _ => url_scheme
            .as_deref()
            .and_then(|scheme| match scheme {
                "http" | "https" => Some(scheme.to_string()),
                _ => None,
            })
            .unwrap_or_else(|| "http".to_string()),
    };

    let http_version = if let Some(version) = protocol.trim().strip_prefix("HTTP/") {
        version.to_string()
    } else {
        match normalized_protocol.as_str() {
            "2" | "h2" | "http2" => "2".to_string(),
            "3" | "h3" | "http3" => "3".to_string(),
            candidate
                if candidate.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
                    && !candidate.is_empty() =>
            {
                candidate.to_string()
            }
            _ => "1.1".to_string(),
        }
    };

    let transport_protocol =
        if http_version == "3" || matches!(normalized_protocol.as_str(), "h3" | "http3") {
            "quic".to_string()
        } else {
            "tcp".to_string()
        };

    let application_protocol = match normalized_protocol.as_str() {
        "ws" | "wss" => "websocket".to_string(),
        "grpc" => "grpc".to_string(),
        "grpc-web" => "grpc-web".to_string(),
        _ => "http".to_string(),
    };

    ProxyProtocolMetadata {
        scheme,
        http_version,
        transport_protocol,
        application_protocol,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxySessionSummary {
    pub id: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub protocol: String,
    pub scheme: String,
    pub http_version: String,
    pub transport_protocol: String,
    pub application_protocol: String,
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProxyBodyStorage {
    InMemory(Arc<[u8]>),
    FilePath(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyBodyReference {
    storage: ProxyBodyStorage,
    pub encoding: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: usize,
    pub truncated: bool,
    render_as_text: bool,
}

impl ProxyBodyReference {
    pub fn from_decoded_bytes(
        bytes: Vec<u8>,
        mime_type: Option<String>,
        size_bytes: usize,
        truncated: bool,
        render_as_text: bool,
    ) -> Self {
        Self {
            storage: ProxyBodyStorage::InMemory(Arc::<[u8]>::from(bytes)),
            encoding: render_as_text.then(|| "utf-8".to_string()),
            mime_type,
            size_bytes,
            truncated,
            render_as_text,
        }
    }

    pub fn from_file_path(
        file_path: String,
        mime_type: Option<String>,
        encoding: Option<String>,
        size_bytes: usize,
        truncated: bool,
        render_as_text: bool,
    ) -> Self {
        Self {
            storage: ProxyBodyStorage::FilePath(file_path),
            encoding,
            mime_type,
            size_bytes,
            truncated,
            render_as_text,
        }
    }

    pub fn from_serialized_fields(
        inline_text: Option<String>,
        base64_text: Option<String>,
        mime_type: Option<String>,
        encoding: Option<String>,
        size_bytes: usize,
        truncated: bool,
        file_path: Option<String>,
    ) -> Option<Self> {
        if let Some(path) = file_path {
            return Some(Self::from_file_path(
                path,
                mime_type,
                encoding.clone(),
                size_bytes,
                truncated,
                encoding.is_some(),
            ));
        }

        let decoded_bytes = if let Some(base64_text) = base64_text {
            BASE64_STANDARD.decode(base64_text).ok()
        } else {
            inline_text.map(String::into_bytes)
        }?;

        Some(Self::from_decoded_bytes(
            decoded_bytes,
            mime_type,
            size_bytes,
            truncated,
            encoding.is_some(),
        ))
    }

    pub fn in_memory_bytes(&self) -> Option<&[u8]> {
        match &self.storage {
            ProxyBodyStorage::InMemory(bytes) => Some(bytes.as_ref()),
            ProxyBodyStorage::FilePath(_) => None,
        }
    }

    pub fn file_path(&self) -> Option<&str> {
        match &self.storage {
            ProxyBodyStorage::InMemory(_) => None,
            ProxyBodyStorage::FilePath(path) => Some(path.as_str()),
        }
    }

    pub fn replace_with_file_path(&mut self, file_path: String) {
        self.storage = ProxyBodyStorage::FilePath(file_path);
    }

    pub fn can_render_as_text(&self) -> bool {
        self.render_as_text
    }

    pub fn inline_text(&self) -> Option<String> {
        if !self.render_as_text {
            return None;
        }

        Some(String::from_utf8_lossy(&self.load_bytes().ok()?).to_string())
    }

    pub fn base64_text(&self) -> Option<String> {
        Some(BASE64_STANDARD.encode(self.load_bytes().ok()?))
    }

    pub fn lossily_rendered_body(&self) -> Option<String> {
        Some(String::from_utf8_lossy(&self.load_bytes().ok()?).to_string())
    }

    pub fn storage_kind(&self) -> &'static str {
        match &self.storage {
            ProxyBodyStorage::InMemory(_) => "memory",
            ProxyBodyStorage::FilePath(_) => "file",
        }
    }

    pub fn resident_memory_bytes_estimate(&self) -> usize {
        size_of::<Self>()
            + self.encoding.as_ref().map_or(0, String::capacity)
            + self.mime_type.as_ref().map_or(0, String::capacity)
            + match &self.storage {
                ProxyBodyStorage::InMemory(bytes) => bytes.len(),
                ProxyBodyStorage::FilePath(path) => path.capacity(),
            }
    }

    fn load_bytes(&self) -> Result<Vec<u8>, String> {
        match &self.storage {
            ProxyBodyStorage::InMemory(bytes) => Ok(bytes.to_vec()),
            ProxyBodyStorage::FilePath(path) => {
                fs::read(path).map_err(|error| format!("read body file {path}: {error}"))
            }
        }
    }
}

impl Serialize for ProxyBodyReference {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let loaded_bytes = self.load_bytes().ok();
        let inline_text = if self.render_as_text {
            loaded_bytes
                .as_deref()
                .map(|bytes| String::from_utf8_lossy(bytes).to_string())
        } else {
            None
        };
        let base64_text = loaded_bytes
            .as_deref()
            .map(|bytes| BASE64_STANDARD.encode(bytes));
        let field_count = 2
            + usize::from(self.encoding.is_some())
            + usize::from(self.mime_type.is_some())
            + usize::from(self.truncated)
            + usize::from(inline_text.is_some())
            + usize::from(base64_text.is_some());
        let mut state = serializer.serialize_struct("ProxyBodyReference", field_count)?;

        if let Some(base64_text) = base64_text {
            state.serialize_field("base64Text", &base64_text)?;
        }
        if let Some(encoding) = &self.encoding {
            state.serialize_field("encoding", encoding)?;
        }
        if let Some(inline_text) = inline_text {
            state.serialize_field("inlineText", &inline_text)?;
        }
        if let Some(mime_type) = &self.mime_type {
            state.serialize_field("mimeType", mime_type)?;
        }
        state.serialize_field("sizeBytes", &self.size_bytes)?;
        if self.truncated {
            state.serialize_field("truncated", &self.truncated)?;
        }
        state.end()
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxySessionDetail {
    pub client_address: Option<String>,
    pub cookies: Vec<ProxyHeaderEntry>,
    pub id: String,
    pub query_params: Vec<ProxyHeaderEntry>,
    pub raw_request_head: Option<String>,
    pub raw_response_head: Option<String>,
    pub request_body: Option<ProxyBodyReference>,
    pub request_headers: Vec<ProxyHeaderEntry>,
    pub response_body: Option<ProxyBodyReference>,
    pub response_headers: Vec<ProxyHeaderEntry>,
    pub map_traces: Vec<MapTrace>,
    pub rewrite_traces: Vec<RewriteTrace>,
    pub server_ip: Option<String>,
    pub tls_cipher_suite: Option<String>,
    pub tls_protocol: Option<String>,
    pub summary: ProxySessionSummary,
    pub script_traces: Vec<ScriptTrace>,
    pub throttle_traces: Vec<ThrottleTrace>,
    pub timing: Option<ProxyTimingBreakdown>,
}

impl ProxySessionDetail {
    pub fn raw_request_text(&self) -> Option<String> {
        render_raw_http_message(self.raw_request_head.as_deref(), self.request_body.as_ref())
    }

    pub fn raw_response_text(&self) -> Option<String> {
        render_raw_http_message(
            self.raw_response_head.as_deref(),
            self.response_body.as_ref(),
        )
    }

    pub fn resident_memory_bytes_estimate(&self) -> usize {
        size_of::<Self>()
            + self.client_address.as_ref().map_or(0, String::capacity)
            + self.tls_cipher_suite.as_ref().map_or(0, String::capacity)
            + self.tls_protocol.as_ref().map_or(0, String::capacity)
            + estimate_header_entries_memory(&self.cookies)
            + self.id.capacity()
            + estimate_header_entries_memory(&self.query_params)
            + self.raw_request_head.as_ref().map_or(0, String::capacity)
            + self.raw_response_head.as_ref().map_or(0, String::capacity)
            + self
                .request_body
                .as_ref()
                .map_or(0, ProxyBodyReference::resident_memory_bytes_estimate)
            + estimate_header_entries_memory(&self.request_headers)
            + self
                .response_body
                .as_ref()
                .map_or(0, ProxyBodyReference::resident_memory_bytes_estimate)
            + estimate_header_entries_memory(&self.response_headers)
            + self.map_traces.capacity() * size_of::<MapTrace>()
            + self.rewrite_traces.capacity() * size_of::<RewriteTrace>()
            + self.server_ip.as_ref().map_or(0, String::capacity)
            + self.summary.resident_memory_bytes_estimate()
            + self
                .timing
                .as_ref()
                .map_or(0, |_| size_of::<ProxyTimingBreakdown>())
            + self.script_traces.capacity() * size_of::<ScriptTrace>()
            + self.throttle_traces.capacity() * size_of::<ThrottleTrace>()
    }
}

impl Serialize for ProxySessionDetail {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("ProxySessionDetail", 17)?;
        if let Some(client_address) = &self.client_address {
            state.serialize_field("clientAddress", client_address)?;
        }
        state.serialize_field("cookies", &self.cookies)?;
        state.serialize_field("id", &self.id)?;
        state.serialize_field("queryParams", &self.query_params)?;
        if let Some(raw_request) = self.raw_request_text() {
            state.serialize_field("rawRequest", &raw_request)?;
        }
        if let Some(raw_response) = self.raw_response_text() {
            state.serialize_field("rawResponse", &raw_response)?;
        }
        if let Some(request_body) = &self.request_body {
            state.serialize_field("requestBody", request_body)?;
        }
        state.serialize_field("requestHeaders", &self.request_headers)?;
        if let Some(response_body) = &self.response_body {
            state.serialize_field("responseBody", response_body)?;
        }
        state.serialize_field("responseHeaders", &self.response_headers)?;
        state.serialize_field("mapTraces", &self.map_traces)?;
        if let Some(server_ip) = &self.server_ip {
            state.serialize_field("serverIp", server_ip)?;
        }
        if let Some(tls_cipher_suite) = &self.tls_cipher_suite {
            state.serialize_field("tlsCipherSuite", tls_cipher_suite)?;
        }
        if let Some(tls_protocol) = &self.tls_protocol {
            state.serialize_field("tlsProtocol", tls_protocol)?;
        }
        state.serialize_field("summary", &self.summary)?;
        state.serialize_field("throttleTraces", &self.throttle_traces)?;
        if let Some(timing) = &self.timing {
            state.serialize_field("timing", timing)?;
        }
        state.end()
    }
}

fn render_raw_http_message(
    head: Option<&str>,
    body: Option<&ProxyBodyReference>,
) -> Option<String> {
    let mut message = head?.to_string();
    if let Some(body) = body.and_then(ProxyBodyReference::lossily_rendered_body) {
        message.push_str(&body);
    }
    Some(message)
}

fn estimate_header_entries_memory(entries: &[ProxyHeaderEntry]) -> usize {
    entries.len() * size_of::<ProxyHeaderEntry>()
        + entries
            .iter()
            .map(|entry| entry.name.capacity() + entry.value.capacity())
            .sum::<usize>()
}

impl ProxySessionSummary {
    pub fn resident_memory_bytes_estimate(&self) -> usize {
        size_of::<Self>()
            + self.id.capacity()
            + self.method.capacity()
            + self.host.capacity()
            + self.path.capacity()
            + self.protocol.capacity()
            + self.scheme.capacity()
            + self.http_version.capacity()
            + self.transport_protocol.capacity()
            + self.application_protocol.capacity()
            + self.started_at.capacity()
            + self.finished_at.capacity()
            + self.url.capacity()
            + self.response_mime_type.as_ref().map_or(0, String::capacity)
    }
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
    pub session_receiver: mpsc::Receiver<ProxySessionDetail>,
    pub ws_message_receiver: mpsc::Receiver<crate::ws::WsMessageData>,
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
    pub(crate) client_address: Option<String>,
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
    pub(crate) tls_cipher_suite: Option<String>,
    pub(crate) tls_protocol: Option<String>,
}

#[derive(Debug)]
pub(crate) struct UpstreamResponse {
    pub(crate) body_truncated: bool,
    pub(crate) response_body: Vec<u8>,
    pub(crate) response_body_size_bytes: usize,
    pub(crate) response_headers: HeaderMap,
    pub(crate) response_read_ms: u128,
    pub(crate) spooled_response_path: Option<PathBuf>,
    pub(crate) status_code: StatusCode,
    pub(crate) waiting_ms: u128,
}

impl UpstreamResponse {
    pub(crate) fn clear_spooled_response(&mut self) {
        if let Some(path) = self.spooled_response_path.take() {
            let _ = fs::remove_file(path);
        }
    }

    pub(crate) fn replace_response_body(&mut self, body: Vec<u8>) {
        self.clear_spooled_response();
        self.response_body_size_bytes = body.len();
        self.response_body = body;
        self.body_truncated = false;
    }
}

impl Drop for UpstreamResponse {
    fn drop(&mut self) {
        self.clear_spooled_response();
    }
}
