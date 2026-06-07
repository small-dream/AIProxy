use super::*;

fn apply_remote_map_rule(
    request: &mut ParsedProxyRequest,
    rule: &MapRule,
) -> Result<String, String> {
    let original_path = request.url.path().to_string();
    let original_query = request.url.query().map(str::to_string);
    let mut mapped_url = Url::parse(&rule.target_value).map_err(|error| {
        format!(
            "map remote rule '{}' points to an invalid target URL '{}': {error}",
            rule.id, rule.target_value
        )
    })?;

    if rule.preserve_path {
        mapped_url.set_path(&original_path);
    }
    if rule.preserve_query {
        mapped_url.set_query(original_query.as_deref());
    }

    let mapped_url_text = mapped_url.to_string();
    request.url = mapped_url;
    rebuild_request_runtime_state(request)?;
    Ok(mapped_url_text)
}

fn sanitize_request_path(path: &str) -> PathBuf {
    let mut relative = PathBuf::new();

    for segment in path.trim_start_matches('/').split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            continue;
        }

        relative.push(segment);
    }

    relative
}

fn guess_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css; charset=utf-8",
        "gif" => "image/gif",
        "html" | "htm" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        "xml" => "application/xml; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn build_local_file_response(path: &Path) -> Result<UpstreamResponse, String> {
    let body = fs::read(path).map_err(|error| {
        format!(
            "failed to read local mapped file '{}': {error}",
            path.display()
        )
    })?;
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static(guess_mime_type(path)),
    );

    Ok(UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        request_send_ms: 0,
        response_body_size_bytes: body.len(),
        response_body: body,
        response_headers: headers,
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::OK,
        tls_ms: None,
        waiting_ms: 0,
    })
}

fn apply_local_map_rule(
    request: &ParsedProxyRequest,
    rule: &MapRule,
) -> Result<(UpstreamResponse, String), String> {
    let target_path = PathBuf::from(&rule.target_value);

    if target_path.is_file() {
        return build_local_file_response(&target_path)
            .map(|response| (response, target_path.display().to_string()));
    }

    let mut resolved_path = target_path.clone();

    if target_path.is_dir() {
        let requested_path = sanitize_request_path(request.url.path());

        if requested_path.as_os_str().is_empty() {
            resolved_path.push("index.html");
        } else {
            resolved_path.push(&requested_path);
        }

        if resolved_path.is_dir() {
            resolved_path.push("index.html");
        }
    }

    if resolved_path.is_file() {
        return build_local_file_response(&resolved_path)
            .map(|response| (response, resolved_path.display().to_string()));
    }

    Err(format!(
        "map local rule '{}' could not resolve '{}' for request '{}'",
        rule.id,
        resolved_path.display(),
        request.url,
    ))
}

pub(crate) fn apply_map_rules(
    map_manager: &Option<Arc<MapManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
) -> Result<(Option<UpstreamResponse>, Vec<MapTrace>), String> {
    let Some(rule) = active_map_rule_for_request(map_manager, workspace_id, request) else {
        return Ok((None, Vec::new()));
    };

    let started_at = Instant::now();
    let original_url = request.url.to_string();

    match rule.mode.as_str() {
        "local" => {
            let (response, local_path) = apply_local_map_rule(request, &rule)?;
            let trace = MapTrace {
                duration_ms: started_at.elapsed().as_millis(),
                local_path: Some(local_path),
                mapped_url: None,
                mode: rule.mode,
                original_url,
                outcome: "success".to_string(),
                rule_id: rule.id,
                rule_name: rule.name,
                source_pattern: rule.source_pattern,
                target_value: rule.target_value,
            };
            Ok((Some(response), vec![trace]))
        }
        "remote" => {
            let mapped_url = apply_remote_map_rule(request, &rule)?;
            let trace = MapTrace {
                duration_ms: started_at.elapsed().as_millis(),
                local_path: None,
                mapped_url: Some(mapped_url),
                mode: rule.mode,
                original_url,
                outcome: "success".to_string(),
                rule_id: rule.id,
                rule_name: rule.name,
                source_pattern: rule.source_pattern,
                target_value: rule.target_value,
            };
            Ok((None, vec![trace]))
        }
        _ => Ok((None, Vec::new())),
    }
}
