use chrono::{DateTime, Utc};
use httparse::{Request, Status, EMPTY_HEADER};
use reqwest::{
    header::{
        HeaderMap, HeaderName, HeaderValue, CONNECTION, CONTENT_LENGTH, HOST, TRANSFER_ENCODING,
    },
    redirect::Policy,
    Client, Method, StatusCode, Url,
};
use serde::Serialize;
use std::{io, net::SocketAddr, sync::Arc, time::Instant};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use uuid::Uuid;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const READ_BUFFER_BYTES: usize = 8 * 1024;

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
    pub session_receiver: mpsc::UnboundedReceiver<ProxySessionSummary>,
}

#[derive(Debug)]
struct ParsedProxyRequest {
    body: Vec<u8>,
    headers: HeaderMap,
    host: String,
    method: Method,
    path: String,
    protocol: String,
    url: Url,
}

pub async fn start_proxy_server(config: ProxyRuntimeConfig) -> Result<StartedProxyServer, String> {
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
        .build()
        .map_err(|error| format!("failed to create upstream HTTP client: {error}"))?;
    let client = Arc::new(client);

    let (shutdown_sender, mut shutdown_receiver) = oneshot::channel::<()>();
    let (session_sender, session_receiver) = mpsc::unbounded_channel();

    eprintln!(
        "level=INFO component=proxy-core event=listener_started host=127.0.0.1 port={bound_port}"
    );

    let join_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_receiver => {
                    eprintln!("level=INFO component=proxy-core event=listener_stopped reason=shutdown_requested");
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, client_addr)) => {
                            let client = Arc::clone(&client);
                            let session_sender = session_sender.clone();

                            tokio::spawn(async move {
                                if let Err(error) = handle_connection(stream, client_addr, client, session_sender).await {
                                    eprintln!("level=ERROR component=proxy-core event=connection_failed client_addr={client_addr} error=\"{error}\"");
                                }
                            });
                        }
                        Err(error) => {
                            eprintln!("level=ERROR component=proxy-core event=listener_accept_failed error=\"{error}\"");
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
    session_sender: mpsc::UnboundedSender<ProxySessionSummary>,
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

            eprintln!(
                "level=WARN component=proxy-core event=request_parse_failed client_addr={client_addr} error=\"{error}\""
            );

            return Ok(());
        }
    };

    if request.method == Method::CONNECT {
        write_plain_text_response(
            &mut stream,
            StatusCode::NOT_IMPLEMENTED,
            "HTTPS CONNECT tunneling is not available in P0-1.",
        )
        .await?;

        let summary = build_session_summary(
            request.method.as_str().to_string(),
            request.host,
            request.path,
            request.protocol,
            request.url.to_string(),
            StatusCode::NOT_IMPLEMENTED.as_u16(),
            0,
            started_at,
            started_at_instant,
        );
        let _ = session_sender.send(summary);

        return Ok(());
    }

    match forward_request(&client, &request).await {
        Ok((status_code, response_headers, response_body)) => {
            write_upstream_response(&mut stream, status_code, &response_headers, &response_body)
                .await?;

            let summary = build_session_summary(
                request.method.as_str().to_string(),
                request.host,
                request.path,
                request.protocol,
                request.url.to_string(),
                status_code.as_u16(),
                response_body.len(),
                started_at,
                started_at_instant,
            );

            let _ = session_sender.send(summary);

            eprintln!(
                "level=INFO component=proxy-core event=request_forwarded client_addr={client_addr} method={} status_code={} url=\"{}\"",
                request.method,
                status_code.as_u16(),
                request.url
            );

            Ok(())
        }
        Err(error) => {
            write_plain_text_response(
                &mut stream,
                StatusCode::BAD_GATEWAY,
                "The proxy could not reach the upstream server.",
            )
            .await?;

            let summary = build_session_summary(
                request.method.as_str().to_string(),
                request.host,
                request.path,
                request.protocol,
                request.url.to_string(),
                StatusCode::BAD_GATEWAY.as_u16(),
                0,
                started_at,
                started_at_instant,
            );
            let _ = session_sender.send(summary);

            Err(format!("upstream request failed: {error}"))
        }
    }
}

async fn forward_request(
    client: &Client,
    request: &ParsedProxyRequest,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), String> {
    let mut request_builder = client.request(request.method.clone(), request.url.clone());
    request_builder = request_builder.headers(request.headers.clone());

    if !request.body.is_empty() {
        request_builder = request_builder.body(request.body.clone());
    }

    let response = request_builder
        .send()
        .await
        .map_err(|error| format!("failed to send upstream request: {error}"))?;
    let status_code = response.status();
    let response_headers = response.headers().clone();
    let response_body = response
        .bytes()
        .await
        .map_err(|error| format!("failed to read upstream response body: {error}"))?
        .to_vec();

    Ok((status_code, response_headers, response_body))
}

async fn read_proxy_request(stream: &mut TcpStream) -> Result<ParsedProxyRequest, String> {
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

    Ok(ParsedProxyRequest {
        body,
        headers,
        host,
        method,
        path,
        protocol,
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

fn build_session_summary(
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
        id: Uuid::new_v4().to_string(),
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

async fn write_upstream_response(
    stream: &mut TcpStream,
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

async fn write_plain_text_response(
    stream: &mut TcpStream,
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
    async fn forwards_plain_http_requests_and_emits_a_session_summary() {
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
        })
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
        assert_eq!(session.method, "GET");
        assert_eq!(session.host, "127.0.0.1");
        assert_eq!(session.path, "/hello");
        assert_eq!(session.status_code, 200);

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
