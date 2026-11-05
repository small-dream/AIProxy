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
        // NOTE: `set_query` REPLACES the mapped URL's entire query string, so
        // when the configured target URL already carries its own query (e.g.
        // `https://staging.example/api?token=abc`), that target-side query is
        // discarded in favor of the original request's query. This overwrite
        // semantics is intentional (it mirrors the redirect rewrite action);
        // merge the two queries here if a combine mode is ever needed.
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
    let request = if request_path.is_empty() {
        "/"
    } else {
        request_path
    };

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

/// Reject request path segments that could escape the configured Map Local
/// root. On Windows a segment such as `C:` is a drive prefix, which makes
/// `PathBuf::push` replace the whole target; a colon also opens alternate data
/// streams. Returning `None` fails the request instead of silently serving a
/// different file.
fn sanitize_request_path(path: &str) -> Option<PathBuf> {
    let mut relative = PathBuf::new();

    for segment in path.trim_start_matches('/').split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            continue;
        }
        if !is_safe_local_segment(segment) {
            return None;
        }

        relative.push(segment);
    }

    Some(relative)
}

fn is_safe_local_segment(segment: &str) -> bool {
    if segment.contains('\0') {
        return false;
    }
    // `components()` rejects Windows separators hidden in a segment as well as
    // drive/UNC prefixes. Only a single `Normal` component may be appended
    // below the mapped root.
    let mut components = Path::new(segment).components();
    match components.next() {
        Some(std::path::Component::Normal(_)) if components.next().is_none() => {}
        _ => return false,
    }
    #[cfg(windows)]
    if segment.contains(':') {
        return false;
    }
    true
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// Resolve a captured request path below the already-canonicalized Map Local
/// root and refuse anything that canonicalizes outside it (including symlinks
/// planted inside the directory).
fn resolve_local_path(target_canon: &Path, request_path: &str) -> Result<PathBuf, String> {
    let requested_path = sanitize_request_path(request_path)
        .ok_or_else(|| format!("refusing unsafe Map Local request path '{request_path}'"))?;
    let mut resolved_path = target_canon.to_path_buf();
    if requested_path.as_os_str().is_empty() {
        resolved_path.push("index.html");
    } else {
        resolved_path.push(&requested_path);
    }
    if resolved_path.is_dir() {
        resolved_path.push("index.html");
    }
    let resolved_path = fs::canonicalize(&resolved_path).unwrap_or(resolved_path);
    if !path_is_within(&resolved_path, target_canon) {
        return Err(format!(
            "Map Local path '{}' resolves outside the mapped root",
            resolved_path.display()
        ));
    }
    Ok(resolved_path)
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
        connection_reused: None,
        connection_wait_ms: None,
        request_send_ms: None,
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
    // further symlink resolution). `target_value` is user-configured and
    // trusted; captured request paths are confined below that root by
    // `resolve_local_path`.
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
        resolved_path = resolve_local_path(&target_canon, request.url.path())?;
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

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn apply_map_rules(
    map_manager: &Option<Arc<MapManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
) -> Result<(Option<UpstreamResponse>, Vec<MapTrace>), String> {
    let Some(manager) = map_manager else {
        return Ok((None, Vec::new()));
    };
    apply_map_rules_with_snapshot(&manager.runtime_snapshot(), workspace_id, request)
}

pub(crate) fn apply_map_rules_with_snapshot(
    snapshot: &RuntimeRuleSnapshot,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
) -> Result<(Option<UpstreamResponse>, Vec<MapTrace>), String> {
    let Some(rule) = active_map_rule_for_snapshot(snapshot, workspace_id, request) else {
        return Ok((None, Vec::new()));
    };

    let started_at = Instant::now();
    let original_url = request.url.to_string();

    let result = match rule.mode.as_str() {
        "local" => apply_local_map_rule(request, &rule)
            .map(|(response, local_path)| (Some(response), Some(local_path), None)),
        "remote" => {
            // Snapshot the pre-map URL so a failed remote rule leaves the
            // request exactly as it arrived; a partially-applied URL mutation
            // (the target URL is swapped in before the runtime-state rebuild
            // that can still fail) must not leak into the forwarded request.
            let pre_map_url = request.url.clone();
            match apply_remote_map_rule(request, &rule) {
                Ok(mapped_url) => Ok((None, None, Some(mapped_url))),
                Err(error) => {
                    request.url = pre_map_url;
                    if let Err(rebuild_error) = rebuild_request_runtime_state(request) {
                        tracing::warn!(
                            event = "map_remote_rollback_rebuild_failed",
                            rule_id = %rule.id,
                            original_url = %original_url,
                            error = %rebuild_error,
                            "map_remote_rollback_rebuild_failed"
                        );
                    }
                    Err(error)
                }
            }
        }
        _ => return Ok((None, Vec::new())),
    };

    // R6-3: a failing map rule (missing/unreadable local target, invalid
    // remote target URL, ...) must NOT abort the request — the error used to
    // bubble out of the hyper service, closing the connection with no
    // response and no session. Downgrade to a per-rule `failed` trace and
    // forward the original request instead, mirroring the rewrite pipeline
    // (see the R6-3 comment in apply_request_rewrite_rules).
    let (response, local_path, mapped_url, outcome, failure_reason) = match result {
        Ok((response, local_path, mapped_url)) => {
            (response, local_path, mapped_url, "success", None)
        }
        Err(error) => {
            tracing::warn!(
                event = "map_rule_failed",
                rule_id = %rule.id,
                mode = %rule.mode,
                original_url = %original_url,
                error = %error,
                "map_rule_failed"
            );
            (None, None, None, "failed", Some(error))
        }
    };

    let trace = MapTrace {
        duration_ms: started_at.elapsed().as_millis(),
        failure_reason,
        local_path,
        mapped_url,
        mode: rule.mode,
        original_url,
        outcome: outcome.to_string(),
        rule_id: rule.id,
        rule_name: rule.name,
        source_pattern: rule.source_pattern,
        target_value: rule.target_value,
    };
    Ok((response, vec![trace]))
}

#[cfg(test)]
mod tests {
    use super::{join_remote_base_path, resolve_local_path, sanitize_request_path};

    #[test]
    fn joins_root_and_nested_paths() {
        assert_eq!(join_remote_base_path("/", "/v1/users"), "/v1/users");
        assert_eq!(
            join_remote_base_path("/gateway/", "/v1/users"),
            "/gateway/v1/users"
        );
        assert_eq!(join_remote_base_path("/gateway", "/"), "/gateway/");
        assert_eq!(join_remote_base_path("", ""), "/");
    }

    #[test]
    fn rejects_unsafe_local_segments() {
        assert!(sanitize_request_path("/safe/file.txt").is_some());
        // Parent segments are dropped rather than followed, so this stays
        // relative to the mapped root.
        assert_eq!(
            sanitize_request_path("/../../etc/passwd"),
            Some(std::path::PathBuf::from("etc/passwd"))
        );
        #[cfg(windows)]
        {
            assert!(sanitize_request_path("/C:Windows/win.ini").is_none());
            assert!(sanitize_request_path("/D:secret.txt").is_none());
        }
    }

    #[test]
    fn local_paths_stay_inside_the_mapped_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let file = root.join("asset.txt");
        std::fs::write(&file, b"ok").unwrap();

        assert_eq!(
            resolve_local_path(&root, "/asset.txt").unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        #[cfg(windows)]
        assert!(resolve_local_path(&root, "/C:Windows/win.ini").is_err());
    }
}
