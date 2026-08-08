use super::*;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

// ---------------------------------------------------------------------------
// OwnedPrefixedStream — prepends bytes to an owned stream
// ---------------------------------------------------------------------------

/// An owned variant of the prefixed-stream pattern. Wraps an owned
/// `S: AsyncRead + AsyncWrite + Unpin` and prepends `prefix` bytes to
/// reads. Writes pass through directly to the inner stream.
///
/// Unlike the borrowed `PrefixedStream<'a, S>`, this takes `S` by value
/// and can satisfy `'static` bounds (e.g. when passed to TLS acceptors
/// or hyper server connections).
pub(crate) struct OwnedPrefixedStream<S> {
    prefix: Cursor<Vec<u8>>,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for OwnedPrefixedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let position = self.prefix.position() as usize;
        let prefix = self.prefix.get_ref();
        if position < prefix.len() {
            let bytes = std::cmp::min(buf.remaining(), prefix.len() - position);
            buf.put_slice(&prefix[position..position + bytes]);
            self.prefix.set_position((position + bytes) as u64);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for OwnedPrefixedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl<S> OwnedPrefixedStream<S> {
    pub(crate) fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix: Cursor::new(prefix),
            inner,
        }
    }
}

// ---------------------------------------------------------------------------

pub(crate) fn resolve_target_url(
    raw_target: &str,
    headers: &[httparse::Header<'_>],
) -> Result<String, String> {
    if raw_target.starts_with("http://")
        || raw_target.starts_with("https://")
        || raw_target.starts_with("ws://")
        || raw_target.starts_with("wss://")
    {
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

pub(crate) fn build_upstream_headers(
    headers: &[httparse::Header<'_>],
) -> Result<HeaderMap, String> {
    let is_ws_upgrade = is_websocket_upgrade(headers);
    // H2: RFC 7230 §6.1 — a sender lists connection-specific headers by name in
    // the `Connection` header; the proxy MUST strip those plus the standard
    // hop-by-hop set before forwarding.
    let strip = hop_by_hop_strip_set(headers.iter().map(|h| (h.name, h.value)));

    let mut header_map = HeaderMap::new();

    for header in headers {
        if should_skip_request_header(header.name) && !is_ws_upgrade {
            continue;
        }
        // For WS upgrades, still skip host/content-length/transfer-encoding
        if is_ws_upgrade && is_hop_by_hop_only(header.name) {
            continue;
        }
        if should_strip_hop_by_hop(header.name, &strip, is_ws_upgrade) {
            continue;
        }
        // Pseudo-headers never appear in h1/httparse traffic, but strip them
        // defensively to keep every outgoing-HeaderMap builder consistent.
        if is_pseudo_header_name(header.name) {
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

pub(crate) fn build_upstream_headers_from_entries(
    headers: &[ProxyHeaderEntry],
) -> Result<HeaderMap, String> {
    let is_ws_upgrade = headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("upgrade") && h.value.eq_ignore_ascii_case("websocket")
    });
    // H2: build the connection-listed strip set (RFC 7230 §6.1) for entries.
    let strip = hop_by_hop_strip_set(
        headers
            .iter()
            .map(|h| (h.name.as_str(), h.value.as_bytes())),
    );

    let mut header_map = HeaderMap::new();

    for header in headers {
        if should_skip_request_header(&header.name) && !is_ws_upgrade {
            continue;
        }
        if is_ws_upgrade && is_hop_by_hop_only(&header.name) {
            continue;
        }
        if should_strip_hop_by_hop(&header.name, &strip, is_ws_upgrade) {
            continue;
        }
        // Strip h2 pseudo-headers (`:method`, `:path`, …). Replayed/composed h2
        // sessions carry them in `request_headers`; `:` is not a valid h1
        // header name, so `HeaderName::from_bytes` below would reject them.
        if is_pseudo_header_name(&header.name) {
            continue;
        }

        let header_name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|error| format!("invalid header name: {error}"))?;
        let header_value = HeaderValue::from_str(&header.value)
            .map_err(|error| format!("invalid header value: {error}"))?;

        header_map.append(header_name, header_value);
    }

    Ok(header_map)
}

pub(crate) fn should_skip_request_header(header_name: &str) -> bool {
    header_name.eq_ignore_ascii_case(HOST.as_str())
        || header_name.eq_ignore_ascii_case(CONNECTION.as_str())
        || header_name.eq_ignore_ascii_case("proxy-connection")
        || header_name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
        || header_name.eq_ignore_ascii_case(TRANSFER_ENCODING.as_str())
}

/// Whether `name` is an HTTP/2 pseudo-header (`:method`, `:path`, `:scheme`,
/// `:authority`, …). Pseudo-headers are transport-level metadata, not real
/// headers: `:` is not a valid HTTP/1.1 header-name token (RFC 7230), so
/// `http::HeaderName::from_bytes` rejects them. Every code path that builds an
/// outgoing `HeaderMap` from a captured/replayed header list must strip them
/// first — see `build_upstream_headers_from_hyper` for the live h2 path.
pub(crate) fn is_pseudo_header_name(name: &str) -> bool {
    name.starts_with(':')
}

/// Headers to skip even for WS upgrades (host, content-length, transfer-encoding).
fn is_hop_by_hop_only(header_name: &str) -> bool {
    header_name.eq_ignore_ascii_case(HOST.as_str())
        || header_name.eq_ignore_ascii_case("proxy-connection")
        || header_name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
        || header_name.eq_ignore_ascii_case(TRANSFER_ENCODING.as_str())
}

/// The standard hop-by-hop + connection-control header set per RFC 7230 §6.1
/// (Connection options), §6.2 (close/keep-alive), §3.3.1 (TE) and §4.1.2
/// (Trailer), plus the proxy-only `Proxy-Authenticate`/`Proxy-Authorization`
/// (RFC 7230 §6.1 / §6.3). A proxy MUST strip these before forwarding.
pub(crate) fn is_standard_hop_by_hop_header(name: &str) -> bool {
    name.eq_ignore_ascii_case(CONNECTION.as_str())
        || name.eq_ignore_ascii_case("proxy-connection")
        || name.eq_ignore_ascii_case("keep-alive")
        || name.eq_ignore_ascii_case("te")
        || name.eq_ignore_ascii_case("trailer")
        || name.eq_ignore_ascii_case("upgrade")
        || name.eq_ignore_ascii_case("proxy-authenticate")
        || name.eq_ignore_ascii_case("proxy-authorization")
}

/// Parse the comma-separated token list carried by a `Connection` header value
/// (RFC 7230 §6.1). Tokens are returned lower-cased; the value may also be a
/// `close`/`keep-alive` directive, which is harmless to include in the strip
/// set since no header is named `close`.
fn parse_connection_tokens(value: &[u8]) -> Vec<String> {
    // A connection option is a token (RFC 7230 §3.2.6); commas separate them.
    value
        .split(|&b| b == b',')
        .filter_map(|chunk| {
            // Each comma-separated item may carry surrounding whitespace; pick
            // the first non-empty whitespace-delimited token as the option name.
            let token = chunk
                .split(|&b| b.is_ascii_whitespace())
                .find(|t| !t.is_empty())?;
            std::str::from_utf8(token)
                .ok()
                .map(|s| s.to_ascii_lowercase())
        })
        .collect()
}

/// Build the set of header names that must be stripped because either (a) they
/// are named in a `Connection`/`Proxy-Connection` header, or (b) they belong to
/// the standard hop-by-hop set. The caller passes `(name, value)` pairs over
/// which it can iterate; only connection-control values are parsed for tokens.
pub(crate) fn hop_by_hop_strip_set<'a, I, N, V>(pairs: I) -> std::collections::HashSet<String>
where
    I: IntoIterator<Item = (N, V)>,
    N: AsRef<str> + 'a,
    V: AsRef<[u8]> + 'a,
{
    let mut set = std::collections::HashSet::new();
    for (name, value) in pairs {
        let name = name.as_ref();
        if name.eq_ignore_ascii_case(CONNECTION.as_str())
            || name.eq_ignore_ascii_case("proxy-connection")
        {
            for token in parse_connection_tokens(value.as_ref()) {
                set.insert(token);
            }
        }
    }
    // Always include the standard hop-by-hop set so callers can do a single
    // membership check per header.
    for standard in [
        "connection",
        "proxy-connection",
        "keep-alive",
        "te",
        "trailer",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
    ] {
        set.insert(standard.to_string());
    }
    set
}

/// Decide whether `name` should be stripped as hop-by-hop. For non-WS requests
/// every standard hop-by-hop header plus anything named in `Connection` is
/// stripped. For WS upgrades `Connection`/`Upgrade` are the handshake carriers
/// and must be preserved, so they are excluded here (the standard hop-by-hop
/// remainder — `Keep-Alive`/`TE`/`Trailer`/`Proxy-*` — is still stripped, along
/// with any extra token a peer named in `Connection`).
pub(crate) fn should_strip_hop_by_hop(
    name: &str,
    strip: &std::collections::HashSet<String>,
    is_ws_upgrade: bool,
) -> bool {
    if is_ws_upgrade {
        // Only the WS handshake carriers survive: `Connection` (carries the
        // `Upgrade` connection-option) and `Upgrade` itself. Everything else
        // listed in `Connection` and the rest of the standard hop-by-hop set
        // — including `Proxy-Connection`, `Keep-Alive`, `TE`, `Trailer`,
        // `Proxy-*` — is stripped, even on the upgrade path.
        return !name.eq_ignore_ascii_case(CONNECTION.as_str())
            && !name.eq_ignore_ascii_case("upgrade")
            && strip.contains(&name.to_ascii_lowercase());
    }
    // Non-WS: `connection`/`proxy-connection` are already removed by
    // `should_skip_request_header`; here we strip the rest of the standard set
    // plus anything the peer explicitly listed in `Connection`.
    is_standard_hop_by_hop_header(name) || strip.contains(&name.to_ascii_lowercase())
}

/// Check if headers indicate a WebSocket upgrade request.
pub(crate) fn is_websocket_upgrade(headers: &[httparse::Header<'_>]) -> bool {
    headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("upgrade") && h.value.eq_ignore_ascii_case(b"websocket")
    })
}

pub(crate) fn build_request_path(url: &Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_session_detail(
    request: &ParsedProxyRequest,
    status_code: u16,
    response_headers: &HeaderMap,
    response_body: &[u8],
    response_body_size_bytes: usize,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    timing: ProxyTimingBreakdown,
    response_body_truncated: bool,
    // M2: when true, skip building (and thus decoding) the request/response
    // bodies — `request_body` and `response_body` are set to `None`. Used by
    // the client-cancellation Drop path, where the detail is only a "client
    // disconnected" trace and decoding a large compressed request body
    // synchronously on the dropping worker would stall the runtime.
    skip_bodies: bool,
) -> ProxySessionDetail {
    let id = request.request_id.clone();
    let response_header_entries = build_header_entries_from_map(response_headers);
    let summary = build_session_summary(SessionSummaryInput {
        id: id.clone(),
        method: request.method.to_string(),
        host: request.host.clone(),
        path: request.path.clone(),
        protocol: request.protocol.clone(),
        url: request.url.to_string(),
        status_code,
        size_bytes: response_body_size_bytes,
        response_mime_type: response_headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
        started_at,
        started_at_instant,
    });

    ProxySessionDetail {
        client_address: request.client_address.clone(),
        cookies: build_cookie_entries(&request.request_headers, &response_header_entries),
        id,
        query_params: request.query_params.clone(),
        raw_request_head: Some(request.raw_request.clone()),
        raw_response_head: Some(build_raw_http_head(
            &format!(
                "HTTP/1.1 {} {}",
                status_code,
                StatusCode::from_u16(status_code)
                    .ok()
                    .and_then(|code| code.canonical_reason().map(str::to_string))
                    .unwrap_or_else(|| "Unknown".to_string()),
            ),
            &response_header_entries,
        )),
        request_body: if skip_bodies {
            None
        } else {
            build_body_reference(
                &request.body,
                request.headers.get(CONTENT_TYPE),
                request.headers.get(CONTENT_ENCODING),
                request.body.len(),
                false,
            )
        },
        request_headers: request.request_headers.clone(),
        response_body: if skip_bodies {
            None
        } else {
            build_body_reference(
                response_body,
                response_headers.get(CONTENT_TYPE),
                response_headers.get(CONTENT_ENCODING),
                response_body_size_bytes,
                response_body_truncated,
            )
        },
        response_headers: response_header_entries,
        map_traces: Vec::new(),
        rewrite_traces: Vec::new(),
        server_ip: None,
        script_traces: Vec::new(),
        summary,
        throttle_traces: Vec::new(),
        tls_cipher_suite: request.tls_cipher_suite.clone(),
        tls_protocol: request.tls_protocol.clone(),
        timing: Some(timing),
        timing_source: None,
        trailers: None,
        h2_stream_id: None,
    }
}

pub(crate) fn build_pending_session_detail(
    request: &ParsedProxyRequest,
    started_at: DateTime<Utc>,
) -> ProxySessionDetail {
    let started_at_text = started_at.to_rfc3339();
    let protocol_metadata = infer_protocol_metadata(&request.protocol, request.url.as_str());

    ProxySessionDetail {
        client_address: request.client_address.clone(),
        cookies: Vec::new(),
        id: request.request_id.clone(),
        query_params: request.query_params.clone(),
        raw_request_head: Some(request.raw_request.clone()),
        raw_response_head: None,
        request_body: build_body_reference(
            &request.body,
            request.headers.get(CONTENT_TYPE),
            request.headers.get(CONTENT_ENCODING),
            request.body.len(),
            false,
        ),
        request_headers: request.request_headers.clone(),
        response_body: None,
        response_headers: Vec::new(),
        map_traces: Vec::new(),
        rewrite_traces: Vec::new(),
        server_ip: None,
        script_traces: Vec::new(),
        summary: ProxySessionSummary {
            id: request.request_id.clone(),
            method: request.method.to_string(),
            host: request.host.clone(),
            path: request.path.clone(),
            protocol: request.protocol.clone(),
            scheme: protocol_metadata.scheme,
            http_version: protocol_metadata.http_version,
            transport_protocol: protocol_metadata.transport_protocol,
            application_protocol: protocol_metadata.application_protocol,
            started_at: started_at_text.clone(),
            finished_at: started_at_text,
            duration_ms: 0,
            size_bytes: 0,
            status_code: 0,
            url: request.url.to_string(),
            response_mime_type: None,
        },
        throttle_traces: Vec::new(),
        tls_cipher_suite: request.tls_cipher_suite.clone(),
        tls_protocol: request.tls_protocol.clone(),
        timing: Some(ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: None,
            tls_ms: None,
            total_ms: Some(0),
            waiting_ms: None,
        }),
        timing_source: None,
        trailers: None,
        h2_stream_id: None,
    }
}

pub(crate) fn build_header_entries_from_httparse_headers(
    headers: &[httparse::Header<'_>],
) -> Vec<ProxyHeaderEntry> {
    headers
        .iter()
        .map(|header| ProxyHeaderEntry {
            name: header.name.to_string(),
            value: String::from_utf8_lossy(header.value).trim().to_string(),
            is_pseudo: None,
        })
        .collect()
}

pub(crate) fn build_header_entries_from_map(headers: &HeaderMap) -> Vec<ProxyHeaderEntry> {
    headers
        .iter()
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.as_str().to_string(),
            value: value
                .to_str()
                .map(str::to_string)
                .unwrap_or_else(|_| String::from_utf8_lossy(value.as_bytes()).to_string()),
            is_pseudo: None,
        })
        .collect()
}

pub(crate) fn build_query_params(url: &Url) -> Vec<ProxyHeaderEntry> {
    url.query_pairs()
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.into_owned(),
            value: value.into_owned(),
            is_pseudo: None,
        })
        .collect()
}

pub(crate) fn build_cookie_entries(
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

pub(crate) fn build_body_reference(
    body: &[u8],
    content_type_header: Option<&HeaderValue>,
    content_encoding_header: Option<&HeaderValue>,
    size_bytes: usize,
    truncated: bool,
) -> Option<ProxyBodyReference> {
    if body.is_empty() {
        return None;
    }

    let mime_type = content_type_header
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());
    let content_encoding = content_encoding_header
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    // Decode the full body before generating text so compressed streams are never broken.
    let decoded_body =
        decode_body_bytes(body, content_encoding.as_deref()).unwrap_or_else(|| body.to_vec());

    let render_as_text = should_render_body_as_text(mime_type.as_deref(), &decoded_body);

    Some(ProxyBodyReference::from_decoded_bytes(
        decoded_body,
        mime_type,
        size_bytes,
        truncated,
        render_as_text,
    ))
}

#[allow(dead_code)]
pub(crate) fn build_body_reference_from_decoded(
    decoded_body: Vec<u8>,
    content_type_header: Option<&HeaderValue>,
    size_bytes: usize,
    truncated: bool,
) -> Option<ProxyBodyReference> {
    if decoded_body.is_empty() && size_bytes == 0 {
        return None;
    }

    let mime_type = content_type_header
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());

    let render_as_text = should_render_body_as_text(mime_type.as_deref(), &decoded_body);

    Some(ProxyBodyReference::from_decoded_bytes(
        decoded_body,
        mime_type,
        size_bytes,
        truncated,
        render_as_text,
    ))
}

pub(crate) fn should_render_body_as_text(mime_type: Option<&str>, body: &[u8]) -> bool {
    if let Some(mime_type) = mime_type {
        let lowered = mime_type.to_ascii_lowercase();
        if lowered.starts_with("text/")
            || lowered.contains("json")
            || lowered.contains("xml")
            || lowered.contains("javascript")
            || lowered.contains("yaml")
            || lowered.contains("x-www-form-urlencoded")
            || lowered.contains("multipart/form-data")
        {
            return true;
        }
    }

    std::str::from_utf8(body).is_ok()
}

/// Decode a raw DEFLATE stream (RFC 1951, no zlib wrapper).
///
/// Uses flate2's streaming `DeflateDecoder` (the `Read` API). This consumes
/// the input incrementally and is correct for arbitrary payload sizes and
/// compression ratios. The previous manual `Decompress` loop re-fed the full
/// input slice on every iteration, which corrupted output once the initial
/// spare capacity was exceeded (highly-compressible payloads).
fn raw_deflate_decode(input: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = DeflateDecoder::new(Cursor::new(input));
    let mut output = Vec::new();
    match decoder.read_to_end(&mut output) {
        Ok(_) => Some(output),
        Err(_) => None,
    }
}

pub(crate) fn decode_body_bytes(body: &[u8], content_encoding: Option<&str>) -> Option<Vec<u8>> {
    let encodings: Vec<String> = content_encoding?
        .split(',')
        .map(|encoding| encoding.trim().to_ascii_lowercase())
        .filter(|encoding| !encoding.is_empty() && encoding != "identity")
        .collect();
    if encodings.is_empty() {
        return None;
    }

    let mut decoded = body.to_vec();

    for encoding in encodings.iter().rev() {
        decoded = match encoding.as_str() {
            "gzip" | "x-gzip" => {
                let mut decoder = GzDecoder::new(Cursor::new(decoded));
                let mut output = Vec::new();
                decoder.read_to_end(&mut output).ok()?;
                output
            }
            "deflate" => {
                // Some servers send raw deflate (RFC 1951) even though the
                // "deflate" Content-Encoding is nominally zlib-wrapped
                // (RFC 1950). Try zlib first, then fall back to raw deflate.
                let mut output = Vec::new();
                let mut zlib_decoder = ZlibDecoder::new(Cursor::new(&decoded));
                if zlib_decoder.read_to_end(&mut output).is_ok() {
                    output
                } else {
                    // Raw deflate (no zlib header) via flate2's Decompress.
                    raw_deflate_decode(&decoded)?
                }
            }
            "br" => {
                let mut decoder = Decompressor::new(Cursor::new(decoded), BROTLI_BUFFER_SIZE);
                let mut output = Vec::new();
                decoder.read_to_end(&mut output).ok()?;
                output
            }
            _ => return None,
        };
    }

    Some(decoded)
}

pub(crate) fn build_raw_http_head(start_line: &str, headers: &[ProxyHeaderEntry]) -> String {
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
    raw_message
}

pub(crate) struct SessionSummaryInput {
    pub(crate) id: String,
    pub(crate) method: String,
    pub(crate) host: String,
    pub(crate) path: String,
    pub(crate) protocol: String,
    pub(crate) url: String,
    pub(crate) status_code: u16,
    pub(crate) size_bytes: usize,
    pub(crate) response_mime_type: Option<String>,
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) started_at_instant: Instant,
}

pub(crate) fn build_session_summary(input: SessionSummaryInput) -> ProxySessionSummary {
    let SessionSummaryInput {
        id,
        method,
        host,
        path,
        protocol,
        url,
        status_code,
        size_bytes,
        response_mime_type,
        started_at,
        started_at_instant,
    } = input;
    let protocol_metadata = infer_protocol_metadata(&protocol, &url);

    ProxySessionSummary {
        id,
        method,
        host,
        path,
        protocol,
        scheme: protocol_metadata.scheme,
        http_version: protocol_metadata.http_version,
        transport_protocol: protocol_metadata.transport_protocol,
        application_protocol: protocol_metadata.application_protocol,
        started_at: started_at.to_rfc3339(),
        finished_at: Utc::now().to_rfc3339(),
        duration_ms: started_at_instant.elapsed().as_millis(),
        size_bytes,
        status_code,
        url,
        response_mime_type,
    }
}

pub(crate) async fn write_plain_text_response<S: AsyncReadExt + AsyncWriteExt + Unpin>(
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

pub(crate) fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

pub(crate) fn map_io_error(error: io::Error) -> String {
    format!("stream IO failure: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // P3: should_render_body_as_text
    // -----------------------------------------------------------------------

    // P3-1: text/* MIME always returns true
    proptest! {
        #[test]
        fn text_mime_always_returns_true(sub in "[a-zA-Z0-9]+", body in ".*") {
            let mime = format!("text/{sub}");
            prop_assert!(should_render_body_as_text(Some(&mime), body.as_bytes()));
        }
    }

    // P3-2: Valid UTF-8 body always returns true regardless of MIME
    proptest! {
        #[test]
        fn valid_utf8_body_always_true(mime in "(application|image)/[a-zA-Z0-9]+", body in ".*") {
            prop_assert!(should_render_body_as_text(Some(&mime), body.as_bytes()));
        }
    }

    // P3-3: application/json always returns true
    proptest! {
        #[test]
        fn application_json_always_true(body in ".*") {
            prop_assert!(should_render_body_as_text(Some("application/json"), body.as_bytes()));
        }
    }

    // P3-4: Non-text MIME + non-UTF-8 body -> false
    // Use suffixes that won't match text-like keywords (json, xml, javascript, yaml, etc.)
    proptest! {
        #[test]
        fn non_text_mime_non_utf8_body_returns_false(suffix in "png|gif|bmp|tiff|ico|webp|bin|exe", extra in prop::collection::vec(any::<u8>(), 0..50)) {
            let mime = format!("image/{suffix}");
            let mut body = vec![0xff, 0xfe];
            body.extend_from_slice(&extra);
            prop_assert!(!should_render_body_as_text(Some(&mime), &body));
        }
    }

    // -----------------------------------------------------------------------
    // P4: find_header_end
    // -----------------------------------------------------------------------

    // P4-1: Buffer containing \r\n\r\n -> Some(n) where buffer[n-4..n] == b"\r\n\r\n"
    proptest! {
        #[test]
        fn finds_header_end_marker(prefix in "[^\r]{0,50}", suffix in ".*") {
            let mut buffer = prefix.into_bytes();
            buffer.extend_from_slice(b"\r\n\r\n");
            buffer.extend_from_slice(suffix.as_bytes());
            let result = find_header_end(&buffer);
            prop_assert!(result.is_some());
            let n = result.unwrap();
            prop_assert_eq!(&buffer[n - 4..n], b"\r\n\r\n");
        }
    }

    // P4-2: Buffer without \r\n\r\n -> None (no CR means no CRLF CRLF)
    proptest! {
        #[test]
        fn no_header_end_returns_none(content in "[^\r]{0,50}") {
            let buffer = content.into_bytes();
            prop_assert!(find_header_end(&buffer).is_none());
        }
    }

    // -----------------------------------------------------------------------
    // P5: should_skip_request_header
    // -----------------------------------------------------------------------

    // P5-1: Known skip headers in ANY case variation -> true
    proptest! {
        #[test]
        fn host_skip_in_any_case(bits: u8) {
            for name in &["host", "connection", "proxy-connection", "content-length", "transfer-encoding"] {
                let mixed: String = name.chars().enumerate().map(|(i, c): (usize, char)| {
                    if (bits >> (i % 8)) & 1 == 0 { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() }
                }).collect();
                prop_assert!(should_skip_request_header(&mixed), "header {:?} should be skipped", mixed);
            }
        }
    }

    // P5-2: Random header names (filtered) -> false
    proptest! {
        #[test]
        fn unknown_headers_are_not_skipped(name in "x-[a-zA-Z0-9-]+") {
            let lower = name.to_ascii_lowercase();
            prop_assume!(!matches!(
                lower.as_str(),
                "host" | "connection" | "proxy-connection" | "content-length" | "transfer-encoding"
            ));
            prop_assert!(!should_skip_request_header(&name));
        }
    }

    // -----------------------------------------------------------------------
    // P7: resolve_target_url
    // -----------------------------------------------------------------------

    // P7-1: Absolute URLs -> Ok(original_value)
    proptest! {
        #[test]
        fn absolute_url_returns_ok(path in "[a-zA-Z0-9/._-]+") {
            for prefix in &["http://", "https://", "ws://", "wss://"] {
                let url = format!("{prefix}example.com/{path}");
                let result = resolve_target_url(&url, &[]);
                prop_assert_eq!(result, Ok(url.clone()));
            }
        }
    }

    // P7-2: Origin-form path + Host header -> Ok("http://{host}{path}")
    proptest! {
        #[test]
        fn origin_form_with_host_returns_full_url(
            path in "/[a-zA-Z0-9/._-]+",
            host in "[a-zA-Z0-9.-]+"
        ) {
            let headers = [httparse::Header {
                name: "Host",
                value: host.as_bytes(),
            }];
            let result = resolve_target_url(&path, &headers);
            prop_assert_eq!(result, Ok(format!("http://{host}{path}")));
        }
    }

    // P7-3: Origin-form without Host header -> Err
    proptest! {
        #[test]
        fn origin_form_without_host_returns_err(path in "/[a-zA-Z0-9/._-]+") {
            let result = resolve_target_url(&path, &[]);
            prop_assert!(result.is_err());
        }
    }

    // -----------------------------------------------------------------------
    // H2: hop-by-hop / Connection-listed header stripping (RFC 7230 §6.1)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_connection_tokens_handles_commas_and_whitespace() {
        let tokens = parse_connection_tokens(b"keep-alive, X-Foo,bar");
        assert_eq!(tokens, vec!["keep-alive", "x-foo", "bar"]);

        // Extra whitespace and tabs are tolerated; empty items are dropped.
        let tokens = parse_connection_tokens(b"  close  ,  ,\tUpgrade ");
        assert_eq!(tokens, vec!["close", "upgrade"]);
    }

    #[test]
    fn hop_by_hop_strip_set_collects_connection_listed_and_standard() {
        let pairs = vec![
            ("connection", "keep-alive, X-Foo".as_bytes()),
            ("x-bar", b"ignored"),
        ];
        let set = hop_by_hop_strip_set(pairs);
        // Connection-listed token captured.
        assert!(set.contains("x-foo"));
        // Standard set always present.
        for standard in [
            "connection",
            "proxy-connection",
            "keep-alive",
            "te",
            "trailer",
            "upgrade",
            "proxy-authenticate",
            "proxy-authorization",
        ] {
            assert!(set.contains(standard), "expected {standard} in strip set");
        }
    }

    #[test]
    fn is_standard_hop_by_hop_header_recognises_canonical_set() {
        for name in &[
            "connection",
            "Connection",
            "PROXY-CONNECTION",
            "keep-alive",
            "te",
            "Trailer",
            "upgrade",
            "proxy-authenticate",
            "proxy-authorization",
        ] {
            assert!(
                is_standard_hop_by_hop_header(name),
                "{name} should be standard hop-by-hop"
            );
        }
        // Random headers are not standard hop-by-hop.
        assert!(!is_standard_hop_by_hop_header("x-custom"));
        assert!(!is_standard_hop_by_hop_header("content-type"));
    }

    #[test]
    fn build_upstream_headers_strips_connection_listed_token() {
        // `Connection: keep-alive, x-foo` plus an `x-foo` header: after H2 the
        // proxy must NOT forward `x-foo` (RFC 7230 §6.1). `x-keep` (not listed)
        // must survive.
        let raw = b"GET / HTTP/1.1\r\n\
                    Host: example.com\r\n\
                    Connection: keep-alive, x-foo\r\n\
                    x-foo: bar\r\n\
                    x-keep: 1\r\n\
                    \r\n";
        let mut headers = [httparse::EMPTY_HEADER; 16];
        let mut req = httparse::Request::new(&mut headers);
        req.parse(raw).unwrap();
        let map = build_upstream_headers(req.headers).unwrap();
        assert!(
            map.get("x-foo").is_none(),
            "x-foo listed in Connection must be stripped"
        );
        assert_eq!(map.get("x-keep").unwrap().to_str().unwrap(), "1");
    }

    #[test]
    fn build_upstream_headers_strips_standard_hop_by_hop() {
        let raw = b"GET / HTTP/1.1\r\n\
                    Host: example.com\r\n\
                    Keep-Alive: timeout=5\r\n\
                    Proxy-Authenticate: Basic\r\n\
                    x-survive: 1\r\n\
                    \r\n";
        let mut headers = [httparse::EMPTY_HEADER; 16];
        let mut req = httparse::Request::new(&mut headers);
        req.parse(raw).unwrap();
        let map = build_upstream_headers(req.headers).unwrap();
        assert!(map.get("keep-alive").is_none());
        assert!(map.get("proxy-authenticate").is_none());
        assert_eq!(map.get("x-survive").unwrap().to_str().unwrap(), "1");
    }

    #[test]
    fn build_upstream_headers_from_entries_strips_pseudo_headers() {
        // Replayed/composed h2 sessions carry `:method`/`:path`/`:scheme`/
        // `:authority` as header entries. They must be stripped when building an
        // outgoing HeaderMap — `:` is not a valid HTTP/1.1 header-name token
        // (RFC 7230), so `HeaderName::from_bytes` would reject them and the
        // build would hard-fail (the Compose/Replay "invalid header name
        // ':method'" bug).
        let entries = vec![
            ProxyHeaderEntry {
                name: ":method".to_string(),
                value: "GET".to_string(),
                is_pseudo: Some(true),
            },
            ProxyHeaderEntry {
                name: ":path".to_string(),
                value: "/x".to_string(),
                is_pseudo: Some(true),
            },
            ProxyHeaderEntry {
                name: ":scheme".to_string(),
                value: "https".to_string(),
                is_pseudo: Some(true),
            },
            ProxyHeaderEntry {
                name: ":authority".to_string(),
                value: "ex.com".to_string(),
                is_pseudo: Some(true),
            },
            // A `:`-prefixed name even without the `is_pseudo` flag must be
            // stripped (defensive: the leading colon is what makes it illegal).
            ProxyHeaderEntry {
                name: ":custom".to_string(),
                value: "v".to_string(),
                is_pseudo: None,
            },
            ProxyHeaderEntry {
                name: "x-real".to_string(),
                value: "1".to_string(),
                is_pseudo: None,
            },
        ];
        let map = build_upstream_headers_from_entries(&entries).unwrap();
        let leaked: Vec<_> = map
            .keys()
            .filter(|k| k.as_str().starts_with(':'))
            .collect();
        assert!(
            leaked.is_empty(),
            "pseudo-headers leaked into outgoing map: {leaked:?}"
        );
        assert_eq!(map.keys().count(), 1, "only x-real should survive");
        assert_eq!(map.get("x-real").unwrap().to_str().unwrap(), "1");
    }

    #[test]
    fn build_upstream_headers_preserves_ws_handshake() {
        // A WS upgrade must keep `Connection: Upgrade` and `Upgrade: websocket`
        // but still strip a peer-listed custom token AND `Proxy-Connection`
        // (only the two handshake carriers survive the upgrade path).
        let raw = b"GET / HTTP/1.1\r\n\
                    Host: example.com\r\n\
                    Connection: Upgrade, x-foo\r\n\
                    Proxy-Connection: keep-alive\r\n\
                    Upgrade: websocket\r\n\
                    x-foo: bar\r\n\
                    Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                    \r\n";
        let mut headers = [httparse::EMPTY_HEADER; 16];
        let mut req = httparse::Request::new(&mut headers);
        req.parse(raw).unwrap();
        let map = build_upstream_headers(req.headers).unwrap();
        // Handshake headers preserved.
        let conn = map.get("connection").unwrap().to_str().unwrap();
        assert!(
            conn.eq_ignore_ascii_case("upgrade, x-foo") || conn.eq_ignore_ascii_case("upgrade")
        );
        assert_eq!(map.get("upgrade").unwrap().to_str().unwrap(), "websocket");
        // Custom listed token still stripped even on the WS path.
        assert!(map.get("x-foo").is_none());
        // Proxy-Connection is NOT a handshake carrier and must be stripped on
        // the upgrade path too (regression guard for the WS-branch fix).
        assert!(
            map.get("proxy-connection").is_none(),
            "Proxy-Connection must be stripped on the WS upgrade path"
        );
    }

    // -----------------------------------------------------------------------
    // L2: decode_body_bytes — deflate
    // -----------------------------------------------------------------------

    fn encode_zlib(plain: &[u8]) -> Vec<u8> {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(plain).unwrap();
        encoder.finish().unwrap()
    }

    fn encode_raw_deflate(plain: &[u8]) -> Vec<u8> {
        use flate2::write::DeflateEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(plain).unwrap();
        encoder.finish().unwrap()
    }

    // L2-1: zlib-wrapped deflate (standard servers) still decodes
    #[test]
    fn decode_body_bytes_deflate_zlib_wrapped() {
        let plain = b"{\"hello\":\"deflate\"}";
        let encoded = encode_zlib(plain);
        let decoded = decode_body_bytes(&encoded, Some("deflate"));
        assert_eq!(decoded.as_deref(), Some(plain.as_slice()));
    }

    // L2-2: raw deflate (no zlib header) decodes via fallback (L2)
    #[test]
    fn decode_body_bytes_deflate_raw_fallback() {
        let plain = b"raw-deflate-body-from-some-servers";
        let encoded = encode_raw_deflate(plain);
        // Sanity: raw deflate must NOT begin with a zlib header (0x78).
        assert_ne!(encoded.first().copied(), Some(0x78));
        let decoded = decode_body_bytes(&encoded, Some("deflate"));
        assert_eq!(decoded.as_deref(), Some(plain.as_slice()));
    }

    // L2-2b: raw deflate large payload (>4x compression) round-trips exactly.
    // The old manual-loop raw_deflate_decode re-fed the full input slice on
    // every iteration, corrupting output once the initial 4x spare capacity
    // was exceeded. This fixture compresses well beyond 4x, so the old code
    // produced ~2.1x the plaintext with duplicated bytes (first divergence
    // around byte 33k). RED on the old code, GREEN on the DeflateDecoder fix.
    #[test]
    fn decode_body_bytes_raw_deflate_large_payload_roundtrips() {
        // Repetitive plaintext that compresses >>4x — exercises the
        // multi-iteration path the old manual-loop corrupted.
        let plain: Vec<u8> = (0..200_000).map(|i| (i % 7) as u8).collect();
        let encoded = encode_raw_deflate(&plain);
        assert!(
            encoded.len() * 4 < plain.len(),
            "fixture must exceed old spare capacity (encoded={}, plain={})",
            encoded.len(),
            plain.len()
        );

        let decoded = decode_body_bytes(&encoded, Some("deflate")).expect("raw deflate decodes");
        assert_eq!(
            decoded, plain,
            "raw deflate large payload must round-trip exactly"
        );
    }

    // L2-3: mixed-case / whitespace encoding string still routes to deflate arm
    #[test]
    fn decode_body_bytes_deflate_case_insensitive() {
        let plain = b"case-insensitive";
        let encoded = encode_raw_deflate(plain);
        let decoded = decode_body_bytes(&encoded, Some("  DeFLATE "));
        assert_eq!(decoded.as_deref(), Some(plain.as_slice()));
    }
}
