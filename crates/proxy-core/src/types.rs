use super::*;
use crate::{MapTrace, RewriteTrace, ThrottleTrace};
use aiproxy_rule_engine::ScriptTrace;
use serde::ser::SerializeStruct;
use std::mem::size_of;

#[derive(Clone)]
pub struct ProxyRuntimeConfig {
    pub port: u16,
    pub ssl_enabled: bool,
    pub http2_enabled: Option<bool>,
    /// H3: when true the proxy verifies upstream TLS certificates against the
    /// OS root store on new upstream connections. Defaults to false (NoOp
    /// verifier) to preserve the historical debug-proxy behavior.
    pub verify_upstream_tls: bool,
    /// H3: hostnames that are always TLS-verified even when
    /// `verify_upstream_tls` is false (an allowlist of "verify these hosts
    /// regardless"). The effective verify decision per connection is
    /// `verify_upstream_tls || tls_verify_hosts.contains(host)`.
    pub tls_verify_hosts: std::sync::Arc<[String]>,
    /// Hostnames for which SSL interception (MITM) is disabled even while the
    /// workspace-level `ssl_enabled` switch is on. CONNECT tunnels to these
    /// hosts are relayed blindly (no TLS termination, no capture of the
    /// decrypted body) — a privacy control and an escape hatch for hosts whose
    /// clients pin their certificates. Hostnames are stored lowercase.
    pub ssl_blind_hosts: std::sync::Arc<[String]>,
    /// Upstream (chained) proxy. When set, outbound connections are tunneled
    /// through it instead of dialed directly — AIProxy keeps intercepting and
    /// the configured proxy performs the actual egress. `None` = direct.
    ///
    /// Shared behind an `Arc` because this config is cloned onto every
    /// connection and request path.
    pub upstream_proxy: Option<std::sync::Arc<crate::upstream_proxy::UpstreamProxyConfig>>,
    /// Which hosts get their TLS intercepted. `None` intercepts everything,
    /// preserving the behavior from before this setting existed; a host the
    /// policy rejects is relayed blind so a certificate-pinning client keeps
    /// working instead of having its connection torn down.
    ///
    /// Only consulted when `ssl_enabled` is true — with interception off there
    /// is nothing to scope.
    pub ssl_proxying: Option<std::sync::Arc<crate::ssl_proxying::SslProxyingConfig>>,
}

impl ProxyRuntimeConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("proxy port must be greater than zero".to_string());
        }

        // Fail at startup with a clear message rather than on every request.
        if let Some(upstream_proxy) = &self.upstream_proxy {
            upstream_proxy.validate()?;
        }

        Ok(())
    }
}

/// Returns the local network IP addresses of this machine.
/// Used to tell mobile devices what IP to configure as their proxy.
pub fn get_local_ip_addresses() -> Vec<String> {
    let mut ips = platform::ranked_interface_ipv4_addresses();

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
#[path = "types_unix.rs"]
mod platform;

#[cfg(windows)]
#[path = "types_windows.rs"]
mod platform;

#[cfg(not(any(unix, windows)))]
mod platform {
    pub(super) fn ranked_interface_ipv4_addresses() -> Vec<String> {
        Vec::new()
    }
}

/// Parses JSON output from PowerShell `Get-NetIPAddress | ConvertTo-Json`.
/// Handles three shapes: array `[{...}]`, single object `{...}`, and `null`.
/// Returns (InterfaceAlias, Ipv4Addr) pairs for valid entries.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_interface_json(json: &str) -> Vec<(String, std::net::Ipv4Addr)> {
    use serde_json::Value;
    use std::net::Ipv4Addr;

    let value: Value = match serde_json::from_str(json.trim()) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let objects = match value {
        Value::Array(arr) => arr,
        Value::Object(_) => vec![value],
        _ => return Vec::new(),
    };

    objects
        .into_iter()
        .filter_map(|obj| {
            let ip_str = obj.get("IPAddress")?.as_str()?;
            let ip: Ipv4Addr = ip_str.parse().ok()?;
            let alias = obj
                .get("InterfaceAlias")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some((alias, ip))
        })
        .collect()
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_pseudo: Option<bool>,
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

    /// Read the body as raw bytes, loading it from disk when the payload was
    /// spilled to the body store. Exposed publicly so exporters can write the
    /// captured payload verbatim instead of round-tripping through base64 or
    /// lossy UTF-8 rendering, which would corrupt binary responses.
    pub fn read_bytes(&self) -> Result<Vec<u8>, String> {
        self.load_bytes()
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
        let field_count = 1
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
    pub timing_source: Option<String>,
    pub trailers: Option<Vec<ProxyHeaderEntry>>,
    pub h2_stream_id: Option<u32>,
    /// Whether this request's upstream connection was tunneled through the
    /// configured upstream (chained) proxy. `None` when the routing decision is
    /// unknown for this session — a mocked/breakpoint response, a replayed
    /// session, or a blind CONNECT tunnel that produced no forwarded request.
    pub via_upstream_proxy: Option<bool>,
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
        let mut state = serializer.serialize_struct("ProxySessionDetail", 18)?;
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
        if let Some(timing_source) = &self.timing_source {
            state.serialize_field("timingSource", timing_source)?;
        }
        if let Some(trailers) = &self.trailers {
            state.serialize_field("trailers", trailers)?;
        }
        if let Some(h2_stream_id) = &self.h2_stream_id {
            state.serialize_field("h2StreamId", h2_stream_id)?;
        }
        if let Some(via_upstream_proxy) = &self.via_upstream_proxy {
            state.serialize_field("viaUpstreamProxy", via_upstream_proxy)?;
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
    std::mem::size_of_val(entries)
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

pub struct ProxyServerHandle {
    pub(crate) shutdown_sender: Option<oneshot::Sender<()>>,
    pub(crate) join_handle: JoinHandle<()>,
    pub(crate) upstream_pool: Option<Arc<crate::upstream_pool::UpstreamConnectionPool>>,
}

impl std::fmt::Debug for ProxyServerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyServerHandle").finish_non_exhaustive()
    }
}

impl ProxyServerHandle {
    pub async fn shutdown(mut self) {
        if let Some(shutdown_sender) = self.shutdown_sender.take() {
            let _ = shutdown_sender.send(());
        }

        let _ = self.join_handle.await;

        if let Some(pool) = self.upstream_pool.take() {
            pool.shutdown().await;
        }
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
    pub http2_enabled: bool,
}

impl std::fmt::Debug for TlsManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsManager").finish()
    }
}

#[derive(Clone, Debug)]
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
    pub(crate) connect_ms: u128,
    pub(crate) dns_ms: u128,
    pub(crate) request_send_ms: u128,
    pub(crate) response_body: Vec<u8>,
    pub(crate) response_body_size_bytes: usize,
    pub(crate) response_headers: HeaderMap,
    pub(crate) response_read_ms: u128,
    pub(crate) spooled_response_path: Option<PathBuf>,
    pub(crate) status_code: StatusCode,
    pub(crate) tls_ms: Option<u128>,
    pub(crate) waiting_ms: u128,
    /// Whether the connection used to send this request was tunneled through
    /// the configured upstream proxy. `None` for synthesized responses (mock,
    /// Map Local, script override) that never touched the network — reporting
    /// those as "direct" would read as "the proxy chain was skipped" when in
    /// fact no connection happened at all.
    pub(crate) via_upstream_proxy: Option<bool>,
}

impl UpstreamResponse {
    pub(crate) fn clear_spooled_response(&mut self) {
        if let Some(path) = self.spooled_response_path.take() {
            // L1: this is invoked from the Drop impl, which runs on the Tokio
            // worker thread that owned the UpstreamResponse. A blocking
            // `fs::remove_file` (slow temp dir, AV scan, networked profile)
            // would stall that worker. Offload to the blocking pool so the
            // worker stays free. If no Tokio runtime is available (e.g. during
            // process teardown after the runtime is dropped), fall back to an
            // inline remove rather than leaking the temp file.
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn_blocking(move || {
                    let _ = fs::remove_file(path);
                });
            } else {
                let _ = fs::remove_file(path);
            }
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

#[cfg(test)]
mod types_tests {
    use super::*;

    #[test]
    fn parse_interface_json_array() {
        let json = r#"[{"IPAddress":"192.168.1.100","InterfaceAlias":"Ethernet"},{"IPAddress":"10.0.0.5","InterfaceAlias":"Wi-Fi"}]"#;
        let entries = parse_interface_json(json);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "Ethernet");
        assert_eq!(entries[0].1, std::net::Ipv4Addr::new(192, 168, 1, 100));
        assert_eq!(entries[1].0, "Wi-Fi");
    }

    #[test]
    fn parse_interface_json_single_object() {
        let json = r#"{"IPAddress":"192.168.1.100","InterfaceAlias":"Ethernet"}"#;
        let entries = parse_interface_json(json);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "Ethernet");
    }

    #[test]
    fn parse_interface_json_null() {
        let entries = parse_interface_json("null");
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_interface_json_empty_string() {
        let entries = parse_interface_json("");
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_interface_json_invalid_ip_skipped() {
        let json = r#"[{"IPAddress":"not-an-ip","InterfaceAlias":"Bad"},{"IPAddress":"10.0.0.1","InterfaceAlias":"Good"}]"#;
        let entries = parse_interface_json(json);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "Good");
    }
}
