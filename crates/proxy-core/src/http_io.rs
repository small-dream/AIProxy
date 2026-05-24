use super::*;

pub(crate) fn resolve_target_url(
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

pub(crate) fn build_upstream_headers(
    headers: &[httparse::Header<'_>],
) -> Result<HeaderMap, String> {
    let is_ws_upgrade = is_websocket_upgrade(headers);

    let mut header_map = HeaderMap::new();

    for header in headers {
        if should_skip_request_header(header.name) && !is_ws_upgrade {
            continue;
        }
        // For WS upgrades, still skip host/content-length/transfer-encoding
        if is_ws_upgrade && is_hop_by_hop_only(header.name) {
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

    let mut header_map = HeaderMap::new();

    for header in headers {
        if should_skip_request_header(&header.name) && !is_ws_upgrade {
            continue;
        }
        if is_ws_upgrade && is_hop_by_hop_only(&header.name) {
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

/// Headers to skip even for WS upgrades (host, content-length, transfer-encoding).
fn is_hop_by_hop_only(header_name: &str) -> bool {
    header_name.eq_ignore_ascii_case(HOST.as_str())
        || header_name.eq_ignore_ascii_case("proxy-connection")
        || header_name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
        || header_name.eq_ignore_ascii_case(TRANSFER_ENCODING.as_str())
}

/// Check if headers indicate a WebSocket upgrade request.
pub(crate) fn is_websocket_upgrade(headers: &[httparse::Header<'_>]) -> bool {
    headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("upgrade") && h.value.eq_ignore_ascii_case(b"websocket")
    })
}

pub(crate) fn should_skip_response_header(header_name: &HeaderName) -> bool {
    header_name == CONNECTION || header_name == CONTENT_LENGTH || header_name == TRANSFER_ENCODING
}

pub(crate) fn read_content_length(headers: &[httparse::Header<'_>]) -> Result<usize, String> {
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

pub(crate) fn build_request_path(url: &Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    }
}

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
        request_body: build_body_reference(
            &request.body,
            request.headers.get(CONTENT_TYPE),
            request.headers.get(reqwest::header::CONTENT_ENCODING),
            request.body.len(),
            false,
        ),
        request_headers: request.request_headers.clone(),
        response_body: build_body_reference(
            response_body,
            response_headers.get(CONTENT_TYPE),
            response_headers.get(reqwest::header::CONTENT_ENCODING),
            response_body_size_bytes,
            response_body_truncated,
        ),
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
            request.headers.get(reqwest::header::CONTENT_ENCODING),
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
        })
        .collect()
}

pub(crate) fn build_query_params(url: &Url) -> Vec<ProxyHeaderEntry> {
    url.query_pairs()
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.into_owned(),
            value: value.into_owned(),
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
        decoded_body, mime_type, size_bytes, truncated, render_as_text,
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
                let mut decoder = ZlibDecoder::new(Cursor::new(decoded));
                let mut output = Vec::new();
                decoder.read_to_end(&mut output).ok()?;
                output
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

pub(crate) async fn write_upstream_response<S: AsyncReadExt + AsyncWriteExt + Unpin>(
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
