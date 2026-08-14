//! Upstream (chained) proxy support.
//!
//! By default AIProxy dials origin servers directly. When an upstream proxy is
//! configured, every outbound connection is instead established *through* that
//! proxy: AIProxy still terminates TLS and captures traffic, but the actual
//! egress is delegated. The motivating case is a phone that points at AIProxy
//! for interception while a local rule-based proxy (Clash, Surge, mitmproxy,
//! Charles) does the routing.
//!
//! Every supported protocol converges on one abstraction — "give me a byte
//! stream that reaches `target_host:target_port`". That keeps the change
//! confined to the dial step: TLS interception, h1/h2 selection, timing
//! collection and connection pooling downstream are untouched.
//!
//! Target addressing is deliberate. Without a DNS override we hand the upstream
//! proxy the *hostname* (SOCKS5 `ATYP=domain`, CONNECT authority) rather than a
//! locally-resolved IP, because a rule-based proxy needs the domain to match
//! its routing rules. A DNS override wins over that: pinning a host to an IP is
//! an explicit user instruction, so the override IP becomes the target.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::stream::TlsOrPlain;

/// A dialed transport that reaches the target host.
///
/// `Plain` is either a direct TCP connection to the origin, or a TCP connection
/// to an upstream proxy that has already been negotiated into a tunnel. `Tls`
/// is used only when the hop to the *proxy itself* is TLS (the `https`
/// protocol) — the target's own TLS is layered on top of this by the caller.
pub type DialedStream = TlsOrPlain<TcpStream>;

/// Upper bound on a CONNECT response head. A proxy that streams an unbounded
/// header block must not be able to grow this buffer without limit.
const MAX_CONNECT_RESPONSE_HEAD_BYTES: usize = 8 * 1024;

/// Bound on the whole proxy negotiation (TCP connect + TLS + protocol
/// handshake). A proxy that accepts the TCP connection but then stalls must not
/// hold a connection permit indefinitely.
const UPSTREAM_PROXY_DIAL_TIMEOUT: Duration = Duration::from_secs(20);

// SOCKS5 wire constants (RFC 1928).
const SOCKS5_VERSION: u8 = 0x05;
const SOCKS5_AUTH_NONE: u8 = 0x00;
const SOCKS5_AUTH_USERNAME_PASSWORD: u8 = 0x02;
const SOCKS5_AUTH_UNACCEPTABLE: u8 = 0xFF;
const SOCKS5_CMD_CONNECT: u8 = 0x01;
const SOCKS5_ATYP_IPV4: u8 = 0x01;
const SOCKS5_ATYP_DOMAIN: u8 = 0x03;
const SOCKS5_ATYP_IPV6: u8 = 0x04;
/// Version byte of the RFC 1929 username/password sub-negotiation.
const SOCKS5_AUTH_SUBNEGOTIATION_VERSION: u8 = 0x01;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Wire protocol spoken to the upstream proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpstreamProxyProtocol {
    /// Plain TCP to the proxy, then `CONNECT host:port` to open the tunnel.
    Http,
    /// TLS to the proxy first, then `CONNECT host:port` inside that TLS
    /// session. Only the hop to the proxy is protected; the target's own TLS
    /// still flows end-to-end inside the tunnel.
    Https,
    /// SOCKS5 (RFC 1928), with optional username/password auth (RFC 1929).
    Socks5,
}

impl UpstreamProxyProtocol {
    /// Stable lowercase wire/storage name. Used by the DB column and the IPC
    /// contract so the value survives a round-trip unchanged.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
            Self::Socks5 => "socks5",
        }
    }

    /// Parse a stored/IPC protocol name. Returns `None` for anything
    /// unrecognized so callers can surface a real error rather than silently
    /// falling back to a protocol the user did not pick.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "http" => Some(Self::Http),
            "https" => Some(Self::Https),
            // `socks5h` is the curl spelling for "let the proxy resolve DNS",
            // which is already our default behavior, so accept it as an alias.
            "socks5" | "socks5h" => Some(Self::Socks5),
            _ => None,
        }
    }
}

/// A resolved upstream proxy, ready to dial through.
#[derive(Debug, Clone)]
pub struct UpstreamProxyConfig {
    pub protocol: UpstreamProxyProtocol,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    /// Host patterns that bypass the upstream proxy and are dialed directly.
    /// See [`bypass_matches`] for the supported pattern syntax.
    pub bypass: Arc<[String]>,
}

impl UpstreamProxyConfig {
    /// Reject a configuration that could never dial, so the proxy fails at
    /// startup with a clear message instead of on every request.
    pub fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("upstream proxy host must not be empty".to_string());
        }
        if self.port == 0 {
            return Err("upstream proxy port must be greater than zero".to_string());
        }
        if self.username.is_none() && self.password.is_some() {
            return Err(
                "upstream proxy password was set without a username; provide both or neither"
                    .to_string(),
            );
        }
        Ok(())
    }

    /// Whether `host` should skip the upstream proxy and be dialed directly.
    pub fn should_bypass(&self, host: &str) -> bool {
        bypass_matches(&self.bypass, host)
    }

    /// `Proxy-Authorization` header value, when credentials are configured.
    fn proxy_authorization_value(&self) -> Option<String> {
        let username = self.username.as_deref()?;
        let password = self.password.as_deref().unwrap_or("");
        Some(format!(
            "Basic {}",
            BASE64_STANDARD.encode(format!("{username}:{password}"))
        ))
    }
}

/// Persisted / IPC form of the upstream proxy settings.
///
/// Distinct from [`UpstreamProxyConfig`] on purpose: this is the shape the DB
/// column and the frontend exchange (plain, serializable, and retained even
/// while disabled), whereas `UpstreamProxyConfig` is the runtime value that
/// only exists when the feature is actually on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamProxySettings {
    /// When false the settings are kept but every connection dials directly,
    /// so a user can toggle the chain off without losing the configuration.
    pub enabled: bool,
    pub protocol: UpstreamProxyProtocol,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub bypass: Vec<String>,
}

impl Default for UpstreamProxySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            protocol: UpstreamProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            // Clash's default mixed (HTTP + SOCKS) port — the overwhelmingly
            // common case for this feature, so pre-fill it.
            port: 7890,
            username: None,
            password: None,
            bypass: default_bypass_patterns(),
        }
    }
}

impl UpstreamProxySettings {
    /// Convert to the runtime config, or `None` when disabled.
    ///
    /// Blank credentials are normalized to `None`: an empty username would
    /// otherwise make us advertise username/password auth with nothing in it.
    pub fn to_runtime_config(&self) -> Option<UpstreamProxyConfig> {
        if !self.enabled {
            return None;
        }
        let username = self
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        // A password without a username cannot be sent by either protocol, so
        // drop it rather than failing validation on a half-filled form.
        let password = username.as_ref().and_then(|_| {
            self.password
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });

        Some(UpstreamProxyConfig {
            protocol: self.protocol,
            host: self.host.trim().to_string(),
            port: self.port,
            username,
            password,
            bypass: Arc::from(
                self.bypass
                    .iter()
                    .map(|entry| entry.trim().to_string())
                    .filter(|entry| !entry.is_empty())
                    .collect::<Vec<_>>(),
            ),
        })
    }
}

/// Bypass patterns applied when the user has not customized the list.
///
/// Loopback and `.local` are excluded by default because sending them through
/// a rule-based proxy breaks local development and mDNS for no benefit.
pub fn default_bypass_patterns() -> Vec<String> {
    ["localhost", "127.0.0.1", "::1", "*.local"]
        .into_iter()
        .map(String::from)
        .collect()
}

// ---------------------------------------------------------------------------
// Bypass matching
// ---------------------------------------------------------------------------

/// Match `host` against a bypass pattern list. A bypassed host is dialed
/// directly instead of being handed to the upstream proxy.
///
/// See [`crate::host_pattern::matches_any`] for the supported pattern forms.
pub fn bypass_matches(patterns: &[String], host: &str) -> bool {
    crate::host_pattern::matches_any(patterns, host)
}

// ---------------------------------------------------------------------------
// Dialing
// ---------------------------------------------------------------------------

/// The address handed to the upstream proxy as the tunnel target.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TargetAddress {
    Ip(IpAddr),
    Domain(String),
}

impl TargetAddress {
    /// Authority form for an HTTP `CONNECT` request line. IPv6 literals are
    /// bracketed per RFC 3986.
    fn authority(&self, port: u16) -> String {
        match self {
            Self::Ip(IpAddr::V6(ip)) => format!("[{ip}]:{port}"),
            Self::Ip(ip) => format!("{ip}:{port}"),
            Self::Domain(domain) => format!("{domain}:{port}"),
        }
    }
}

/// Outcome of a dial, so callers can report how the connection was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialRoute {
    /// Dialed the origin directly (no proxy configured, or the host matched a
    /// bypass pattern).
    Direct,
    /// Tunneled through the configured upstream proxy.
    UpstreamProxy,
}

/// Open a byte stream that reaches `target_host:target_port`.
///
/// When `proxy` is `None`, or `target_host` matches a bypass pattern, this is a
/// plain direct TCP connect. Otherwise the connection is negotiated through the
/// upstream proxy.
///
/// There is no automatic fallback to a direct connection when the proxy fails:
/// silently bypassing the proxy would leak traffic that the user explicitly
/// routed through it. Failures surface as errors instead.
pub(crate) async fn dial_target(
    proxy: Option<&UpstreamProxyConfig>,
    target_host: &str,
    target_port: u16,
    dns_override_ip: Option<IpAddr>,
) -> io::Result<(DialedStream, DialRoute)> {
    let proxy = match proxy {
        Some(proxy) if !proxy.should_bypass(target_host) => proxy,
        Some(proxy) => {
            tracing::debug!(
                event = "upstream_proxy_bypassed",
                host = %target_host,
                proxy_host = %proxy.host,
                "upstream_proxy_bypassed"
            );
            return dial_direct(target_host, target_port, dns_override_ip)
                .await
                .map(|stream| (stream, DialRoute::Direct));
        }
        None => {
            return dial_direct(target_host, target_port, dns_override_ip)
                .await
                .map(|stream| (stream, DialRoute::Direct));
        }
    };

    // A DNS override is an explicit user instruction, so it outranks the
    // "let the proxy resolve it" default. Otherwise pass the hostname through
    // untouched so the upstream proxy can apply domain-based routing rules.
    let target = match dns_override_ip {
        Some(ip) => TargetAddress::Ip(ip),
        None => match target_host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
        {
            Ok(ip) => TargetAddress::Ip(ip),
            Err(_) => TargetAddress::Domain(target_host.to_string()),
        },
    };

    let dial = dial_via_proxy(proxy, &target, target_port);
    match tokio::time::timeout(UPSTREAM_PROXY_DIAL_TIMEOUT, dial).await {
        Ok(Ok(stream)) => {
            tracing::debug!(
                event = "upstream_proxy_tunnel_established",
                host = %target_host,
                port = target_port,
                protocol = %proxy.protocol.as_str(),
                proxy_host = %proxy.host,
                proxy_port = proxy.port,
                "upstream_proxy_tunnel_established"
            );
            Ok((stream, DialRoute::UpstreamProxy))
        }
        Ok(Err(error)) => {
            tracing::warn!(
                event = "upstream_proxy_dial_failed",
                host = %target_host,
                port = target_port,
                protocol = %proxy.protocol.as_str(),
                proxy_host = %proxy.host,
                proxy_port = proxy.port,
                error = %error,
                "upstream_proxy_dial_failed"
            );
            Err(error)
        }
        Err(_elapsed) => {
            let message = format!(
                "upstream proxy {}:{} did not complete the {} handshake within {}s",
                proxy.host,
                proxy.port,
                proxy.protocol.as_str(),
                UPSTREAM_PROXY_DIAL_TIMEOUT.as_secs()
            );
            tracing::warn!(
                event = "upstream_proxy_dial_timeout",
                host = %target_host,
                port = target_port,
                proxy_host = %proxy.host,
                proxy_port = proxy.port,
                "upstream_proxy_dial_timeout"
            );
            Err(io::Error::new(io::ErrorKind::TimedOut, message))
        }
    }
}

/// Direct TCP connect to the origin, honoring a DNS override when present.
async fn dial_direct(
    target_host: &str,
    target_port: u16,
    dns_override_ip: Option<IpAddr>,
) -> io::Result<DialedStream> {
    let stream = match dns_override_ip {
        Some(ip) => TcpStream::connect(SocketAddr::new(ip, target_port)).await?,
        None => TcpStream::connect((target_host, target_port)).await?,
    };
    Ok(TlsOrPlain::Plain(stream))
}

/// TCP-connect to the proxy and run the protocol handshake for `target`.
async fn dial_via_proxy(
    proxy: &UpstreamProxyConfig,
    target: &TargetAddress,
    target_port: u16,
) -> io::Result<DialedStream> {
    let tcp = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|e| {
            io::Error::new(
                e.kind(),
                format!(
                    "failed to connect to upstream proxy {}:{}: {e}",
                    proxy.host, proxy.port
                ),
            )
        })?;

    match proxy.protocol {
        UpstreamProxyProtocol::Http => {
            let mut stream = TlsOrPlain::Plain(tcp);
            http_connect_handshake(&mut stream, proxy, target, target_port).await?;
            Ok(stream)
        }
        UpstreamProxyProtocol::Https => {
            let mut stream = tls_wrap_proxy_hop(tcp, proxy).await?;
            http_connect_handshake(&mut stream, proxy, target, target_port).await?;
            Ok(stream)
        }
        UpstreamProxyProtocol::Socks5 => {
            let mut stream = TlsOrPlain::Plain(tcp);
            socks5_handshake(&mut stream, proxy, target, target_port).await?;
            Ok(stream)
        }
    }
}

/// TLS-wrap the hop to the proxy itself (the `https` protocol).
///
/// This certificate is ALWAYS verified against the OS root store, independent
/// of the workspace's `verify_upstream_tls` setting. That setting governs
/// whether *intercepted target* certificates are checked; this hop is a
/// different trust decision — proxy credentials travel over it, so accepting
/// any certificate here would expose them to a MITM.
async fn tls_wrap_proxy_hop(
    tcp: TcpStream,
    proxy: &UpstreamProxyConfig,
) -> io::Result<DialedStream> {
    let client_config =
        aiproxy_tls_manager::client::build_client_config_with_alpn_and_verify(vec![], true);
    let connector = tokio_rustls::TlsConnector::from(client_config);
    let server_name =
        rustls::pki_types::ServerName::try_from(proxy.host.clone()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "upstream proxy host '{}' is not a valid TLS server name",
                    proxy.host
                ),
            )
        })?;
    let tls_stream = connector.connect(server_name, tcp).await.map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "TLS handshake with upstream proxy {}:{} failed: {e}. \
                 The proxy certificate must be trusted by the OS root store.",
                proxy.host, proxy.port
            ),
        )
    })?;
    Ok(TlsOrPlain::Tls(Box::new(tls_stream)))
}

// ---------------------------------------------------------------------------
// HTTP CONNECT (RFC 9110 §9.3.6)
// ---------------------------------------------------------------------------

async fn http_connect_handshake<S>(
    stream: &mut S,
    proxy: &UpstreamProxyConfig,
    target: &TargetAddress,
    target_port: u16,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let authority = target.authority(target_port);
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(value) = proxy.proxy_authorization_value() {
        request.push_str(&format!("Proxy-Authorization: {value}\r\n"));
    }
    request.push_str("\r\n");

    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;

    let head = read_connect_response_head(stream).await?;
    let status = parse_status_code(&head).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "upstream proxy {}:{} returned a malformed CONNECT response",
                proxy.host, proxy.port
            ),
        )
    })?;

    if !(200..300).contains(&status) {
        // 407 is by far the most common misconfiguration, so name it.
        let hint = if status == 407 {
            " (the proxy requires authentication — check the username/password)"
        } else {
            ""
        };
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "upstream proxy {}:{} rejected CONNECT to {authority} with status {status}{hint}",
                proxy.host, proxy.port
            ),
        ));
    }

    Ok(())
}

/// Read a CONNECT response head, stopping exactly at the `\r\n\r\n` terminator.
///
/// Reads one byte at a time on purpose. Buffered reads could pull in bytes the
/// target already sent *inside* the tunnel, and this stream is handed straight
/// to a TLS handshake or a raw relay afterwards — there is nowhere to put
/// leftover bytes, so over-reading would silently corrupt the connection. A
/// response head is a few dozen bytes and this runs once per connection, so the
/// extra syscalls are irrelevant next to the correctness guarantee.
async fn read_connect_response_head<S>(stream: &mut S) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let mut head = Vec::with_capacity(128);
    let mut byte = [0u8; 1];
    loop {
        if stream.read(&mut byte).await? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "upstream proxy closed the connection during the CONNECT handshake",
            ));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            return Ok(head);
        }
        if head.len() > MAX_CONNECT_RESPONSE_HEAD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "upstream proxy CONNECT response head exceeded {MAX_CONNECT_RESPONSE_HEAD_BYTES} bytes"
                ),
            ));
        }
    }
}

/// Extract the status code from an HTTP status line (`HTTP/1.1 200 OK`).
fn parse_status_code(head: &[u8]) -> Option<u16> {
    let line_end = head
        .windows(2)
        .position(|window| window == b"\r\n")
        .unwrap_or(head.len());
    let status_line = std::str::from_utf8(&head[..line_end]).ok()?;
    let mut parts = status_line.split_whitespace();
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse::<u16>().ok()
}

// ---------------------------------------------------------------------------
// SOCKS5 (RFC 1928) + username/password auth (RFC 1929)
// ---------------------------------------------------------------------------

async fn socks5_handshake<S>(
    stream: &mut S,
    proxy: &UpstreamProxyConfig,
    target: &TargetAddress,
    target_port: u16,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let offers_auth = proxy.username.is_some();

    // Greeting: advertise the methods we can actually perform.
    let greeting: Vec<u8> = if offers_auth {
        vec![
            SOCKS5_VERSION,
            2,
            SOCKS5_AUTH_NONE,
            SOCKS5_AUTH_USERNAME_PASSWORD,
        ]
    } else {
        vec![SOCKS5_VERSION, 1, SOCKS5_AUTH_NONE]
    };
    stream.write_all(&greeting).await?;
    stream.flush().await?;

    let mut method_reply = [0u8; 2];
    stream.read_exact(&mut method_reply).await.map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "SOCKS5 proxy {}:{} closed during the method negotiation: {e}",
                proxy.host, proxy.port
            ),
        )
    })?;
    if method_reply[0] != SOCKS5_VERSION {
        return Err(socks5_error(
            proxy,
            format!(
                "expected SOCKS version 5 in the method reply, got {}",
                method_reply[0]
            ),
        ));
    }

    match method_reply[1] {
        SOCKS5_AUTH_NONE => {}
        SOCKS5_AUTH_USERNAME_PASSWORD if offers_auth => {
            socks5_username_password_auth(stream, proxy).await?;
        }
        SOCKS5_AUTH_UNACCEPTABLE => {
            let hint = if offers_auth {
                "check the username/password"
            } else {
                "the proxy requires authentication but no username/password is configured"
            };
            return Err(socks5_error(
                proxy,
                format!("rejected all offered authentication methods ({hint})"),
            ));
        }
        other => {
            return Err(socks5_error(
                proxy,
                format!("selected unsupported authentication method 0x{other:02X}"),
            ));
        }
    }

    // CONNECT request.
    let mut request = vec![SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00];
    match target {
        TargetAddress::Ip(IpAddr::V4(ip)) => {
            request.push(SOCKS5_ATYP_IPV4);
            request.extend_from_slice(&ip.octets());
        }
        TargetAddress::Ip(IpAddr::V6(ip)) => {
            request.push(SOCKS5_ATYP_IPV6);
            request.extend_from_slice(&ip.octets());
        }
        TargetAddress::Domain(domain) => {
            let bytes = domain.as_bytes();
            // The domain length field is a single byte (RFC 1928 §4).
            let length = u8::try_from(bytes.len()).map_err(|_| {
                socks5_error(
                    proxy,
                    format!(
                        "target hostname is {} bytes, which exceeds the 255-byte SOCKS5 limit",
                        bytes.len()
                    ),
                )
            })?;
            request.push(SOCKS5_ATYP_DOMAIN);
            request.push(length);
            request.extend_from_slice(bytes);
        }
    }
    request.extend_from_slice(&target_port.to_be_bytes());
    stream.write_all(&request).await?;
    stream.flush().await?;

    // Reply: VER REP RSV ATYP BND.ADDR BND.PORT
    let mut reply = [0u8; 4];
    stream.read_exact(&mut reply).await.map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "SOCKS5 proxy {}:{} closed before replying to CONNECT: {e}",
                proxy.host, proxy.port
            ),
        )
    })?;
    if reply[0] != SOCKS5_VERSION {
        return Err(socks5_error(
            proxy,
            format!(
                "expected SOCKS version 5 in the CONNECT reply, got {}",
                reply[0]
            ),
        ));
    }
    if reply[1] != 0x00 {
        return Err(socks5_error(
            proxy,
            format!(
                "rejected CONNECT to {}: {}",
                target.authority(target_port),
                socks5_reply_message(reply[1])
            ),
        ));
    }

    // The bound address is unused, but it MUST be drained or its bytes would be
    // mistaken for tunnel payload by the caller.
    consume_socks5_bound_address(stream, reply[3], proxy).await?;

    Ok(())
}

async fn socks5_username_password_auth<S>(
    stream: &mut S,
    proxy: &UpstreamProxyConfig,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let username = proxy.username.as_deref().unwrap_or("");
    let password = proxy.password.as_deref().unwrap_or("");

    // Both fields are length-prefixed with a single byte (RFC 1929 §2).
    let username_len = u8::try_from(username.len())
        .map_err(|_| socks5_error(proxy, "username exceeds the 255-byte SOCKS5 limit"))?;
    let password_len = u8::try_from(password.len())
        .map_err(|_| socks5_error(proxy, "password exceeds the 255-byte SOCKS5 limit"))?;

    let mut message = vec![SOCKS5_AUTH_SUBNEGOTIATION_VERSION, username_len];
    message.extend_from_slice(username.as_bytes());
    message.push(password_len);
    message.extend_from_slice(password.as_bytes());
    stream.write_all(&message).await?;
    stream.flush().await?;

    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await.map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "SOCKS5 proxy {}:{} closed during username/password auth: {e}",
                proxy.host, proxy.port
            ),
        )
    })?;
    // Deliberately lenient on the version byte: RFC 1929 specifies 0x01, but
    // some servers echo 0x05. The status byte is what actually matters.
    if reply[1] != 0x00 {
        return Err(socks5_error(
            proxy,
            "rejected the configured username/password",
        ));
    }
    Ok(())
}

/// Drain the `BND.ADDR` + `BND.PORT` trailer of a SOCKS5 reply.
async fn consume_socks5_bound_address<S>(
    stream: &mut S,
    address_type: u8,
    proxy: &UpstreamProxyConfig,
) -> io::Result<()>
where
    S: AsyncRead + Unpin,
{
    match address_type {
        SOCKS5_ATYP_IPV4 => {
            let mut discard = [0u8; 4 + 2];
            stream.read_exact(&mut discard).await?;
        }
        SOCKS5_ATYP_IPV6 => {
            let mut discard = [0u8; 16 + 2];
            stream.read_exact(&mut discard).await?;
        }
        SOCKS5_ATYP_DOMAIN => {
            let mut length = [0u8; 1];
            stream.read_exact(&mut length).await?;
            let mut discard = vec![0u8; length[0] as usize + 2];
            stream.read_exact(&mut discard).await?;
        }
        other => {
            return Err(socks5_error(
                proxy,
                format!("replied with an unknown address type 0x{other:02X}"),
            ));
        }
    }
    Ok(())
}

/// Human-readable RFC 1928 §6 reply code.
fn socks5_reply_message(code: u8) -> &'static str {
    match code {
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown SOCKS5 failure",
    }
}

fn socks5_error(proxy: &UpstreamProxyConfig, message: impl std::fmt::Display) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("SOCKS5 proxy {}:{} {message}", proxy.host, proxy.port),
    )
}

// ---------------------------------------------------------------------------
// Connectivity probe
// ---------------------------------------------------------------------------

/// Result of a one-shot upstream proxy connectivity check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamProxyProbeResult {
    /// Whether the tunnel to `probe_host:probe_port` was successfully opened.
    pub success: bool,
    /// Total time spent on TCP connect + TLS (if any) + protocol handshake.
    pub elapsed_ms: u128,
    /// Failure detail, suitable for showing in the UI. `None` on success.
    pub error: Option<String>,
    /// The target the probe tunneled to, echoed back for the UI.
    pub probe_target: String,
}

/// Default probe target for the connectivity check.
///
/// Chosen because it resolves and is reachable essentially everywhere,
/// including networks where the usual connectivity-check hosts are blocked —
/// a probe that fails for geopolitical reasons rather than configuration ones
/// would be worse than no probe at all.
pub const DEFAULT_PROBE_TARGET: (&str, u16) = ("www.apple.com", 443);

/// Verify an upstream proxy configuration by opening a real tunnel through it.
///
/// This deliberately bypasses the bypass list: the user is testing the proxy
/// itself, so a probe target that happens to match a bypass pattern should not
/// silently turn into a direct connection and report success.
pub async fn probe_upstream_proxy(
    config: &UpstreamProxyConfig,
    probe_host: &str,
    probe_port: u16,
) -> UpstreamProxyProbeResult {
    let probe_target = format!("{probe_host}:{probe_port}");

    if let Err(error) = config.validate() {
        return UpstreamProxyProbeResult {
            success: false,
            elapsed_ms: 0,
            error: Some(error),
            probe_target,
        };
    }

    let target = match probe_host.parse::<IpAddr>() {
        Ok(ip) => TargetAddress::Ip(ip),
        Err(_) => TargetAddress::Domain(probe_host.to_string()),
    };

    let started = std::time::Instant::now();
    let outcome = tokio::time::timeout(
        UPSTREAM_PROXY_DIAL_TIMEOUT,
        dial_via_proxy(config, &target, probe_port),
    )
    .await;
    let elapsed_ms = started.elapsed().as_millis();

    match outcome {
        Ok(Ok(_stream)) => UpstreamProxyProbeResult {
            success: true,
            elapsed_ms,
            error: None,
            probe_target,
        },
        Ok(Err(error)) => UpstreamProxyProbeResult {
            success: false,
            elapsed_ms,
            error: Some(error.to_string()),
            probe_target,
        },
        Err(_elapsed) => UpstreamProxyProbeResult {
            success: false,
            elapsed_ms,
            error: Some(format!(
                "timed out after {}s waiting for upstream proxy {}:{}",
                UPSTREAM_PROXY_DIAL_TIMEOUT.as_secs(),
                config.host,
                config.port
            )),
            probe_target,
        },
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;
    use tokio::net::TcpListener;

    fn config(protocol: UpstreamProxyProtocol) -> UpstreamProxyConfig {
        UpstreamProxyConfig {
            protocol,
            host: "127.0.0.1".to_string(),
            port: 7890,
            username: None,
            password: None,
            bypass: Arc::from(Vec::<String>::new()),
        }
    }

    fn with_credentials(username: &str, password: &str) -> UpstreamProxyConfig {
        UpstreamProxyConfig {
            username: Some(username.to_string()),
            password: Some(password.to_string()),
            ..config(UpstreamProxyProtocol::Socks5)
        }
    }

    // --- protocol name round-trip -----------------------------------------

    #[test]
    fn protocol_names_round_trip() {
        for protocol in [
            UpstreamProxyProtocol::Http,
            UpstreamProxyProtocol::Https,
            UpstreamProxyProtocol::Socks5,
        ] {
            assert_eq!(
                UpstreamProxyProtocol::parse(protocol.as_str()),
                Some(protocol)
            );
        }
        // `socks5h` is the curl spelling of our default remote-DNS behavior.
        assert_eq!(
            UpstreamProxyProtocol::parse("SOCKS5H"),
            Some(UpstreamProxyProtocol::Socks5)
        );
        assert_eq!(UpstreamProxyProtocol::parse("socks4"), None);
        assert_eq!(UpstreamProxyProtocol::parse(""), None);
    }

    // --- bypass matching ---------------------------------------------------

    #[test]
    fn bypass_matches_exact_host_case_insensitively() {
        let patterns = vec!["Example.COM".to_string()];
        assert!(bypass_matches(&patterns, "example.com"));
        assert!(bypass_matches(&patterns, "EXAMPLE.com"));
        // A trailing dot is a legal FQDN spelling of the same host.
        assert!(bypass_matches(&patterns, "example.com."));
        assert!(!bypass_matches(&patterns, "api.example.com"));
    }

    #[test]
    fn bypass_wildcard_covers_subdomains_and_apex() {
        let patterns = vec!["*.example.com".to_string()];
        assert!(bypass_matches(&patterns, "api.example.com"));
        assert!(bypass_matches(&patterns, "deep.api.example.com"));
        assert!(
            bypass_matches(&patterns, "example.com"),
            "the apex must be covered — that is what users mean by *.example.com"
        );
        // Must not match a host that merely ends with the same text.
        assert!(!bypass_matches(&patterns, "notexample.com"));
        assert!(!bypass_matches(&patterns, "evil-example.com"));
    }

    #[test]
    fn bypass_leading_dot_form_behaves_like_wildcard() {
        let patterns = vec![".example.com".to_string()];
        assert!(bypass_matches(&patterns, "api.example.com"));
        assert!(bypass_matches(&patterns, "example.com"));
        assert!(!bypass_matches(&patterns, "notexample.com"));
    }

    #[test]
    fn bypass_cidr_matches_only_literal_ip_targets() {
        let patterns = vec!["192.168.0.0/16".to_string()];
        assert!(bypass_matches(&patterns, "192.168.1.10"));
        assert!(bypass_matches(&patterns, "192.168.255.255"));
        assert!(!bypass_matches(&patterns, "192.169.1.10"));
        // A hostname is never resolved to decide bypass.
        assert!(!bypass_matches(&patterns, "intranet.corp"));
    }

    #[test]
    fn bypass_cidr_handles_ipv6_and_bracketed_literals() {
        let patterns = vec!["fd00::/8".to_string()];
        assert!(bypass_matches(&patterns, "fd12::1"));
        assert!(bypass_matches(&patterns, "[fd12::1]"));
        assert!(!bypass_matches(&patterns, "fe80::1"));
        // Mixed address families must never match.
        assert!(!bypass_matches(&patterns, "192.168.1.1"));
    }

    #[test]
    fn bypass_cidr_zero_prefix_matches_whole_family() {
        // /0 must not trip the shift-overflow special case.
        assert!(bypass_matches(&["0.0.0.0/0".to_string()], "8.8.8.8"));
        assert!(bypass_matches(&["::/0".to_string()], "2001:db8::1"));
        assert!(!bypass_matches(&["0.0.0.0/0".to_string()], "2001:db8::1"));
    }

    #[test]
    fn bypass_rejects_out_of_range_prefix_length() {
        assert!(!bypass_matches(
            &["192.168.0.0/33".to_string()],
            "192.168.1.1"
        ));
        assert!(!bypass_matches(&["fd00::/129".to_string()], "fd00::1"));
    }

    #[test]
    fn bypass_star_matches_everything_and_empty_patterns_match_nothing() {
        assert!(bypass_matches(&["*".to_string()], "anything.example"));
        assert!(!bypass_matches(&[], "example.com"));
        assert!(!bypass_matches(
            &["".to_string(), "   ".to_string()],
            "example.com"
        ));
        // An empty host never matches, even against `*`.
        assert!(!bypass_matches(&["*".to_string()], ""));
    }

    #[test]
    fn default_bypass_covers_loopback_and_mdns() {
        let patterns = default_bypass_patterns();
        assert!(bypass_matches(&patterns, "localhost"));
        assert!(bypass_matches(&patterns, "127.0.0.1"));
        assert!(bypass_matches(&patterns, "::1"));
        assert!(bypass_matches(&patterns, "my-mac.local"));
        assert!(!bypass_matches(&patterns, "example.com"));
    }

    // --- validation --------------------------------------------------------

    #[test]
    fn validate_rejects_unusable_configurations() {
        let mut cfg = config(UpstreamProxyProtocol::Http);
        cfg.host = "  ".to_string();
        assert!(cfg.validate().is_err());

        let mut cfg = config(UpstreamProxyProtocol::Http);
        cfg.port = 0;
        assert!(cfg.validate().is_err());

        // A password with no username cannot be sent by either protocol.
        let mut cfg = config(UpstreamProxyProtocol::Http);
        cfg.password = Some("secret".to_string());
        assert!(cfg.validate().is_err());

        assert!(config(UpstreamProxyProtocol::Http).validate().is_ok());
    }

    // --- status line parsing ----------------------------------------------

    #[test]
    fn parse_status_code_reads_the_status_line() {
        assert_eq!(
            parse_status_code(b"HTTP/1.1 200 Connection Established\r\n\r\n"),
            Some(200)
        );
        assert_eq!(
            parse_status_code(b"HTTP/1.0 407 Proxy Auth Required\r\n\r\n"),
            Some(407)
        );
        // A reason phrase is optional.
        assert_eq!(parse_status_code(b"HTTP/1.1 200\r\n\r\n"), Some(200));
        assert_eq!(parse_status_code(b"garbage\r\n\r\n"), None);
        assert_eq!(parse_status_code(b""), None);
    }

    #[test]
    fn target_address_brackets_ipv6_authority() {
        let ipv6 = TargetAddress::Ip("2001:db8::1".parse().unwrap());
        assert_eq!(ipv6.authority(443), "[2001:db8::1]:443");
        let ipv4 = TargetAddress::Ip("93.184.216.34".parse().unwrap());
        assert_eq!(ipv4.authority(80), "93.184.216.34:80");
        let domain = TargetAddress::Domain("example.com".to_string());
        assert_eq!(domain.authority(8443), "example.com:8443");
    }

    // --- HTTP CONNECT handshake -------------------------------------------

    #[tokio::test]
    async fn http_connect_sends_authority_form_and_accepts_200() {
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Http);
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake =
            tokio::spawn(
                async move { http_connect_handshake(&mut client, &proxy, &target, 443).await },
            );

        // Read the request head the handshake wrote.
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            server.read_exact(&mut byte).await.unwrap();
            head.push(byte[0]);
        }
        let head = String::from_utf8(head).unwrap();
        assert!(
            head.starts_with("CONNECT example.com:443 HTTP/1.1\r\n"),
            "expected authority-form request line, got: {head}"
        );
        assert!(head.contains("Host: example.com:443\r\n"));
        assert!(
            !head.contains("Proxy-Authorization"),
            "no credentials configured, so no auth header should be sent"
        );

        server
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();

        handshake.await.unwrap().expect("200 must be accepted");
    }

    #[tokio::test]
    async fn http_connect_sends_basic_proxy_authorization_when_configured() {
        let (mut client, mut server) = duplex(4096);
        let proxy = UpstreamProxyConfig {
            protocol: UpstreamProxyProtocol::Http,
            username: Some("alice".to_string()),
            password: Some("s3cret".to_string()),
            ..config(UpstreamProxyProtocol::Http)
        };
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake =
            tokio::spawn(
                async move { http_connect_handshake(&mut client, &proxy, &target, 443).await },
            );

        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            server.read_exact(&mut byte).await.unwrap();
            head.push(byte[0]);
        }
        let head = String::from_utf8(head).unwrap();
        // base64("alice:s3cret")
        let expected = BASE64_STANDARD.encode("alice:s3cret");
        assert!(
            head.contains(&format!("Proxy-Authorization: Basic {expected}\r\n")),
            "missing or malformed auth header in: {head}"
        );

        server.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        handshake.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn http_connect_surfaces_407_with_a_credentials_hint() {
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Http);
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake =
            tokio::spawn(
                async move { http_connect_handshake(&mut client, &proxy, &target, 443).await },
            );

        let mut discard = vec![0u8; 128];
        let _ = server.read(&mut discard).await.unwrap();
        server
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            .await
            .unwrap();

        let error = handshake
            .await
            .unwrap()
            .expect_err("407 must fail the dial");
        let message = error.to_string();
        assert!(message.contains("407"), "got: {message}");
        assert!(
            message.contains("username/password"),
            "407 should hint at credentials, got: {message}"
        );
    }

    #[tokio::test]
    async fn http_connect_does_not_over_read_past_the_response_head() {
        // The tunnel payload that follows the head must still be readable by
        // the caller — over-reading here would corrupt the TLS handshake.
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Http);
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake = tokio::spawn(async move {
            http_connect_handshake(&mut client, &proxy, &target, 443)
                .await
                .map(|()| client)
        });

        let mut discard = vec![0u8; 128];
        let _ = server.read(&mut discard).await.unwrap();
        // Head and the first tunnel bytes arrive in a single write.
        server
            .write_all(b"HTTP/1.1 200 OK\r\n\r\nTUNNEL-PAYLOAD")
            .await
            .unwrap();

        let mut client = handshake.await.unwrap().unwrap();
        let mut payload = [0u8; 14];
        client.read_exact(&mut payload).await.unwrap();
        assert_eq!(
            &payload, b"TUNNEL-PAYLOAD",
            "handshake must leave post-head bytes in the stream"
        );
    }

    #[tokio::test]
    async fn http_connect_reports_eof_during_handshake() {
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Http);
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake =
            tokio::spawn(
                async move { http_connect_handshake(&mut client, &proxy, &target, 443).await },
            );

        // Consume the request first, so the write side succeeds and the failure
        // is genuinely "proxy hung up before answering" rather than a broken
        // pipe on the request itself.
        let mut discard = vec![0u8; 128];
        let _ = server.read(&mut discard).await.unwrap();
        drop(server);

        let error = handshake
            .await
            .unwrap()
            .expect_err("EOF must fail the dial");
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }

    // --- SOCKS5 handshake --------------------------------------------------

    #[tokio::test]
    async fn socks5_sends_domain_target_so_the_proxy_resolves_dns() {
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Socks5);
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake =
            tokio::spawn(async move { socks5_handshake(&mut client, &proxy, &target, 443).await });

        // Greeting: VER=5, NMETHODS=1, METHOD=0 (no auth offered).
        let mut greeting = [0u8; 3];
        server.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [0x05, 0x01, 0x00]);
        server.write_all(&[0x05, 0x00]).await.unwrap();

        // CONNECT request with a domain address type.
        let mut header = [0u8; 5];
        server.read_exact(&mut header).await.unwrap();
        assert_eq!(
            header[..4],
            [0x05, 0x01, 0x00, SOCKS5_ATYP_DOMAIN],
            "hostname must be sent as ATYP=domain so the proxy resolves it"
        );
        assert_eq!(header[4] as usize, "example.com".len());

        let mut domain = vec![0u8; "example.com".len()];
        server.read_exact(&mut domain).await.unwrap();
        assert_eq!(&domain, b"example.com");

        let mut port = [0u8; 2];
        server.read_exact(&mut port).await.unwrap();
        assert_eq!(u16::from_be_bytes(port), 443);

        // Success reply with an IPv4 bound address.
        server
            .write_all(&[0x05, 0x00, 0x00, SOCKS5_ATYP_IPV4, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();

        handshake.await.unwrap().expect("handshake must succeed");
    }

    #[tokio::test]
    async fn socks5_negotiates_username_password_auth() {
        let (mut client, mut server) = duplex(4096);
        let proxy = with_credentials("alice", "s3cret");
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake =
            tokio::spawn(async move { socks5_handshake(&mut client, &proxy, &target, 443).await });

        // Greeting must advertise both no-auth and username/password.
        let mut greeting = [0u8; 4];
        server.read_exact(&mut greeting).await.unwrap();
        assert_eq!(
            greeting,
            [0x05, 0x02, SOCKS5_AUTH_NONE, SOCKS5_AUTH_USERNAME_PASSWORD]
        );
        server
            .write_all(&[0x05, SOCKS5_AUTH_USERNAME_PASSWORD])
            .await
            .unwrap();

        // RFC 1929 sub-negotiation.
        let mut auth_header = [0u8; 2];
        server.read_exact(&mut auth_header).await.unwrap();
        assert_eq!(auth_header[0], SOCKS5_AUTH_SUBNEGOTIATION_VERSION);
        assert_eq!(auth_header[1] as usize, "alice".len());
        let mut username = vec![0u8; "alice".len()];
        server.read_exact(&mut username).await.unwrap();
        assert_eq!(&username, b"alice");
        let mut password_len = [0u8; 1];
        server.read_exact(&mut password_len).await.unwrap();
        let mut password = vec![0u8; password_len[0] as usize];
        server.read_exact(&mut password).await.unwrap();
        assert_eq!(&password, b"s3cret");
        server.write_all(&[0x01, 0x00]).await.unwrap();

        // Drain the CONNECT request, then reply success.
        let mut request = vec![0u8; 4 + 1 + "example.com".len() + 2];
        server.read_exact(&mut request).await.unwrap();
        server
            .write_all(&[0x05, 0x00, 0x00, SOCKS5_ATYP_IPV4, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();

        handshake
            .await
            .unwrap()
            .expect("auth handshake must succeed");
    }

    #[tokio::test]
    async fn socks5_reports_rejected_credentials() {
        let (mut client, mut server) = duplex(4096);
        let proxy = with_credentials("alice", "wrong");
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake =
            tokio::spawn(async move { socks5_handshake(&mut client, &proxy, &target, 443).await });

        let mut greeting = [0u8; 4];
        server.read_exact(&mut greeting).await.unwrap();
        server
            .write_all(&[0x05, SOCKS5_AUTH_USERNAME_PASSWORD])
            .await
            .unwrap();

        let mut discard = vec![0u8; 64];
        let _ = server.read(&mut discard).await.unwrap();
        // Non-zero status = auth failure.
        server.write_all(&[0x01, 0x01]).await.unwrap();

        let error = handshake
            .await
            .unwrap()
            .expect_err("bad credentials must fail");
        assert!(
            error.to_string().contains("username/password"),
            "got: {error}"
        );
    }

    #[tokio::test]
    async fn socks5_reports_no_acceptable_auth_method() {
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Socks5);
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake =
            tokio::spawn(async move { socks5_handshake(&mut client, &proxy, &target, 443).await });

        let mut greeting = [0u8; 3];
        server.read_exact(&mut greeting).await.unwrap();
        server
            .write_all(&[0x05, SOCKS5_AUTH_UNACCEPTABLE])
            .await
            .unwrap();

        let error = handshake.await.unwrap().expect_err("0xFF must fail");
        assert!(
            error.to_string().contains("requires authentication"),
            "an unauthenticated config should be told to add credentials, got: {error}"
        );
    }

    #[tokio::test]
    async fn socks5_maps_reply_codes_to_readable_messages() {
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Socks5);
        let target = TargetAddress::Domain("blocked.example".to_string());

        let handshake =
            tokio::spawn(async move { socks5_handshake(&mut client, &proxy, &target, 443).await });

        let mut greeting = [0u8; 3];
        server.read_exact(&mut greeting).await.unwrap();
        server.write_all(&[0x05, 0x00]).await.unwrap();

        let mut discard = vec![0u8; 4 + 1 + "blocked.example".len() + 2];
        server.read_exact(&mut discard).await.unwrap();
        // REP=0x02: connection not allowed by ruleset.
        server
            .write_all(&[0x05, 0x02, 0x00, SOCKS5_ATYP_IPV4, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();

        let error = handshake.await.unwrap().expect_err("REP != 0 must fail");
        assert!(
            error
                .to_string()
                .contains("connection not allowed by ruleset"),
            "got: {error}"
        );
    }

    #[tokio::test]
    async fn socks5_drains_domain_bound_address_before_returning() {
        // If the BND.ADDR trailer is not fully consumed, its bytes would be
        // misread as tunnel payload by the caller.
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Socks5);
        let target = TargetAddress::Domain("example.com".to_string());

        let handshake = tokio::spawn(async move {
            socks5_handshake(&mut client, &proxy, &target, 443)
                .await
                .map(|()| client)
        });

        let mut greeting = [0u8; 3];
        server.read_exact(&mut greeting).await.unwrap();
        server.write_all(&[0x05, 0x00]).await.unwrap();
        let mut discard = vec![0u8; 4 + 1 + "example.com".len() + 2];
        server.read_exact(&mut discard).await.unwrap();

        // Domain-form bound address, then the real tunnel payload.
        let mut reply = vec![0x05, 0x00, 0x00, SOCKS5_ATYP_DOMAIN, 3];
        reply.extend_from_slice(b"abc");
        reply.extend_from_slice(&[0x00, 0x50]); // port 80
        reply.extend_from_slice(b"TUNNEL-PAYLOAD");
        server.write_all(&reply).await.unwrap();

        let mut client = handshake.await.unwrap().unwrap();
        let mut payload = [0u8; 14];
        client.read_exact(&mut payload).await.unwrap();
        assert_eq!(&payload, b"TUNNEL-PAYLOAD");
    }

    #[tokio::test]
    async fn socks5_sends_ip_target_when_a_dns_override_pinned_it() {
        let (mut client, mut server) = duplex(4096);
        let proxy = config(UpstreamProxyProtocol::Socks5);
        let target = TargetAddress::Ip("93.184.216.34".parse().unwrap());

        let handshake =
            tokio::spawn(async move { socks5_handshake(&mut client, &proxy, &target, 443).await });

        let mut greeting = [0u8; 3];
        server.read_exact(&mut greeting).await.unwrap();
        server.write_all(&[0x05, 0x00]).await.unwrap();

        let mut request = [0u8; 4 + 4 + 2];
        server.read_exact(&mut request).await.unwrap();
        assert_eq!(request[3], SOCKS5_ATYP_IPV4);
        assert_eq!(&request[4..8], &[93, 184, 216, 34]);

        server
            .write_all(&[0x05, 0x00, 0x00, SOCKS5_ATYP_IPV4, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();
        handshake.await.unwrap().unwrap();
    }

    // --- dial_target routing ----------------------------------------------

    /// A listener that accepts one connection and echoes a fixed marker, used
    /// to prove `dial_target` reached it directly.
    async fn spawn_marker_listener(marker: &'static [u8]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let _ = socket.write_all(marker).await;
            }
        });
        port
    }

    #[tokio::test]
    async fn dial_target_without_proxy_connects_directly() {
        let port = spawn_marker_listener(b"DIRECT").await;
        let (mut stream, route) = dial_target(None, "127.0.0.1", port, None).await.unwrap();
        assert_eq!(route, DialRoute::Direct);
        let mut marker = [0u8; 6];
        stream.read_exact(&mut marker).await.unwrap();
        assert_eq!(&marker, b"DIRECT");
    }

    #[tokio::test]
    async fn dial_target_bypasses_proxy_for_matching_hosts() {
        let port = spawn_marker_listener(b"DIRECT").await;
        // Point the proxy at a closed port: if the bypass fails to apply, the
        // dial errors instead of silently succeeding.
        let proxy = UpstreamProxyConfig {
            host: "127.0.0.1".to_string(),
            port: 1,
            bypass: Arc::from(vec!["127.0.0.1".to_string()]),
            ..config(UpstreamProxyProtocol::Http)
        };

        let (mut stream, route) = dial_target(Some(&proxy), "127.0.0.1", port, None)
            .await
            .unwrap();
        assert_eq!(route, DialRoute::Direct);
        let mut marker = [0u8; 6];
        stream.read_exact(&mut marker).await.unwrap();
        assert_eq!(&marker, b"DIRECT");
    }

    #[tokio::test]
    async fn dial_target_tunnels_through_an_http_connect_proxy() {
        // Minimal CONNECT proxy: accept, read the head, reply 200, send marker.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let observed = Arc::new(tokio::sync::Mutex::new(String::new()));
        let observed_for_task = Arc::clone(&observed);

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if socket.read_exact(&mut byte).await.is_err() {
                    return;
                }
                head.push(byte[0]);
            }
            *observed_for_task.lock().await = String::from_utf8_lossy(&head).into_owned();
            let _ = socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\nTUNNELED")
                .await;
        });

        let proxy = UpstreamProxyConfig {
            host: "127.0.0.1".to_string(),
            port: proxy_port,
            ..config(UpstreamProxyProtocol::Http)
        };

        let (mut stream, route) = dial_target(Some(&proxy), "example.com", 443, None)
            .await
            .unwrap();
        assert_eq!(route, DialRoute::UpstreamProxy);

        let mut marker = [0u8; 8];
        stream.read_exact(&mut marker).await.unwrap();
        assert_eq!(&marker, b"TUNNELED");

        let head = observed.lock().await.clone();
        assert!(
            head.starts_with("CONNECT example.com:443 HTTP/1.1\r\n"),
            "the hostname must reach the proxy verbatim so its rules can match it, got: {head}"
        );
    }

    #[tokio::test]
    async fn dial_target_does_not_fall_back_to_direct_when_the_proxy_is_down() {
        // Port 1 on loopback is reliably closed. A dial through a dead proxy
        // must fail rather than silently leaking traffic around it.
        let target_port = spawn_marker_listener(b"DIRECT").await;
        let proxy = UpstreamProxyConfig {
            host: "127.0.0.1".to_string(),
            port: 1,
            ..config(UpstreamProxyProtocol::Http)
        };

        let result = dial_target(Some(&proxy), "127.0.0.1", target_port, None).await;
        let error = result
            .err()
            .expect("a dead upstream proxy must fail the dial, not bypass it");
        assert!(
            error.to_string().contains("upstream proxy"),
            "error should name the upstream proxy, got: {error}"
        );
    }

    #[tokio::test]
    async fn dial_target_prefers_a_dns_override_over_the_hostname() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let observed = Arc::new(tokio::sync::Mutex::new(String::new()));
        let observed_for_task = Arc::clone(&observed);

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if socket.read_exact(&mut byte).await.is_err() {
                    return;
                }
                head.push(byte[0]);
            }
            *observed_for_task.lock().await = String::from_utf8_lossy(&head).into_owned();
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await;
        });

        let proxy = UpstreamProxyConfig {
            host: "127.0.0.1".to_string(),
            port: proxy_port,
            ..config(UpstreamProxyProtocol::Http)
        };

        let override_ip: IpAddr = "10.1.2.3".parse().unwrap();
        let (_stream, route) = dial_target(Some(&proxy), "example.com", 443, Some(override_ip))
            .await
            .unwrap();
        assert_eq!(route, DialRoute::UpstreamProxy);

        let head = observed.lock().await.clone();
        assert!(
            head.starts_with("CONNECT 10.1.2.3:443 HTTP/1.1\r\n"),
            "an explicit DNS override must win over the hostname, got: {head}"
        );
    }

    // --- probe -------------------------------------------------------------

    // --- settings -> runtime conversion -----------------------------------

    #[test]
    fn settings_disabled_yield_no_runtime_config() {
        let settings = UpstreamProxySettings {
            enabled: false,
            ..Default::default()
        };
        assert!(settings.to_runtime_config().is_none());
    }

    #[test]
    fn settings_default_to_the_clash_mixed_port() {
        let settings = UpstreamProxySettings::default();
        assert_eq!(settings.protocol, UpstreamProxyProtocol::Http);
        assert_eq!(settings.host, "127.0.0.1");
        assert_eq!(settings.port, 7890);
        assert!(settings.bypass.contains(&"localhost".to_string()));
    }

    #[test]
    fn settings_normalize_blank_credentials_and_bypass_entries() {
        let settings = UpstreamProxySettings {
            enabled: true,
            host: "  127.0.0.1  ".to_string(),
            username: Some("   ".to_string()),
            password: Some("orphaned".to_string()),
            bypass: vec!["  localhost  ".to_string(), String::new(), "  ".to_string()],
            ..Default::default()
        };
        let runtime = settings.to_runtime_config().expect("enabled");

        assert_eq!(runtime.host, "127.0.0.1");
        assert_eq!(
            runtime.username, None,
            "a blank username must not trigger username/password auth"
        );
        assert_eq!(
            runtime.password, None,
            "a password without a username cannot be sent and must be dropped"
        );
        assert_eq!(
            runtime.bypass.as_ref(),
            &["localhost".to_string()],
            "blank bypass entries must be dropped"
        );
        assert!(runtime.validate().is_ok());
    }

    #[test]
    fn settings_keep_valid_credentials() {
        let settings = UpstreamProxySettings {
            enabled: true,
            username: Some("alice".to_string()),
            password: Some("s3cret".to_string()),
            ..Default::default()
        };
        let runtime = settings.to_runtime_config().expect("enabled");
        assert_eq!(runtime.username.as_deref(), Some("alice"));
        assert_eq!(runtime.password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn settings_round_trip_through_json() {
        // The DB column stores this as JSON, so a round-trip must be lossless.
        let settings = UpstreamProxySettings {
            enabled: true,
            protocol: UpstreamProxyProtocol::Socks5,
            host: "10.0.0.2".to_string(),
            port: 1080,
            username: Some("alice".to_string()),
            password: Some("s3cret".to_string()),
            bypass: vec!["*.internal".to_string()],
        };
        let encoded = serde_json::to_string(&settings).unwrap();
        let decoded: UpstreamProxySettings = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, settings);
        // camelCase on the wire, matching the shared TypeScript contract.
        assert!(
            encoded.contains("\"protocol\":\"socks5\""),
            "got: {encoded}"
        );
    }

    #[tokio::test]
    async fn probe_reports_failure_for_an_invalid_configuration() {
        let mut cfg = config(UpstreamProxyProtocol::Http);
        cfg.host = String::new();
        let result = probe_upstream_proxy(&cfg, "example.com", 443).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("host"));
    }

    #[tokio::test]
    async fn probe_ignores_the_bypass_list() {
        // Probing is about the proxy itself; a bypass match must not be
        // reported as a working tunnel.
        let proxy = UpstreamProxyConfig {
            host: "127.0.0.1".to_string(),
            port: 1,
            bypass: Arc::from(vec!["*".to_string()]),
            ..config(UpstreamProxyProtocol::Http)
        };
        let result = probe_upstream_proxy(&proxy, "example.com", 443).await;
        assert!(
            !result.success,
            "a dead proxy must fail the probe even when everything is bypassed"
        );
    }

    #[tokio::test]
    async fn probe_succeeds_against_a_working_connect_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if socket.read_exact(&mut byte).await.is_err() {
                    return;
                }
                head.push(byte[0]);
            }
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await;
        });

        let proxy = UpstreamProxyConfig {
            host: "127.0.0.1".to_string(),
            port: proxy_port,
            ..config(UpstreamProxyProtocol::Http)
        };
        let result = probe_upstream_proxy(&proxy, "example.com", 443).await;
        assert!(result.success, "probe error: {:?}", result.error);
        assert_eq!(result.probe_target, "example.com:443");
        assert!(result.error.is_none());
    }
}
