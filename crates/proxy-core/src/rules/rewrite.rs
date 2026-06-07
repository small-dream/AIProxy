use super::json_path::{
    coerce_body_field_value, get_json_path_value, json_value_preview, parse_json_field_path,
    remove_json_path_value, set_json_path_value,
};
use super::types::{
    RewriteBodyFieldPayload, RewriteBodyPayload, RewriteHeaderPayload, RewriteQueryPayload,
    RewriteRedirectPayload,
};
use super::*;

pub(crate) fn method_matches(methods: &[String], method: &Method) -> bool {
    methods.is_empty()
        || methods
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(method.as_str()))
}

pub(crate) fn rewrite_stage_matches(rule_stage: &str, current_stage: &str) -> bool {
    rule_stage.eq_ignore_ascii_case("either") || rule_stage.eq_ignore_ascii_case(current_stage)
}

fn set_header_entry(headers: &mut Vec<ProxyHeaderEntry>, name: &str, value: &str) {
    let mut replaced = false;

    headers.retain(|entry| {
        if entry.name.eq_ignore_ascii_case(name) {
            if !replaced {
                replaced = true;
                return false;
            }
            return false;
        }

        true
    });

    headers.push(ProxyHeaderEntry {
        name: name.to_string(),
        value: value.to_string(),
        is_pseudo: None,
    });
}

fn remove_header_entry(headers: &mut Vec<ProxyHeaderEntry>, name: &str) {
    headers.retain(|entry| !entry.name.eq_ignore_ascii_case(name));
}

fn strip_plain_body_edit_header_entries(headers: &mut Vec<ProxyHeaderEntry>) {
    headers.retain(|entry| {
        !entry.name.eq_ignore_ascii_case("content-encoding")
            && !entry.name.eq_ignore_ascii_case("content-md5")
            && !entry.name.eq_ignore_ascii_case("digest")
            && !entry.name.eq_ignore_ascii_case("etag")
    });
}

fn strip_plain_body_edit_headers(headers: &mut HeaderMap) {
    headers.remove("content-encoding");
    headers.remove("content-md5");
    headers.remove("digest");
    headers.remove("etag");
}

fn header_entry_value(headers: &[ProxyHeaderEntry], name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .iter()
        .filter(|entry| entry.name.eq_ignore_ascii_case(name))
        .map(|entry| entry.value.clone())
        .collect();

    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

fn header_map_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let name = HeaderName::from_bytes(name.as_bytes()).ok()?;
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();

    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

fn query_param_value(url: &Url, name: &str) -> Option<String> {
    let values: Vec<String> = url
        .query_pairs()
        .filter(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.into_owned())
        .collect();

    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

fn body_preview(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    const PREVIEW_LIMIT: usize = 2048;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(PREVIEW_LIMIT)]).to_string();
    if bytes.len() > PREVIEW_LIMIT {
        Some(format!("{text}..."))
    } else {
        Some(text)
    }
}

fn trace_entry(
    sequence: u32,
    kind: &str,
    key: Option<String>,
    before: Option<String>,
    after: Option<String>,
    message: Option<String>,
) -> RewriteTraceEntry {
    RewriteTraceEntry {
        after,
        before,
        kind: kind.to_string(),
        key,
        message,
        sequence,
    }
}

fn build_rewrite_trace(
    rule: &RewriteRule,
    stage: &str,
    started_at: Instant,
    outcome: &str,
    entries: Vec<RewriteTraceEntry>,
) -> RewriteTrace {
    RewriteTrace {
        duration_ms: started_at.elapsed().as_millis(),
        entries,
        outcome: outcome.to_string(),
        rule_id: rule.id.clone(),
        rule_name: rule.name.clone(),
        rewrite_type: rule.rewrite_type.clone(),
        stage: stage.to_string(),
    }
}

pub(crate) fn rebuild_request_runtime_state(
    request: &mut ParsedProxyRequest,
) -> Result<(), String> {
    request.headers = build_upstream_headers_from_entries(&request.request_headers)?;
    request.host = request
        .url
        .host_str()
        .ok_or_else(|| {
            "request URL does not contain a host after runtime transformation".to_string()
        })?
        .to_string();
    request.path = build_request_path(&request.url);
    request.protocol = request.url.scheme().to_string();
    request.query_params = build_query_params(&request.url);
    set_header_entry(
        &mut request.request_headers,
        "Host",
        &host_header_value(&request.url),
    );
    request.raw_request = build_raw_http_head(
        &format!("{} {} HTTP/1.1", request.method.as_str(), request.path),
        &request.request_headers,
    );

    Ok(())
}

fn apply_body_field_rewrite(
    body: &[u8],
    fields: &[RewriteBodyFieldPayload],
) -> Result<(Vec<u8>, Vec<RewriteTraceEntry>), String> {
    let body_text = std::str::from_utf8(body)
        .map_err(|error| format!("body field rewrite requires UTF-8 JSON body: {error}"))?;
    let mut json_body: serde_json::Value = serde_json::from_str(body_text)
        .map_err(|error| format!("body field rewrite requires valid JSON body: {error}"))?;
    let mut entries = Vec::new();

    for (index, field) in fields.iter().enumerate() {
        let segments = parse_json_field_path(&field.path)?;
        let before = get_json_path_value(&json_body, &segments).and_then(json_value_preview);
        let operation = field.operation.as_deref().unwrap_or("set");

        if operation.eq_ignore_ascii_case("remove") {
            remove_json_path_value(&mut json_body, &segments)?;
        } else {
            let value = coerce_body_field_value(field)?;
            set_json_path_value(&mut json_body, &segments, value)?;
        }

        let after = get_json_path_value(&json_body, &segments).and_then(json_value_preview);
        entries.push(trace_entry(
            index as u32,
            "body-field",
            Some(field.path.clone()),
            before,
            after,
            Some(operation.to_string()),
        ));
    }

    let rewritten = serde_json::to_vec(&json_body)
        .map_err(|error| format!("serialize rewritten JSON body: {error}"))?;
    Ok((rewritten, entries))
}

fn parse_rewrite_payload<T: DeserializeOwned>(rule: &RewriteRule) -> Result<T, String> {
    serde_json::from_value(rule.payload.clone()).map_err(|error| {
        format!(
            "rewrite rule '{}' has an invalid payload for type '{}': {error}",
            rule.id, rule.rewrite_type,
        )
    })
}

pub(crate) fn apply_request_rewrite_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
    is_http2: bool,
) -> Result<Vec<RewriteTrace>, String> {
    let mut traces = Vec::new();

    for rule in active_rewrite_rules_for_stage(rewrite_manager, workspace_id, "request", request) {
        let started_at = Instant::now();
        let mut entries = Vec::new();
        let mut outcome = "success";

        match rule.rewrite_type.as_str() {
            "header" => {
                let payload: RewriteHeaderPayload = parse_rewrite_payload(&rule)?;

                if !payload.target.eq_ignore_ascii_case("request") {
                    entries.push(trace_entry(
                        0,
                        "skip",
                        Some(payload.header_name),
                        None,
                        None,
                        Some("header target does not apply to request stage".to_string()),
                    ));
                    traces.push(build_rewrite_trace(
                        &rule, "request", started_at, "skipped", entries,
                    ));
                    continue;
                }

                let before = header_entry_value(&request.request_headers, &payload.header_name);
                if payload.operation.eq_ignore_ascii_case("remove") {
                    remove_header_entry(&mut request.request_headers, &payload.header_name);
                } else if let Some(value) = payload.value.as_deref() {
                    set_header_entry(&mut request.request_headers, &payload.header_name, value);
                }
                let after = header_entry_value(&request.request_headers, &payload.header_name);
                entries.push(trace_entry(
                    0,
                    "header",
                    Some(payload.header_name),
                    before,
                    after,
                    Some(payload.operation),
                ));
            }
            "query" => {
                let payload: RewriteQueryPayload = parse_rewrite_payload(&rule)?;
                let param_name = payload.param_name;
                let before = query_param_value(&request.url, &param_name);
                let mut query_pairs: Vec<(String, String)> = request
                    .url
                    .query_pairs()
                    .map(|(name, value)| (name.into_owned(), value.into_owned()))
                    .collect();

                query_pairs.retain(|(name, _)| !name.eq_ignore_ascii_case(&param_name));

                if !payload.operation.eq_ignore_ascii_case("remove") {
                    query_pairs.push((param_name.clone(), payload.value.unwrap_or_default()));
                }

                request.url.set_query(None);
                if !query_pairs.is_empty() {
                    let mut pairs = request.url.query_pairs_mut();
                    for (name, value) in &query_pairs {
                        pairs.append_pair(name, value);
                    }
                }
                let after = query_param_value(&request.url, &param_name);
                entries.push(trace_entry(
                    0,
                    "query",
                    Some(param_name),
                    before,
                    after,
                    Some(payload.operation),
                ));
            }
            "body" => {
                let payload: RewriteBodyPayload = parse_rewrite_payload(&rule)?;

                if !payload.target.eq_ignore_ascii_case("request") {
                    entries.push(trace_entry(
                        0,
                        "skip",
                        Some("body".to_string()),
                        None,
                        None,
                        Some("body target does not apply to request stage".to_string()),
                    ));
                    traces.push(build_rewrite_trace(
                        &rule, "request", started_at, "skipped", entries,
                    ));
                    continue;
                }

                if is_http2 {
                    entries.push(trace_entry(
                        0,
                        "skip",
                        Some("body".to_string()),
                        None,
                        None,
                        Some("HTTP/2 body rewrite not supported".to_string()),
                    ));
                    traces.push(build_rewrite_trace(
                        &rule, "request", started_at, "skipped", entries,
                    ));
                    continue;
                }

                let mode = payload.mode.as_deref().unwrap_or("replace");
                let before = body_preview(&request.body);
                if mode.eq_ignore_ascii_case("fields") {
                    let fields = payload.fields.unwrap_or_default();
                    let (rewritten_body, field_entries) =
                        apply_body_field_rewrite(&request.body, &fields)?;
                    request.body = rewritten_body;
                    entries.extend(field_entries);
                } else {
                    request.body = payload.text.unwrap_or_default().into_bytes();
                    entries.push(trace_entry(
                        0,
                        "body",
                        Some(CONTENT_TYPE.as_str().to_string()),
                        before,
                        body_preview(&request.body),
                        Some(payload.content_type.clone()),
                    ));
                }
                set_header_entry(
                    &mut request.request_headers,
                    CONTENT_TYPE.as_str(),
                    &payload.content_type,
                );
                strip_plain_body_edit_header_entries(&mut request.request_headers);
            }
            "redirect" => {
                let payload: RewriteRedirectPayload = parse_rewrite_payload(&rule)?;
                let before = request.url.to_string();
                let original_path = request.url.path().to_string();
                let original_query = request.url.query().map(str::to_string);
                let mut redirected_url = Url::parse(&payload.target_url).map_err(|error| {
                    format!(
                        "rewrite rule '{}' points to an invalid target URL '{}': {error}",
                        rule.id, payload.target_url
                    )
                })?;

                if payload.preserve_path {
                    redirected_url.set_path(&original_path);
                }
                if payload.preserve_query {
                    redirected_url.set_query(original_query.as_deref());
                }

                request.url = redirected_url;
                entries.push(trace_entry(
                    0,
                    "redirect",
                    Some("url".to_string()),
                    Some(before),
                    Some(request.url.to_string()),
                    None,
                ));
            }
            _ => {
                outcome = "skipped";
                entries.push(trace_entry(
                    0,
                    "skip",
                    Some(rule.rewrite_type.clone()),
                    None,
                    None,
                    Some("unsupported rewrite type".to_string()),
                ));
            }
        }

        rebuild_request_runtime_state(request)?;
        traces.push(build_rewrite_trace(
            &rule, "request", started_at, outcome, entries,
        ));
    }

    Ok(traces)
}

pub(crate) fn apply_response_rewrite_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    workspace_id: &str,
    request: &ParsedProxyRequest,
    response: &mut UpstreamResponse,
    is_http2: bool,
) -> Result<Vec<RewriteTrace>, String> {
    let mut traces = Vec::new();

    for rule in active_rewrite_rules_for_stage(rewrite_manager, workspace_id, "response", request) {
        let started_at = Instant::now();
        let mut entries = Vec::new();
        let mut outcome = "success";

        match rule.rewrite_type.as_str() {
            "header" => {
                let payload: RewriteHeaderPayload = parse_rewrite_payload(&rule)?;

                if !payload.target.eq_ignore_ascii_case("response") {
                    entries.push(trace_entry(
                        0,
                        "skip",
                        Some(payload.header_name),
                        None,
                        None,
                        Some("header target does not apply to response stage".to_string()),
                    ));
                    traces.push(build_rewrite_trace(
                        &rule, "response", started_at, "skipped", entries,
                    ));
                    continue;
                }

                let before = header_map_value(&response.response_headers, &payload.header_name);
                if let Ok(name) = HeaderName::from_bytes(payload.header_name.as_bytes()) {
                    response.response_headers.remove(&name);

                    if !payload.operation.eq_ignore_ascii_case("remove") {
                        if let Some(value) = payload.value.as_deref() {
                            if let Ok(header_value) = HeaderValue::from_str(value) {
                                response.response_headers.insert(name, header_value);
                            }
                        }
                    }
                }
                let after = header_map_value(&response.response_headers, &payload.header_name);
                entries.push(trace_entry(
                    0,
                    "header",
                    Some(payload.header_name),
                    before,
                    after,
                    Some(payload.operation),
                ));
            }
            "body" => {
                let payload: RewriteBodyPayload = parse_rewrite_payload(&rule)?;

                if !payload.target.eq_ignore_ascii_case("response") {
                    entries.push(trace_entry(
                        0,
                        "skip",
                        Some("body".to_string()),
                        None,
                        None,
                        Some("body target does not apply to response stage".to_string()),
                    ));
                    traces.push(build_rewrite_trace(
                        &rule, "response", started_at, "skipped", entries,
                    ));
                    continue;
                }

                if is_http2 {
                    entries.push(trace_entry(
                        0,
                        "skip",
                        Some("body".to_string()),
                        None,
                        None,
                        Some("HTTP/2 body rewrite not supported".to_string()),
                    ));
                    traces.push(build_rewrite_trace(
                        &rule, "response", started_at, "skipped", entries,
                    ));
                    continue;
                }

                let mode = payload.mode.as_deref().unwrap_or("replace");
                let before = body_preview(&response.response_body);
                if mode.eq_ignore_ascii_case("fields") {
                    let fields = payload.fields.unwrap_or_default();
                    let (rewritten_body, field_entries) =
                        apply_body_field_rewrite(&response.response_body, &fields)?;
                    response.replace_response_body(rewritten_body);
                    entries.extend(field_entries);
                } else {
                    response.replace_response_body(payload.text.unwrap_or_default().into_bytes());
                    entries.push(trace_entry(
                        0,
                        "body",
                        Some(CONTENT_TYPE.as_str().to_string()),
                        before,
                        body_preview(&response.response_body),
                        Some(payload.content_type.clone()),
                    ));
                }

                if let Ok(content_type) = HeaderValue::from_str(&payload.content_type) {
                    response.response_headers.insert(CONTENT_TYPE, content_type);
                }
                strip_plain_body_edit_headers(&mut response.response_headers);
            }
            _ => {
                outcome = "skipped";
                entries.push(trace_entry(
                    0,
                    "skip",
                    Some(rule.rewrite_type.clone()),
                    None,
                    None,
                    Some("rewrite type does not apply to response stage".to_string()),
                ));
            }
        }
        traces.push(build_rewrite_trace(
            &rule, "response", started_at, outcome, entries,
        ));
    }

    Ok(traces)
}
