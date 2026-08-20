use super::*;

fn apply_remote_map_rule(
    request: &mut ParsedProxyRequest,
    rule: &MapRule,
) -> Result<String, String> {
    let original_url = request.url.to_string();
    let original_path = request.url.path().to_string();
    let original_query = request.url.query().map(str::to_string);
    let mut mapped_url = Url::parse(&rule.target_value).map_err(|error| {
        tracing::error!(
            event = "map_remote_target_parse_failed",
            rule_id = %rule.id,
            original_url = %original_url,
            target_url = %rule.target_value,
            error = %error,
            "map_remote_target_parse_failed"
        );
        format!(
            "map remote rule '{}' points to an invalid target URL '{}': {error}",
            rule.id, rule.target_value
        )
    })?;

    if rule.preserve_path {
        // Treat the target path as a base path.  Replacing it outright made a
        // target such as `https://staging.example/base` silently lose `/base`,
        // while naïvely concatenating both paths could produce `/base//v1`.
        // Keep the URL path absolute and join the two components exactly once.
        let target_path = mapped_url.path();
        let joined_path = join_remote_base_path(target_path, &original_path);
        mapped_url.set_path(&joined_path);
    }
    if rule.preserve_query {
        mapped_url.set_query(original_query.as_deref());
    }

    let mapped_url_text = mapped_url.to_string();
    request.url = mapped_url;
    if let Err(error) = rebuild_request_runtime_state(request) {
        tracing::error!(
            event = "map_remote_runtime_state_rebuild_failed",
            rule_id = %rule.id,
            original_url = %original_url,
            target_url = %mapped_url_text,
            error = %error,
            "map_remote_runtime_state_rebuild_failed"
        );
        return Err(format!(
            "map remote rule '{}' could not rebuild request state for '{}': {error}",
            rule.id, mapped_url_text
        ));
    }
    Ok(mapped_url_text)
}

/// Join a Map Remote target base path and the captured request path without
/// duplicating separators.  A root target preserves the historical behavior
/// (`/v1` remains `/v1`), while a non-root target scopes the request below its
/// configured base (`/api` + `/v1` becomes `/api/v1`).
fn join_remote_base_path(base: &str, request_path: &str) -> String {
    let base = if base.is_empty() { "/" } else { base };
    let request = if request_path.is_empty() { "/" } else { request_path };

    if base == "/" {
        return request.to_string();
    }

    let base = base.trim_end_matches('/');
    let request = request.trim_start_matches('/');
    // If the captured path is already scoped below the configured base, do not
    // duplicate that base when a rule is intentionally written with the same
    // path prefix (for example target `/v1/users` + request `/v1/users`).
    if request == base.trim_start_matches('/')
        || request.starts_with(&format!("{}/", base.trim_start_matches('/')))
    {
        return format!("/{request}");
    }
    if request.is_empty() {
        format!("{base}/")
    } else {
        format!("{base}/{request}")
    }
}

#[cfg(test)]
mod tests {
    use super::join_remote_base_path;

    #[test]
    fn joins_root_and_nested_paths() {
        assert_eq!(join_remote_base_path("/", "/v1/users"), "/v1/users");
        assert_eq!(join_remote_base_path("/gateway/", "/v1/users"), "/gateway/v1/users");
        assert_eq!(join_remote_base_path("/gateway", "/"), "/gateway/");
        assert_eq!(join_remote_base_path("", ""), "/");
    }
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
        // Served from a local file — no upstream connection was made, so there
        // is no routing decision to report.
        via_upstream_proxy: None,
    })
}

fn apply_local_map_rule(
    request: &ParsedProxyRequest,
    rule: &MapRule,
) -> Result<(UpstreamResponse, String), String> {
    // M1/M2: canonicalize the target path before any is_file/is_dir/fs::read.
    // `canonicalize` resolves symlinks (so a swapped link target is the target
    // we actually read) and fails closed on a dangling link. Reading the
    // canonical path afterwards closes the TOCTOU window between the is_file
    // stat and fs::read (both operate on the same resolved inode with no
    // further symlink resolution). The target_value is a user-configured,
    // explicitly-trusted path; no root confinement is applied (documented).
    let target_path = PathBuf::from(&rule.target_value);
    let target_canon = fs::canonicalize(&target_path).map_err(|error| {
        format!(
            "map local rule '{}' target '{}' could not be resolved: {error}",
            rule.id,
            target_path.display()
        )
    })?;

    if target_canon.is_file() {
        return build_local_file_response(&target_canon)
            .map(|response| (response, target_canon.display().to_string()));
    }

    let mut resolved_path = target_canon.clone();

    if target_canon.is_dir() {
        let requested_path = sanitize_request_path(request.url.path());

        if requested_path.as_os_str().is_empty() {
            resolved_path.push("index.html");
        } else {
            resolved_path.push(&requested_path);
        }

        if resolved_path.is_dir() {
            resolved_path.push("index.html");
        }
        // Canonicalize the joined path so the final read also resolves symlinks
        // and fails closed on a dangling link inside the served directory.
        resolved_path = fs::canonicalize(&resolved_path).unwrap_or(resolved_path);
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
