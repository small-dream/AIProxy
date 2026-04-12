use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use brotli::Decompressor;
use chrono::{DateTime, Utc};
use flate2::read::{GzDecoder, ZlibDecoder};
use httparse::{Request, Status, EMPTY_HEADER};
use reqwest::{
    header::{
        HeaderMap, HeaderName, HeaderValue, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, HOST,
        TRANSFER_ENCODING,
    },
    redirect::Policy,
    Client, Method, StatusCode, Url,
};
use serde::Serialize;
use std::{
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::{self, Cursor, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use uuid::Uuid;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const READ_BUFFER_BYTES: usize = 8 * 1024;
const INLINE_BODY_CAPTURE_BYTES: usize = 64 * 1024;
const DEV_LOG_ENV_VAR: &str = "PHARLES_DEV_LOG_FILE";
const DEV_LOG_FILE_NAME: &str = "pharles-desktop-dev.log";

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
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
    shutdown_sender: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<()>,
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
    pub root_ca: pharles_tls_manager::RootCaPair,
    pub storage: Arc<pharles_tls_manager::CertStorage>,
    pub server_config: Arc<tokio_rustls::rustls::ServerConfig>,
}

impl std::fmt::Debug for TlsManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsManager").finish()
    }
}

#[derive(Debug)]
struct ParsedProxyRequest {
    body: Vec<u8>,
    headers: HeaderMap,
    host: String,
    method: Method,
    path: String,
    protocol: String,
    query_params: Vec<ProxyHeaderEntry>,
    raw_request: String,
    request_headers: Vec<ProxyHeaderEntry>,
    request_id: String,
    url: Url,
}

#[derive(Debug)]
struct UpstreamResponse {
    response_body: Vec<u8>,
    response_headers: HeaderMap,
    response_read_ms: u128,
    status_code: StatusCode,
    waiting_ms: u128,
}

pub async fn start_proxy_server(
    config: ProxyRuntimeConfig,
    tls_manager: Option<Arc<TlsManager>>,
) -> Result<StartedProxyServer, String> {
    config.validate().map_err(str::to_string)?;

    let listener = TcpListener::bind(("127.0.0.1", config.port))
        .await
        .map_err(|error| format!("failed to bind proxy listener: {error}"))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| format!("failed to read proxy listener address: {error}"))?
        .port();

    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| format!("failed to create upstream HTTP client: {error}"))?;
    let client = Arc::new(client);

    let (shutdown_sender, mut shutdown_receiver) = oneshot::channel::<()>();
    let (session_sender, session_receiver) = mpsc::unbounded_channel();

    emit_log(
        "INFO",
        "listener_started",
        &[
            ("host", "127.0.0.1".to_string()),
            ("port", bound_port.to_string()),
            ("ssl_enabled", config.ssl_enabled.to_string()),
        ],
    );

    let join_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_receiver => {
                    emit_log(
                        "INFO",
                        "listener_stopped",
                        &[("reason", "shutdown_requested".to_string())],
                    );
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, client_addr)) => {
                            let client = Arc::clone(&client);
                            let session_sender = session_sender.clone();
                            let tls_manager = tls_manager.clone();

                            tokio::spawn(async move {
                                if let Err(error) = handle_connection(stream, client_addr, client, session_sender, tls_manager).await {
                                    emit_log(
                                        "ERROR",
                                        "connection_failed",
                                        &[
                                            ("client_addr", client_addr.to_string()),
                                            ("error", error),
                                        ],
                                    );
                                }
                            });
                        }
                        Err(error) => {
                            emit_log(
                                "ERROR",
                                "listener_accept_failed",
                                &[("error", error.to_string())],
                            );
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(StartedProxyServer {
        bound_port,
        server_handle: ProxyServerHandle {
            shutdown_sender: Some(shutdown_sender),
            join_handle,
        },
        session_receiver,
    })
}

async fn handle_connection(
    mut stream: TcpStream,
    client_addr: SocketAddr,
    client: Arc<Client>,
    session_sender: mpsc::UnboundedSender<ProxySessionDetail>,
    tls_manager: Option<Arc<TlsManager>>,
) -> Result<(), String> {
    let started_at = Utc::now();
    let started_at_instant = Instant::now();

    let request = match read_proxy_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            write_plain_text_response(
                &mut stream,
                StatusCode::BAD_REQUEST,
                "Unable to parse the HTTP proxy request.",
            )
            .await?;

            emit_log(
                "WARN",
                "request_parse_failed",
                &[
                    ("client_addr", client_addr.to_string()),
                    ("error", error),
                ],
            );

            return Ok(());
        }
    };

    if request.method == Method::CONNECT {
        let host = request.host.clone();
        let port: u16 = request.path.parse().unwrap_or(443);

        emit_log(
            "INFO",
            "connect_received",
            &[
                ("request_id", request.request_id.clone()),
                ("client_addr", client_addr.to_string()),
                ("host", host.clone()),
                ("port", port.to_string()),
                ("ssl_interception_enabled", tls_manager.is_some().to_string()),
            ],
        );

        match tls_manager {
            None => {
                emit_log(
                    "WARN",
                    "connect_tunneling_without_mitm",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("client_addr", client_addr.to_string()),
                        ("host", host.clone()),
                        ("port", port.to_string()),
                    ],
                );

                // No TLS manager — blind tunnel (no decryption)
                return tunnel_blind_relay(stream, &host, port).await;
            }
            Some(mgr) => {
                emit_log(
                    "INFO",
                    "connect_mitm_started",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("client_addr", client_addr.to_string()),
                        ("host", host.clone()),
                        ("port", port.to_string()),
                    ],
                );

                // MITM: TLS terminate, capture, forward
                return handle_connect_mitm(
                    stream,
                    host,
                    port,
                    mgr,
                    client,
                    session_sender,
                    started_at,
                    started_at_instant,
                )
                .await;
            }
        }
    }

    match forward_request(&client, &request).await {
        Ok(upstream_response) => {
            write_upstream_response(
                &mut stream,
                upstream_response.status_code,
                &upstream_response.response_headers,
                &upstream_response.response_body,
            )
                .await?;

            let detail = build_session_detail(
                &request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: None,
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
            );

            let _ = session_sender.send(detail);

            emit_log(
                "INFO",
                "request_forwarded",
                &[
                    ("request_id", request.request_id.clone()),
                    ("client_addr", client_addr.to_string()),
                    ("method", request.method.to_string()),
                    ("status_code", upstream_response.status_code.as_u16().to_string()),
                    ("url", request.url.to_string()),
                ],
            );

            Ok(())
        }
        Err(error) => {
            let response_message = "The proxy could not reach the upstream server.";

            write_plain_text_response(
                &mut stream,
                StatusCode::BAD_GATEWAY,
                response_message,
            )
            .await?;

            let detail = build_session_detail(
                &request,
                StatusCode::BAD_GATEWAY.as_u16(),
                &HeaderMap::new(),
                response_message.as_bytes(),
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(0),
                    tls_ms: None,
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(started_at_instant.elapsed().as_millis()),
                },
            );
            let _ = session_sender.send(detail);
            emit_log(
                "ERROR",
                "upstream_request_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("client_addr", client_addr.to_string()),
                    ("method", request.method.to_string()),
                    ("url", request.url.to_string()),
                    ("error", error.clone()),
                ],
            );

            Err(format!("upstream request failed: {error}"))
        }
    }
}

fn emit_log(level: &str, event: &str, fields: &[(&str, String)]) {
    let timestamp = Utc::now().to_rfc3339();
    let mut line = format!("timestamp={timestamp} level={level} component=proxy-core event={event}");

    for (name, value) in fields {
        line.push(' ');
        line.push_str(name);
        line.push('=');
        line.push_str(&quote_value(value));
    }

    eprintln!("{line}");
    append_to_log_file(&line);
}

fn append_to_log_file(line: &str) {
    let write_lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _write_guard = write_lock.lock().expect("proxy-core log mutex should not be poisoned");
    let log_file_path = resolve_log_file_path();

    if let Some(parent) = log_file_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn resolve_log_file_path() -> PathBuf {
    if let Ok(log_file) = env::var(DEV_LOG_ENV_VAR) {
        if !log_file.trim().is_empty() {
            return PathBuf::from(log_file);
        }
    }

    discover_workspace_root_from_current_exe()
        .unwrap_or_else(|| env::temp_dir().join("pharles-dev"))
        .join("logs")
        .join("dev")
        .join(DEV_LOG_FILE_NAME)
}

fn discover_workspace_root_from_current_exe() -> Option<PathBuf> {
    let current_exe = env::current_exe().ok()?;

    for ancestor in current_exe.ancestors() {
        if ancestor.file_name() == Some(OsStr::new("target")) {
            return ancestor.parent().map(Path::to_path_buf);
        }
    }

    None
}

fn quote_value(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");

    format!("\"{escaped}\"")
}

async fn forward_request(
    client: &Client,
    request: &ParsedProxyRequest,
) -> Result<UpstreamResponse, String> {
    emit_log(
        "INFO",
        "upstream_request_started",
        &[
            ("request_id", request.request_id.clone()),
            ("method", request.method.to_string()),
            ("scheme", request.url.scheme().to_string()),
            ("host", request.host.clone()),
            ("url", request.url.to_string()),
        ],
    );

    let mut request_builder = client.request(request.method.clone(), request.url.clone());
    request_builder = request_builder.headers(request.headers.clone());

    if !request.body.is_empty() {
        request_builder = request_builder.body(request.body.clone());
    }

    let waiting_started_at = Instant::now();
    let response = request_builder
        .send()
        .await
        .map_err(|error| {
            emit_log(
                "ERROR",
                "upstream_request_send_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("method", request.method.to_string()),
                    ("scheme", request.url.scheme().to_string()),
                    ("host", request.host.clone()),
                    ("url", request.url.to_string()),
                    ("error", error.to_string()),
                ],
            );
            format!("failed to send upstream request: {error}")
        })?;
    let waiting_ms = waiting_started_at.elapsed().as_millis();
    let status_code = response.status();
    let response_headers = response.headers().clone();
    let response_read_started_at = Instant::now();
    let response_body = response
        .bytes()
        .await
        .map_err(|error| {
            emit_log(
                "ERROR",
                "upstream_response_read_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("method", request.method.to_string()),
                    ("scheme", request.url.scheme().to_string()),
                    ("host", request.host.clone()),
                    ("url", request.url.to_string()),
                    ("status_code", status_code.as_u16().to_string()),
                    ("error", error.to_string()),
                ],
            );
            format!("failed to read upstream response body: {error}")
        })?
        .to_vec();
    let response_read_ms = response_read_started_at.elapsed().as_millis();

    emit_log(
        "INFO",
        "upstream_request_succeeded",
        &[
            ("request_id", request.request_id.clone()),
            ("method", request.method.to_string()),
            ("scheme", request.url.scheme().to_string()),
            ("host", request.host.clone()),
            ("url", request.url.to_string()),
            ("status_code", status_code.as_u16().to_string()),
            ("waiting_ms", waiting_ms.to_string()),
            ("response_read_ms", response_read_ms.to_string()),
        ],
    );

    Ok(UpstreamResponse {
        response_body,
        response_headers,
        response_read_ms,
        status_code,
        waiting_ms,
    })
}

/// Blind TCP relay for CONNECT when SSL interception is disabled.
async fn tunnel_blind_relay(
    mut client_stream: TcpStream,
    host: &str,
    port: u16,
) -> Result<(), String> {
    // Send 200 Connection Established
    client_stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    let mut upstream = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("failed to connect to upstream {host}:{port}: {e}"))?;

    // Bidirectional copy
    let (mut cr, mut cw) = client_stream.split();
    let (mut ur, mut uw) = upstream.split();

    let client_to_upstream = tokio::io::copy(&mut cr, &mut uw);
    let upstream_to_client = tokio::io::copy(&mut ur, &mut cw);

    tokio::select! {
        r = client_to_upstream => {
            if let Err(e) = r {
                emit_log("WARN", "tunnel_client_to_upstream_error", &[("error", e.to_string())]);
            }
        }
        r = upstream_to_client => {
            if let Err(e) = r {
                emit_log("WARN", "tunnel_upstream_to_client_error", &[("error", e.to_string())]);
            }
        }
    }

    Ok(())
}

/// HTTPS MITM: terminate TLS, capture decrypted traffic, forward upstream.
async fn handle_connect_mitm(
    mut stream: TcpStream,
    host: String,
    port: u16,
    tls_manager: Arc<TlsManager>,
    client: Arc<Client>,
    session_sender: mpsc::UnboundedSender<ProxySessionDetail>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> Result<(), String> {
    // Send 200 Connection Established
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    // TLS handshake
    let tls_acceptor = tokio_rustls::TlsAcceptor::from(tls_manager.server_config.clone());
    let tls_stream = match tls_acceptor.accept(stream).await {
        Ok(stream) => stream,
        Err(error) => {
            emit_log(
                "ERROR",
                "tls_handshake_failed",
                &[
                    ("host", host.clone()),
                    ("port", port.to_string()),
                    ("error", error.to_string()),
                ],
            );
            return Err(format!("TLS handshake failed for {host}:{port}: {error}"));
        }
    };

    emit_log(
        "INFO",
        "tls_handshake_succeeded",
        &[
            ("host", host.clone()),
            ("port", port.to_string()),
        ],
    );

    let tls_instant = Instant::now();
    let mut tls_stream = tls_stream;

    // Read the decrypted HTTP request from the TLS stream
    let request = match read_proxy_request_from_stream(&mut tls_stream).await {
        Ok(r) => r,
        Err(error) => {
            emit_log(
                "WARN",
                "tls_request_parse_failed",
                &[
                    ("host", host.clone()),
                    ("error", error),
                ],
            );
            return Ok(());
        }
    };

    let tls_ms = tls_instant.elapsed().as_millis();

    // Rewrite URL to https://
    let https_url = if request.url.scheme() == "http" {
        let mut https = format!("https://{host}:{port}");
        if !request.path.is_empty() && request.path != "/" {
            https.push_str(&request.path);
        } else {
            https.push('/');
        }
        https
    } else {
        request.url.to_string()
    };

    // Build a modified request for HTTPS upstream
    let https_request = ParsedProxyRequest {
        protocol: "https".to_string(),
        url: Url::parse(&https_url)
            .map_err(|e| format!("invalid https URL {https_url}: {e}"))?,
        ..request
    };

    // Forward upstream
    match forward_request(&client, &https_request).await {
        Ok(upstream_response) => {
            write_upstream_response(
                &mut tls_stream,
                upstream_response.status_code,
                &upstream_response.response_headers,
                &upstream_response.response_body,
            )
                .await?;

            let detail = build_session_detail(
                &https_request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: Some(tls_ms),
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
            );

            let _ = session_sender.send(detail);

            emit_log(
                "INFO",
                "https_request_forwarded",
                &[
                    ("request_id", https_request.request_id.clone()),
                    ("host", host.clone()),
                    ("method", https_request.method.to_string()),
                    ("status_code", upstream_response.status_code.as_u16().to_string()),
                    ("url", https_url),
                ],
            );

            Ok(())
        }
        Err(error) => {
            let response_message = "The proxy could not reach the upstream HTTPS server.";

            write_plain_text_response(
                &mut tls_stream,
                StatusCode::BAD_GATEWAY,
                response_message,
            )
            .await?;

            let detail = build_session_detail(
                &https_request,
                StatusCode::BAD_GATEWAY.as_u16(),
                &HeaderMap::new(),
                response_message.as_bytes(),
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: Some(0),
                    response_read_ms: Some(0),
                    tls_ms: Some(tls_ms),
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(started_at_instant.elapsed().as_millis()),
                },
            );
            let _ = session_sender.send(detail);

            emit_log(
                "ERROR",
                "https_upstream_request_failed",
                &[
                    ("request_id", https_request.request_id.clone()),
                    ("host", host.clone()),
                    ("url", https_url),
                    ("error", error.clone()),
                ],
            );

            Err(format!("upstream HTTPS request failed: {error}"))
        }
    }
}

async fn read_proxy_request(stream: &mut TcpStream) -> Result<ParsedProxyRequest, String> {
    read_proxy_request_from_stream(stream).await
}

async fn read_proxy_request_from_stream<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
) -> Result<ParsedProxyRequest, String> {
    let mut buffer = Vec::with_capacity(READ_BUFFER_BYTES);
    let mut chunk = vec![0_u8; READ_BUFFER_BYTES];
    let header_end = loop {
        let bytes_read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("failed to read from client stream: {error}"))?;

        if bytes_read == 0 {
            return Err("client disconnected before sending headers".to_string());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);

        if buffer.len() > MAX_HEADER_BYTES {
            return Err("request headers exceed the maximum supported size".to_string());
        }

        if let Some(header_end) = find_header_end(&buffer) {
            break header_end;
        }
    };

    let mut headers = [EMPTY_HEADER; 64];
    let mut request = Request::new(&mut headers);
    let parse_status = request
        .parse(&buffer[..header_end])
        .map_err(|error| format!("failed to parse request line and headers: {error}"))?;

    if parse_status != Status::Complete(header_end) {
        return Err("request headers are incomplete".to_string());
    }

    let method = Method::from_bytes(
        request
            .method
            .ok_or_else(|| "request method is missing".to_string())?
            .as_bytes(),
    )
    .map_err(|error| format!("unsupported HTTP method: {error}"))?;
    let raw_path = request
        .path
        .ok_or_else(|| "request target is missing".to_string())?
        .to_string();
    let target_url = if method == Method::CONNECT {
        format!("http://{raw_path}")
    } else {
        resolve_target_url(&raw_path, request.headers)?
    };
    let url =
        Url::parse(&target_url).map_err(|error| format!("invalid proxy target URL: {error}"))?;
    let body_length = read_content_length(request.headers)?;
    let headers = build_upstream_headers(request.headers)?;
    let request_headers = build_header_entries_from_httparse_headers(request.headers);
    let host = url
        .host_str()
        .ok_or_else(|| "target URL does not contain a host".to_string())?
        .to_string();
    let path = if method == Method::CONNECT {
        raw_path.clone()
    } else {
        build_request_path(&url)
    };
    let protocol = if method == Method::CONNECT {
        "connect".to_string()
    } else {
        url.scheme().to_string()
    };
    let query_params = build_query_params(&url);
    let request_version = request.version.unwrap_or(1);

    drop(request);

    while buffer.len() < header_end + body_length {
        let bytes_read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("failed to read request body: {error}"))?;

        if bytes_read == 0 {
            return Err("client disconnected before request body was fully received".to_string());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);
    }
    let body = buffer[header_end..header_end + body_length].to_vec();
    let raw_request = build_raw_http_message(
        &format!(
            "{} {} HTTP/1.{}",
            method.as_str(),
            raw_path,
            request_version,
        ),
        &request_headers,
        &body,
    );

    Ok(ParsedProxyRequest {
        body,
        headers,
        host,
        method,
        path,
        protocol,
        query_params,
        raw_request,
        request_headers,
        request_id: Uuid::new_v4().to_string(),
        url,
    })
}

fn resolve_target_url(
    raw_target: &str,
    headers: &[httparse::Header<'_>],
) -> Result<String, String> {
    if raw_target.starts_with("http://") || raw_target.starts_with("https://") {
        return Ok(raw_target.to_string());
    }

    let host = headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("host"))
        .map(|header| String::from_utf8_lossy(header.value).trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "host header is required for origin-form requests".to_string())?;

    Ok(format!("http://{host}{raw_target}"))
}

fn build_upstream_headers(headers: &[httparse::Header<'_>]) -> Result<HeaderMap, String> {
    let mut header_map = HeaderMap::new();

    for header in headers {
        if should_skip_request_header(header.name) {
            continue;
        }

        let header_name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|error| format!("invalid header name: {error}"))?;
        let header_value = HeaderValue::from_bytes(header.value)
            .map_err(|error| format!("invalid header value: {error}"))?;

        header_map.append(header_name, header_value);
    }

    Ok(header_map)
}

fn should_skip_request_header(header_name: &str) -> bool {
    header_name.eq_ignore_ascii_case(HOST.as_str())
        || header_name.eq_ignore_ascii_case(CONNECTION.as_str())
        || header_name.eq_ignore_ascii_case("proxy-connection")
        || header_name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
        || header_name.eq_ignore_ascii_case(TRANSFER_ENCODING.as_str())
}

fn should_skip_response_header(header_name: &HeaderName) -> bool {
    header_name == &CONNECTION
        || header_name == &CONTENT_LENGTH
        || header_name == &TRANSFER_ENCODING
}

fn read_content_length(headers: &[httparse::Header<'_>]) -> Result<usize, String> {
    let Some(header) = headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str()))
    else {
        return Ok(0);
    };

    String::from_utf8_lossy(header.value)
        .trim()
        .parse::<usize>()
        .map_err(|error| format!("invalid content-length header: {error}"))
}

fn build_request_path(url: &Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    }
}

fn build_session_detail(
    request: &ParsedProxyRequest,
    status_code: u16,
    response_headers: &HeaderMap,
    response_body: &[u8],
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    timing: ProxyTimingBreakdown,
) -> ProxySessionDetail {
    let id = Uuid::new_v4().to_string();
    let response_header_entries = build_header_entries_from_map(response_headers);
    let summary = build_session_summary(
        id.clone(),
        request.method.to_string(),
        request.host.clone(),
        request.path.clone(),
        request.protocol.clone(),
        request.url.to_string(),
        status_code,
        response_body.len(),
        started_at,
        started_at_instant,
    );

    ProxySessionDetail {
        cookies: build_cookie_entries(&request.request_headers, &response_header_entries),
        id,
        query_params: request.query_params.clone(),
        raw_request: Some(request.raw_request.clone()),
        raw_response: Some(build_raw_http_message(
            &format!(
                "HTTP/1.1 {} {}",
                status_code,
                StatusCode::from_u16(status_code)
                    .ok()
                    .and_then(|code| code.canonical_reason().map(str::to_string))
                    .unwrap_or_else(|| "Unknown".to_string()),
            ),
            &response_header_entries,
            response_body,
        )),
        request_body: build_body_reference(
            &request.body,
            request.headers.get(CONTENT_TYPE),
            request.headers.get(reqwest::header::CONTENT_ENCODING),
        ),
        request_headers: request.request_headers.clone(),
        response_body: build_body_reference(
            response_body,
            response_headers.get(CONTENT_TYPE),
            response_headers.get(reqwest::header::CONTENT_ENCODING),
        ),
        response_headers: response_header_entries,
        server_ip: None,
        summary,
        timing: Some(timing),
    }
}

fn build_header_entries_from_httparse_headers(
    headers: &[httparse::Header<'_>],
) -> Vec<ProxyHeaderEntry> {
    headers
        .iter()
        .map(|header| ProxyHeaderEntry {
            name: header.name.to_string(),
            value: String::from_utf8_lossy(header.value).trim().to_string(),
        })
        .collect()
}

fn build_header_entries_from_map(headers: &HeaderMap) -> Vec<ProxyHeaderEntry> {
    headers
        .iter()
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.as_str().to_string(),
            value: value
                .to_str()
                .map(str::to_string)
                .unwrap_or_else(|_| String::from_utf8_lossy(value.as_bytes()).to_string()),
        })
        .collect()
}

fn build_query_params(url: &Url) -> Vec<ProxyHeaderEntry> {
    url.query_pairs()
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.into_owned(),
            value: value.into_owned(),
        })
        .collect()
}

fn build_cookie_entries(
    request_headers: &[ProxyHeaderEntry],
    response_headers: &[ProxyHeaderEntry],
) -> Vec<ProxyHeaderEntry> {
    request_headers
        .iter()
        .chain(response_headers.iter())
        .filter(|header| {
            header.name.eq_ignore_ascii_case("cookie")
                || header.name.eq_ignore_ascii_case("set-cookie")
        })
        .cloned()
        .collect()
}

fn build_body_reference(
    body: &[u8],
    content_type_header: Option<&HeaderValue>,
    content_encoding_header: Option<&HeaderValue>,
) -> Option<ProxyBodyReference> {
    if body.is_empty() {
        return None;
    }

    let truncated = body.len() > INLINE_BODY_CAPTURE_BYTES;
    let captured_body = &body[..body.len().min(INLINE_BODY_CAPTURE_BYTES)];
    let mime_type = content_type_header
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());
    let content_encoding = content_encoding_header
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let decoded_body = decode_body_bytes(captured_body, content_encoding.as_deref()).unwrap_or_else(|| captured_body.to_vec());
    let inline_text = if should_render_body_as_text(mime_type.as_deref(), &decoded_body) {
        Some(String::from_utf8_lossy(&decoded_body).to_string())
    } else {
        None
    };

    Some(ProxyBodyReference {
        base64_text: Some(BASE64_STANDARD.encode(captured_body)),
        encoding: inline_text.as_ref().map(|_| "utf-8".to_string()),
        inline_text,
        mime_type,
        size_bytes: body.len(),
        truncated,
    })
}

fn should_render_body_as_text(mime_type: Option<&str>, body: &[u8]) -> bool {
    if let Some(mime_type) = mime_type {
        let lowered = mime_type.to_ascii_lowercase();
        if lowered.starts_with("text/")
            || lowered.contains("json")
            || lowered.contains("xml")
            || lowered.contains("javascript")
            || lowered.contains("yaml")
            || lowered.contains("x-www-form-urlencoded")
        {
            return true;
        }
    }

    std::str::from_utf8(body).is_ok()
}

fn decode_body_bytes(body: &[u8], content_encoding: Option<&str>) -> Option<Vec<u8>> {
    let encoding = content_encoding?;

    if encoding.contains("gzip") {
        let mut decoder = GzDecoder::new(Cursor::new(body));
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).ok()?;
        return Some(decoded);
    }

    if encoding.contains("deflate") {
        let mut decoder = ZlibDecoder::new(Cursor::new(body));
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).ok()?;
        return Some(decoded);
    }

    if encoding.contains("br") {
        let mut decoder = Decompressor::new(Cursor::new(body), 4096);
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).ok()?;
        return Some(decoded);
    }

    None
}

fn build_raw_http_message(
    start_line: &str,
    headers: &[ProxyHeaderEntry],
    body: &[u8],
) -> String {
    let mut raw_message = String::new();
    raw_message.push_str(start_line);
    raw_message.push_str("\r\n");

    for header in headers {
        raw_message.push_str(&header.name);
        raw_message.push_str(": ");
        raw_message.push_str(&header.value);
        raw_message.push_str("\r\n");
    }

    raw_message.push_str("\r\n");

    if !body.is_empty() {
        raw_message.push_str(&String::from_utf8_lossy(
            &body[..body.len().min(INLINE_BODY_CAPTURE_BYTES)],
        ));

        if body.len() > INLINE_BODY_CAPTURE_BYTES {
            raw_message.push_str("\r\n<TRUNCATED>");
        }
    }

    raw_message
}

fn build_session_summary(
    id: String,
    method: String,
    host: String,
    path: String,
    protocol: String,
    url: String,
    status_code: u16,
    size_bytes: usize,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> ProxySessionSummary {
    ProxySessionSummary {
        id,
        method,
        host,
        path,
        protocol,
        started_at: started_at.to_rfc3339(),
        finished_at: Utc::now().to_rfc3339(),
        duration_ms: started_at_instant.elapsed().as_millis(),
        size_bytes,
        status_code,
        url,
    }
}

async fn write_upstream_response<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    status_code: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), String> {
    let reason = status_code.canonical_reason().unwrap_or("Unknown");
    let mut response = format!("HTTP/1.1 {} {reason}\r\n", status_code.as_u16());

    for (header_name, header_value) in headers {
        if should_skip_response_header(header_name) {
            continue;
        }

        let header_value = header_value
            .to_str()
            .map_err(|error| format!("response header value is not valid UTF-8: {error}"))?;

        response.push_str(header_name.as_str());
        response.push_str(": ");
        response.push_str(header_value);
        response.push_str("\r\n");
    }

    response.push_str(&format!("Content-Length: {}\r\n", body.len()));
    response.push_str("Connection: close\r\n\r\n");

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(map_io_error)?;

    if !body.is_empty() {
        stream.write_all(body).await.map_err(map_io_error)?;
    }

    stream.flush().await.map_err(map_io_error)?;

    Ok(())
}

async fn write_plain_text_response<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    status_code: StatusCode,
    message: &str,
) -> Result<(), String> {
    let reason = status_code.canonical_reason().unwrap_or("Unknown");
    let response = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_code.as_u16(),
        message.len(),
        message
    );

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(map_io_error)?;
    stream.flush().await.map_err(map_io_error)?;

    Ok(())
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn map_io_error(error: io::Error) -> String {
    format!("stream IO failure: {error}")
}

#[cfg(test)]
mod tests {
    use super::{
        build_request_path, find_header_end, resolve_target_url, start_proxy_server,
        ProxyRuntimeConfig,
    };
    use reqwest::Url;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    #[test]
    fn validates_a_non_zero_port() {
        let config = ProxyRuntimeConfig {
            port: 8888,
            ssl_enabled: true,
        };

        let actual = config.validate();

        assert_eq!(actual, Ok(()));
    }

    #[test]
    fn rejects_zero_as_a_port() {
        let config = ProxyRuntimeConfig {
            port: 0,
            ssl_enabled: false,
        };

        let actual = config.validate();

        assert_eq!(actual, Err("proxy port must be greater than zero"));
    }

    #[test]
    fn finds_the_end_of_the_http_header_block() {
        let actual = find_header_end(b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\nbody");

        assert_eq!(actual, Some(37));
    }

    #[test]
    fn resolves_origin_form_requests_from_the_host_header() {
        let headers = [httparse::Header {
            name: "Host",
            value: b"example.com",
        }];

        let actual = resolve_target_url("/hello", &headers);

        assert_eq!(actual, Ok("http://example.com/hello".to_string()));
    }

    #[test]
    fn keeps_absolute_form_requests_unchanged() {
        let actual = resolve_target_url("http://example.com/hello", &[]);

        assert_eq!(actual, Ok("http://example.com/hello".to_string()));
    }

    #[test]
    fn builds_a_request_path_with_the_query_string() {
        let actual = build_request_path(&Url::parse("http://example.com/hello?lang=en").unwrap());

        assert_eq!(actual, "/hello?lang=en");
    }

    #[tokio::test]
    async fn forwards_plain_http_requests_and_emits_a_session_detail() {
        let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_port = upstream_listener.local_addr().unwrap().port();
        let upstream_task = tokio::spawn(async move {
            let (mut stream, _) = upstream_listener.accept().await.unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHello",
                )
                .await
                .unwrap();
        });

        let proxy_port = allocate_unused_port();
        let mut started_proxy = start_proxy_server(ProxyRuntimeConfig {
            port: proxy_port,
            ssl_enabled: false,
        }, None)
        .await
        .unwrap();

        let target_url = format!("http://127.0.0.1:{upstream_port}/hello");
        let mut client_stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        let request = format!(
            "GET {target_url} HTTP/1.1\r\nHost: 127.0.0.1:{upstream_port}\r\nConnection: close\r\n\r\n"
        );
        client_stream.write_all(request.as_bytes()).await.unwrap();

        let mut response = String::new();
        client_stream.read_to_string(&mut response).await.unwrap();
        let session = started_proxy.session_receiver.recv().await.unwrap();

        assert!(response.contains("HTTP/1.1 200 OK"));
        assert!(response.contains("Hello"));
        assert_eq!(session.summary.method, "GET");
        assert_eq!(session.summary.host, "127.0.0.1");
        assert_eq!(session.summary.path, "/hello");
        assert_eq!(session.summary.status_code, 200);
        assert_eq!(
            session.request_headers[0].name.to_ascii_lowercase(),
            "host".to_string()
        );
        assert_eq!(
            session
                .response_body
                .as_ref()
                .and_then(|body| body.inline_text.clone()),
            Some("Hello".to_string())
        );

        started_proxy.server_handle.shutdown().await;
        upstream_task.await.unwrap();
    }

    fn allocate_unused_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
}
