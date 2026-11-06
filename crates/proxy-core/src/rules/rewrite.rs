use super::json_path::{
    coerce_body_field_value, get_json_path_value, json_value_preview, parse_json_field_path,
    remove_json_path_value, set_json_path_value, JsonPathSegment,
};
use super::types::{
    RewriteBodyFieldPayload, RewriteBodyPayload, RewriteHeaderPayload, RewriteQueryPayload,
    RewriteRedirectPayload,
};
use super::*;
use serde_json::Value;

pub(crate) fn method_matches(methods: &[String], method: &Method) -> bool {
    methods.is_empty()
        || methods
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(method.as_str()))
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

/// Strip body-integrity/encoding headers that become invalid once the body is
/// rewritten as plain bytes (the decoded text exposed to a rule, not the
/// original wire bytes). Shared by the rewrite and script paths so that a rule
/// that edits a compressed body never serves plain bytes under the original
/// `content-encoding` (which would corrupt the response).
pub(crate) fn strip_plain_body_edit_header_entries(headers: &mut Vec<ProxyHeaderEntry>) {
    headers.retain(|entry| {
        !entry.name.eq_ignore_ascii_case("content-encoding")
            && !entry.name.eq_ignore_ascii_case("content-md5")
            && !entry.name.eq_ignore_ascii_case("digest")
            && !entry.name.eq_ignore_ascii_case("etag")
    });
}

pub(crate) fn strip_plain_body_edit_headers(headers: &mut HeaderMap) {
    headers.remove("content-encoding");
    headers.remove("content-md5");
    headers.remove("digest");
    headers.remove("etag");
    // NOTE (L1): content-length is intentionally NOT removed here.
    // `build_hyper_response_from_upstream` (http_proxy.rs) drops any pre-existing
    // content-length and lets hyper recompute it from the `Full<Bytes>` body, so
    // a stale value is harmless on the wire (display-only mismatch, tracked as
    // L20 / handled in breakpoints.rs:681). No change needed.
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
    // Decode the whole slice lossily first, then truncate the resulting string
    // at a char boundary so the preview doesn't end mid-character (L6).
    let full = String::from_utf8_lossy(bytes);
    let text = if full.len() > PREVIEW_LIMIT {
        let mut end = PREVIEW_LIMIT;
        while end > 0 && !full.is_char_boundary(end) {
            end -= 1;
        }
        let mut head = full[..end].to_string();
        head.push_str("...");
        head
    } else {
        full.into_owned()
    };
    Some(text)
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

/// Minimal span-preserving JSON reader used to patch individual field values
/// without re-serializing the whole document. It only records byte spans; the
/// body has already been validated by `serde_json` before this runs, so parse
/// failures simply fall back to the lossy path.
struct JsonSpanNode {
    start: usize,
    end: usize,
    kind: JsonSpanKind,
}

enum JsonSpanKind {
    Object(Vec<JsonSpanMember>),
    Array(Vec<JsonSpanNode>),
    Scalar,
}

struct JsonSpanMember {
    key: String,
    value: JsonSpanNode,
}

struct JsonSpanParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonSpanParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            pos: 0,
        }
    }

    fn parse_root(mut self) -> Result<JsonSpanNode, ()> {
        self.skip_ws();
        let node = self.parse_value()?;
        self.skip_ws();
        if self.pos == self.bytes.len() {
            Ok(node)
        } else {
            Err(())
        }
    }

    fn skip_ws(&mut self) {
        while matches!(self.bytes.get(self.pos), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.pos += 1;
        }
    }

    fn parse_value(&mut self) -> Result<JsonSpanNode, ()> {
        self.skip_ws();
        let start = self.pos;
        let kind = match self.bytes.get(self.pos).copied() {
            Some(b'{') => {
                self.pos += 1;
                let mut members = Vec::new();
                self.skip_ws();
                if self.bytes.get(self.pos) == Some(&b'}') {
                    self.pos += 1;
                } else {
                    loop {
                        self.skip_ws();
                        let key = self.parse_string()?;
                        self.skip_ws();
                        self.expect(b':')?;
                        let value = self.parse_value()?;
                        members.push(JsonSpanMember { key, value });
                        self.skip_ws();
                        match self.bytes.get(self.pos).copied() {
                            Some(b',') => self.pos += 1,
                            Some(b'}') => {
                                self.pos += 1;
                                break;
                            }
                            _ => return Err(()),
                        }
                    }
                }
                JsonSpanKind::Object(members)
            }
            Some(b'[') => {
                self.pos += 1;
                let mut items = Vec::new();
                self.skip_ws();
                if self.bytes.get(self.pos) == Some(&b']') {
                    self.pos += 1;
                } else {
                    loop {
                        items.push(self.parse_value()?);
                        self.skip_ws();
                        match self.bytes.get(self.pos).copied() {
                            Some(b',') => self.pos += 1,
                            Some(b']') => {
                                self.pos += 1;
                                break;
                            }
                            _ => return Err(()),
                        }
                    }
                }
                JsonSpanKind::Array(items)
            }
            Some(b'"') => {
                self.parse_string()?;
                JsonSpanKind::Scalar
            }
            Some(b't') => {
                self.expect_literal(b"true")?;
                JsonSpanKind::Scalar
            }
            Some(b'f') => {
                self.expect_literal(b"false")?;
                JsonSpanKind::Scalar
            }
            Some(b'n') => {
                self.expect_literal(b"null")?;
                JsonSpanKind::Scalar
            }
            Some(b'-' | b'0'..=b'9') => {
                while matches!(
                    self.bytes.get(self.pos),
                    Some(b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
                ) {
                    self.pos += 1;
                }
                JsonSpanKind::Scalar
            }
            _ => return Err(()),
        };
        Ok(JsonSpanNode {
            start,
            end: self.pos,
            kind,
        })
    }

    fn parse_string(&mut self) -> Result<String, ()> {
        let start = self.pos;
        self.expect(b'"')?;
        loop {
            match self.bytes.get(self.pos).copied() {
                Some(b'\\') => self.pos += 2,
                Some(b'"') => {
                    self.pos += 1;
                    break;
                }
                Some(_) => self.pos += 1,
                None => return Err(()),
            }
        }
        let raw = std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|_| ())?;
        serde_json::from_str::<String>(raw).map_err(|_| ())
    }

    fn expect(&mut self, byte: u8) -> Result<(), ()> {
        if self.bytes.get(self.pos) == Some(&byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(())
        }
    }

    fn expect_literal(&mut self, literal: &[u8]) -> Result<(), ()> {
        if self.bytes[self.pos..].starts_with(literal) {
            self.pos += literal.len();
            Ok(())
        } else {
            Err(())
        }
    }
}

fn json_span_value<'a>(
    node: &'a JsonSpanNode,
    segments: &[JsonPathSegment],
) -> Option<&'a JsonSpanNode> {
    let mut current = node;
    for segment in segments {
        current = match (&current.kind, segment) {
            (JsonSpanKind::Object(members), JsonPathSegment::Key(key)) => {
                &members.iter().find(|member| member.key == *key)?.value
            }
            (JsonSpanKind::Array(items), JsonPathSegment::Index(index)) => items.get(*index)?,
            _ => return None,
        };
    }
    Some(current)
}

/// Replace only the changed value spans. Returns `None` when any edit cannot be
/// applied byte-precisely (missing path, removal, overlapping edits), in which
/// case the caller keeps the existing serde round-trip behavior.
fn patch_json_field_values(
    body_text: &str,
    edits: &[(Vec<JsonPathSegment>, Value)],
) -> Option<String> {
    if edits.is_empty() {
        return None;
    }
    let root = JsonSpanParser::new(body_text).parse_root().ok()?;
    let mut patches = Vec::with_capacity(edits.len());
    for (segments, value) in edits {
        let node = json_span_value(&root, segments)?;
        patches.push((node.start, node.end, serde_json::to_string(value).ok()?));
    }
    patches.sort_by_key(|patch| patch.0);
    for pair in patches.windows(2) {
        if pair[0].0 == pair[1].0 || pair[0].1 > pair[1].0 {
            return None;
        }
    }
    let mut output = String::with_capacity(body_text.len());
    let mut cursor = 0;
    for (start, end, replacement) in patches {
        output.push_str(&body_text[cursor..start]);
        output.push_str(&replacement);
        cursor = end;
    }
    output.push_str(&body_text[cursor..]);
    Some(output)
}

fn apply_body_field_rewrite(
    body: &[u8],
    content_encoding: Option<&HeaderValue>,
    fields: &[RewriteBodyFieldPayload],
) -> Result<(Vec<u8>, Vec<RewriteTraceEntry>), String> {
    // Upstream bodies keep their wire encoding, so parse the decoded form: a
    // gzip/br JSON response is otherwise unparseable and a Fields rule would fail
    // permanently on exactly the interfaces that compress (the script path
    // already decodes before handing the body over). The caller strips
    // content-encoding because what it writes back is the decoded bytes.
    let decoded = content_encoding
        .and_then(|value| value.to_str().ok())
        .and_then(|encoding| crate::http_io::decode_body_bytes(body, Some(encoding)))
        .unwrap_or_else(|| body.to_vec());
    let body_text = std::str::from_utf8(&decoded)
        .map_err(|error| format!("body field rewrite requires UTF-8 JSON body: {error}"))?;
    let mut json_body: serde_json::Value = serde_json::from_str(body_text)
        .map_err(|error| format!("body field rewrite requires valid JSON body: {error}"))?;
    let original_json = json_body.clone();
    let mut entries = Vec::new();
    let mut patches: Vec<(Vec<JsonPathSegment>, Value)> = Vec::new();
    let mut can_patch = true;

    for (index, field) in fields.iter().enumerate() {
        let segments = parse_json_field_path(&field.path)?;
        let before = get_json_path_value(&json_body, &segments).and_then(json_value_preview);
        let operation = field.operation.as_deref().unwrap_or("set");

        if operation.eq_ignore_ascii_case("remove") {
            can_patch = false;
            remove_json_path_value(&mut json_body, &segments)?;
        } else {
            let value = coerce_body_field_value(field)?;
            if can_patch {
                patches.push((segments.clone(), value.clone()));
            }
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

    // If every action was a no-op, keep the original bytes instead of
    // re-serializing: JSON normalization would change number literals,
    // escaping and whitespace even though the semantic value is unchanged.
    if json_body == original_json {
        return Ok((decoded, entries));
    }

    if can_patch {
        if let Some(patched) = patch_json_field_values(body_text, &patches) {
            return Ok((patched.into_bytes(), entries));
        }
    }

    let rewritten = serde_json::to_vec(&json_body)
        .map_err(|error| format!("serialize rewritten JSON body: {error}"))?;
    Ok((rewritten, entries))
}

fn parse_payload<T: DeserializeOwned>(
    rule_id: &str,
    rewrite_type: &str,
    payload: &Value,
) -> Result<T, String> {
    serde_json::from_value(payload.clone()).map_err(|error| {
        format!(
            "rewrite rule '{}' has an invalid payload for type '{}': {error}",
            rule_id, rewrite_type,
        )
    })
}

/// Expands a rule into its ordered `(rewrite_type, payload)` actions (D2).
/// New-format rows carry an `actions` array; legacy rows carry the
/// `rewrite_type` + `payload` pair and expand to a single action. The returned
/// vec is never empty for a deserialized rule (the legacy shape always has a
/// rewrite_type; a malformed new-format array falls back to the legacy shape).
pub(crate) fn rewrite_actions(rule: &RewriteRule) -> Vec<(String, Value)> {
    if let Some(actions) = rule.actions.as_ref() {
        if !actions.is_empty() {
            let expanded: Vec<(String, Value)> = actions
                .iter()
                .filter_map(|action| {
                    let rewrite_type = action.get("rewriteType")?.as_str()?.to_string();
                    let payload = action.get("payload")?.clone();
                    Some((rewrite_type, payload))
                })
                .collect();
            if !expanded.is_empty() {
                return expanded;
            }
        }
    }
    vec![(rule.rewrite_type.clone(), rule.payload.clone())]
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn apply_request_rewrite_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
    is_http2: bool,
) -> Result<Vec<RewriteTrace>, String> {
    let Some(manager) = rewrite_manager else {
        return Ok(Vec::new());
    };
    apply_request_rewrite_rules_with_snapshot(
        &manager.runtime_snapshot(),
        workspace_id,
        request,
        is_http2,
    )
}

pub(crate) fn apply_request_rewrite_rules_with_snapshot(
    snapshot: &RuntimeRuleSnapshot,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
    is_http2: bool,
) -> Result<Vec<RewriteTrace>, String> {
    let mut traces = Vec::new();

    for rule in active_rewrite_rules_for_snapshot(snapshot, workspace_id, "request", request) {
        let started_at = Instant::now();
        let mut entries = Vec::new();

        let outcome = match apply_one_request_rule(&rule, request, is_http2, &mut entries) {
            Ok(rule_outcome) => rule_outcome,
            Err(error) => {
                entries.push(trace_entry(0, "error", None, None, None, Some(error)));
                "error"
            }
        };

        // After a successful mutation, rebuild the request's derived runtime
        // state (headers / host / path / raw head) so subsequent rules and the
        // upstream forward see a consistent request. A rebuild failure (e.g. a
        // rewrite producing an illegal header name/value, or a redirect URL
        // losing its host) is downgraded to a per-rule error trace and the
        // cascade continues — it does NOT abort the whole request. Aborting
        // would close the connection with no response and no session (R6-3).
        // The request keeps the last successfully-rebuilt state; if a later
        // rule or the upstream forward still trips on the inconsistent state,
        // the forward stage's existing 502-session fallback handles it.
        let outcome = if outcome == "success" {
            match rebuild_request_runtime_state(request) {
                Ok(()) => "success",
                Err(error) => {
                    entries.push(trace_entry(0, "error", None, None, None, Some(error)));
                    "error"
                }
            }
        } else {
            outcome
        };

        traces.push(build_rewrite_trace(
            &rule, "request", started_at, outcome, entries,
        ));
    }

    Ok(traces)
}

/// Applies a single request-stage rewrite rule by running its ordered actions.
///
/// A single action failing (invalid payload, malformed redirect URL, body
/// shape mismatch, ...) records an error entry and the remaining actions still
/// run (R1); the rule only fails outright when every action failed.
///
/// Mirrors the per-rule isolation already used by `apply_*_script_rules`.
fn apply_one_request_rule(
    rule: &RewriteRule,
    request: &mut ParsedProxyRequest,
    is_http2: bool,
    entries: &mut Vec<RewriteTraceEntry>,
) -> Result<&'static str, String> {
    let actions = rewrite_actions(rule);
    let mut any_success = false;
    let mut any_skipped = false;
    let mut first_error: Option<String> = None;

    for (index, (rewrite_type, payload)) in actions.iter().enumerate() {
        let sequence = index as u32;
        match apply_request_action(
            rewrite_type,
            payload,
            &rule.id,
            request,
            is_http2,
            sequence,
            entries,
        ) {
            Ok("success") => any_success = true,
            Ok("skipped") => any_skipped = true,
            Ok(_) => {}
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error.clone());
                }
                entries.push(trace_entry(
                    sequence,
                    "error",
                    None,
                    None,
                    None,
                    Some(error),
                ));
            }
        }
    }

    if any_success {
        Ok("success")
    } else if any_skipped {
        Ok("skipped")
    } else {
        Err(first_error.unwrap_or_else(|| "rewrite rule has no applicable actions".to_string()))
    }
}

/// Applies one request-stage action (a single `(rewrite_type, payload)` pair).
/// Mirrors the old per-rule match body; `sequence` drives the trace entry
/// ordering so multi-action rules keep deterministic traces.
fn apply_request_action(
    rewrite_type: &str,
    payload: &Value,
    rule_id: &str,
    request: &mut ParsedProxyRequest,
    is_http2: bool,
    sequence: u32,
    entries: &mut Vec<RewriteTraceEntry>,
) -> Result<&'static str, String> {
    match rewrite_type {
        "header" => {
            let payload: RewriteHeaderPayload = parse_payload(rule_id, rewrite_type, payload)?;

            if !payload.target.eq_ignore_ascii_case("request") {
                entries.push(trace_entry(
                    sequence,
                    "skip",
                    Some(payload.header_name),
                    None,
                    None,
                    Some("header target does not apply to request stage".to_string()),
                ));
                return Ok("skipped");
            }

            let before = header_entry_value(&request.request_headers, &payload.header_name);
            if payload.operation.eq_ignore_ascii_case("remove") {
                remove_header_entry(&mut request.request_headers, &payload.header_name);
            } else if let Some(value) = payload.value.as_deref() {
                set_header_entry(&mut request.request_headers, &payload.header_name, value);
            }
            let after = header_entry_value(&request.request_headers, &payload.header_name);
            entries.push(trace_entry(
                sequence,
                "header",
                Some(payload.header_name),
                before,
                after,
                Some(payload.operation),
            ));
        }
        "query" => {
            let payload: RewriteQueryPayload = parse_payload(rule_id, rewrite_type, payload)?;
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
                sequence,
                "query",
                Some(param_name),
                before,
                after,
                Some(payload.operation),
            ));
        }
        "body" => {
            let payload: RewriteBodyPayload = parse_payload(rule_id, rewrite_type, payload)?;

            if !payload.target.eq_ignore_ascii_case("request") {
                entries.push(trace_entry(
                    sequence,
                    "skip",
                    Some("body".to_string()),
                    None,
                    None,
                    Some("body target does not apply to request stage".to_string()),
                ));
                return Ok("skipped");
            }

            if is_http2 {
                entries.push(trace_entry(
                    sequence,
                    "skip",
                    Some("body".to_string()),
                    None,
                    None,
                    Some("HTTP/2 body rewrite not supported".to_string()),
                ));
                return Ok("skipped");
            }

            let mode = payload.mode.as_deref().unwrap_or("replace");
            let before = body_preview(&request.body);
            if mode.eq_ignore_ascii_case("fields") {
                let fields = payload.fields.unwrap_or_default();
                let (rewritten_body, field_entries) = apply_body_field_rewrite(
                    &request.body,
                    request.headers.get(CONTENT_ENCODING),
                    &fields,
                )?;
                request.body = rewritten_body;
                entries.extend(field_entries);
            } else {
                request.body = payload.text.unwrap_or_default().into_bytes();
                entries.push(trace_entry(
                    sequence,
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
            let payload: RewriteRedirectPayload = parse_payload(rule_id, rewrite_type, payload)?;
            let before = request.url.to_string();
            let original_path = request.url.path().to_string();
            let original_query = request.url.query().map(str::to_string);
            let mut redirected_url = Url::parse(&payload.target_url).map_err(|error| {
                format!(
                    "rewrite rule '{}' points to an invalid target URL '{}': {error}",
                    rule_id, payload.target_url
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
                sequence,
                "redirect",
                Some("url".to_string()),
                Some(before),
                Some(request.url.to_string()),
                None,
            ));
        }
        _ => {
            entries.push(trace_entry(
                sequence,
                "skip",
                Some(rewrite_type.to_string()),
                None,
                None,
                Some("unsupported rewrite type".to_string()),
            ));
            return Ok("skipped");
        }
    }

    Ok("success")
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn apply_response_rewrite_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    workspace_id: &str,
    request: &ParsedProxyRequest,
    response: &mut UpstreamResponse,
    is_http2: bool,
) -> Result<Vec<RewriteTrace>, String> {
    let Some(manager) = rewrite_manager else {
        return Ok(Vec::new());
    };
    apply_response_rewrite_rules_with_snapshot(
        &manager.runtime_snapshot(),
        workspace_id,
        request,
        response,
        is_http2,
    )
}

pub(crate) fn apply_response_rewrite_rules_with_snapshot(
    snapshot: &RuntimeRuleSnapshot,
    workspace_id: &str,
    request: &ParsedProxyRequest,
    response: &mut UpstreamResponse,
    is_http2: bool,
) -> Result<Vec<RewriteTrace>, String> {
    let mut traces = Vec::new();

    for rule in active_rewrite_rules_for_snapshot(snapshot, workspace_id, "response", request) {
        let started_at = Instant::now();
        let mut entries = Vec::new();

        let outcome = match apply_one_response_rule(&rule, response, is_http2, &mut entries) {
            Ok(rule_outcome) => rule_outcome,
            Err(error) => {
                entries.push(trace_entry(0, "error", None, None, None, Some(error)));
                "error"
            }
        };

        traces.push(build_rewrite_trace(
            &rule, "response", started_at, outcome, entries,
        ));
    }

    Ok(traces)
}

/// Applies a single response-stage rewrite rule by running its ordered
/// actions. A single action failing records an error entry and the remaining
/// actions still run; the rule only fails outright when every action failed.
fn apply_one_response_rule(
    rule: &RewriteRule,
    response: &mut UpstreamResponse,
    is_http2: bool,
    entries: &mut Vec<RewriteTraceEntry>,
) -> Result<&'static str, String> {
    let actions = rewrite_actions(rule);
    let mut any_success = false;
    let mut any_skipped = false;
    let mut first_error: Option<String> = None;

    for (index, (rewrite_type, payload)) in actions.iter().enumerate() {
        let sequence = index as u32;
        match apply_response_action(
            rewrite_type,
            payload,
            &rule.id,
            response,
            is_http2,
            sequence,
            entries,
        ) {
            Ok("success") => any_success = true,
            Ok("skipped") => any_skipped = true,
            Ok(_) => {}
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error.clone());
                }
                entries.push(trace_entry(
                    sequence,
                    "error",
                    None,
                    None,
                    None,
                    Some(error),
                ));
            }
        }
    }

    if any_success {
        Ok("success")
    } else if any_skipped {
        Ok("skipped")
    } else {
        Err(first_error.unwrap_or_else(|| "rewrite rule has no applicable actions".to_string()))
    }
}

/// Applies one response-stage action (a single `(rewrite_type, payload)` pair).
fn apply_response_action(
    rewrite_type: &str,
    payload: &Value,
    rule_id: &str,
    response: &mut UpstreamResponse,
    is_http2: bool,
    sequence: u32,
    entries: &mut Vec<RewriteTraceEntry>,
) -> Result<&'static str, String> {
    match rewrite_type {
        "header" => {
            let payload: RewriteHeaderPayload = parse_payload(rule_id, rewrite_type, payload)?;

            if !payload.target.eq_ignore_ascii_case("response") {
                entries.push(trace_entry(
                    sequence,
                    "skip",
                    Some(payload.header_name),
                    None,
                    None,
                    Some("header target does not apply to response stage".to_string()),
                ));
                return Ok("skipped");
            }

            let before = header_map_value(&response.response_headers, &payload.header_name);
            // Validate the name (and, for a set, the value) BEFORE mutating
            // the headers: previously the existing header was removed first,
            // so an unparsable value silently deleted the header while the
            // trace still recorded a successful "header" entry.
            let name = HeaderName::from_bytes(payload.header_name.as_bytes()).map_err(|error| {
                format!(
                    "rewrite rule '{}' has an invalid header name '{}': {error}",
                    rule_id, payload.header_name
                )
            })?;
            if payload.operation.eq_ignore_ascii_case("remove") {
                response.response_headers.remove(&name);
            } else if let Some(value) = payload.value.as_deref() {
                let header_value = HeaderValue::from_str(value).map_err(|error| {
                    format!(
                        "rewrite rule '{}' has an invalid value for header '{}': {error}",
                        rule_id, payload.header_name
                    )
                })?;
                response.response_headers.remove(&name);
                response.response_headers.insert(name, header_value);
            } else {
                // A "set" without a value behaves as a remove (legacy semantics).
                response.response_headers.remove(&name);
            }
            let after = header_map_value(&response.response_headers, &payload.header_name);
            entries.push(trace_entry(
                sequence,
                "header",
                Some(payload.header_name),
                before,
                after,
                Some(payload.operation),
            ));
        }
        "body" => {
            let payload: RewriteBodyPayload = parse_payload(rule_id, rewrite_type, payload)?;

            if !payload.target.eq_ignore_ascii_case("response") {
                entries.push(trace_entry(
                    sequence,
                    "skip",
                    Some("body".to_string()),
                    None,
                    None,
                    Some("body target does not apply to response stage".to_string()),
                ));
                return Ok("skipped");
            }

            if is_http2 {
                entries.push(trace_entry(
                    sequence,
                    "skip",
                    Some("body".to_string()),
                    None,
                    None,
                    Some("HTTP/2 body rewrite not supported".to_string()),
                ));
                return Ok("skipped");
            }

            let mode = payload.mode.as_deref().unwrap_or("replace");
            let before = body_preview(&response.response_body);
            // M3: snapshot the raw body bytes so we can detect whether this rule
            // actually mutated it. content-encoding/etag/content-md5 must only be
            // stripped when the body genuinely changed — a matching-but-no-op
            // rule must not corrupt integrity headers for clients that validate
            // them (the script path was hardened this way; rewrite was not).
            let body_before = response.response_body.clone();
            if mode.eq_ignore_ascii_case("fields") {
                let fields = payload.fields.unwrap_or_default();
                let (rewritten_body, field_entries) = apply_body_field_rewrite(
                    &response.response_body,
                    response.response_headers.get(CONTENT_ENCODING),
                    &fields,
                )?;
                response.replace_response_body(rewritten_body);
                entries.extend(field_entries);
            } else {
                response.replace_response_body(payload.text.unwrap_or_default().into_bytes());
                entries.push(trace_entry(
                    sequence,
                    "body",
                    Some(CONTENT_TYPE.as_str().to_string()),
                    before,
                    body_preview(&response.response_body),
                    Some(payload.content_type.clone()),
                ));
            }

            // M3: only override content-type and strip integrity headers when the
            // body was actually rewritten.
            if response.response_body != body_before {
                if let Ok(content_type) = HeaderValue::from_str(&payload.content_type) {
                    response.response_headers.insert(CONTENT_TYPE, content_type);
                }
                strip_plain_body_edit_headers(&mut response.response_headers);
            }
        }
        _ => {
            entries.push(trace_entry(
                sequence,
                "skip",
                Some(rewrite_type.to_string()),
                None,
                None,
                Some("rewrite type does not apply to response stage".to_string()),
            ));
            return Ok("skipped");
        }
    }

    Ok("success")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response_header_rule(value: Option<&str>) -> RewriteRule {
        RewriteRule {
            actions: None,
            enabled: true,
            id: "rewrite-response-header".to_string(),
            r#match: RewriteRuleMatch {
                match_type: None,
                methods: Vec::new(),
                stage: "response".to_string(),
                url_pattern: "example.com".to_string(),
            },
            name: "Rewrite response header".to_string(),
            note: None,
            payload: serde_json::json!({
                "headerName": "x-debug",
                "operation": "set",
                "target": "response",
                "value": value,
            }),
            priority: 10,
            rewrite_type: "header".to_string(),
            workspace_id: "default".to_string(),
        }
    }

    fn response_with_debug_header() -> UpstreamResponse {
        let mut response = UpstreamResponse {
            body_truncated: false,
            connect_ms: 0,
            dns_ms: 0,
            connection_reused: None,
            connection_wait_ms: None,
            request_send_ms: None,
            response_body: b"body".to_vec(),
            response_body_size_bytes: 4,
            response_headers: HeaderMap::new(),
            response_read_ms: 0,
            spooled_response_path: None,
            status_code: StatusCode::OK,
            tls_ms: None,
            waiting_ms: 0,
            via_upstream_proxy: None,
        };
        response
            .response_headers
            .insert("x-debug", HeaderValue::from_static("original"));
        response
    }

    // Regression: an invalid header value must fail the action with an error
    // trace entry instead of silently deleting the existing header while the
    // trace still recorded success.
    #[test]
    fn response_header_set_with_invalid_value_fails_and_preserves_header() {
        let rule = response_header_rule(Some("bad\nvalue"));
        let mut response = response_with_debug_header();
        let mut entries = Vec::new();

        let outcome = apply_one_response_rule(&rule, &mut response, false, &mut entries);

        assert!(outcome.is_err(), "invalid value must fail the rule");
        assert!(
            entries.iter().any(|entry| entry.kind == "error"),
            "an error trace entry must be recorded"
        );
        assert_eq!(
            response
                .response_headers
                .get("x-debug")
                .and_then(|value| value.to_str().ok()),
            Some("original"),
            "the existing header must not be removed on validation failure"
        );
    }

    // Regression: an invalid header name must also fail instead of being
    // silently ignored.
    #[test]
    fn response_header_set_with_invalid_name_fails() {
        let mut rule = response_header_rule(Some("value"));
        rule.payload = serde_json::json!({
            "headerName": "bad header name",
            "operation": "set",
            "target": "response",
            "value": "value",
        });
        let mut response = response_with_debug_header();
        let mut entries = Vec::new();

        let outcome = apply_one_response_rule(&rule, &mut response, false, &mut entries);

        assert!(outcome.is_err(), "invalid name must fail the rule");
        assert!(entries.iter().any(|entry| entry.kind == "error"));
    }

    // The valid path still replaces the header and succeeds.
    #[test]
    fn response_header_set_with_valid_value_replaces_header() {
        let rule = response_header_rule(Some("rewritten"));
        let mut response = response_with_debug_header();
        let mut entries = Vec::new();

        let outcome = apply_one_response_rule(&rule, &mut response, false, &mut entries);

        assert_eq!(outcome.ok(), Some("success"));
        assert_eq!(
            response
                .response_headers
                .get("x-debug")
                .and_then(|value| value.to_str().ok()),
            Some("rewritten")
        );
    }

    fn response_body_field_rule() -> RewriteRule {
        RewriteRule {
            actions: None,
            enabled: true,
            id: "rewrite-body-field".to_string(),
            r#match: RewriteRuleMatch {
                match_type: None,
                methods: Vec::new(),
                stage: "response".to_string(),
                url_pattern: "example.com".to_string(),
            },
            name: "Rewrite response body field".to_string(),
            note: None,
            payload: serde_json::json!({
                "contentType": "application/json",
                "fields": [{
                    "operation": "set",
                    "path": "$.user.name",
                    "value": "ada",
                    "valueType": "string",
                }],
                "mode": "fields",
                "target": "response",
            }),
            priority: 10,
            rewrite_type: "body".to_string(),
            workspace_id: "default".to_string(),
        }
    }

    fn gzip_json(plain: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write as _;

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(plain).unwrap();
        encoder.finish().unwrap()
    }

    // P1-7: upstream bodies keep their wire encoding. A Fields rewrite used to
    // parse the gzip bytes as JSON and fail forever on every compressing interface
    // (the script path already decodes). Decode first, then strip
    // content-encoding because plain bytes are written back.
    #[test]
    fn response_body_field_rewrite_handles_gzip_json() {
        let rule = response_body_field_rule();
        let mut response = response_with_debug_header();
        response.replace_response_body(gzip_json(br#"{"user":{"name":"grace"},"keep":1}"#));
        response
            .response_headers
            .insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        response
            .response_headers
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let mut entries = Vec::new();

        let outcome = apply_one_response_rule(&rule, &mut response, false, &mut entries);

        assert_eq!(outcome.ok(), Some("success"), "entries: {entries:?}");
        let body: serde_json::Value = serde_json::from_slice(&response.response_body)
            .expect("rewritten body must be plain JSON");
        assert_eq!(body["user"]["name"], "ada");
        assert_eq!(body["keep"], 1, "untouched fields must survive");
        assert!(
            response.response_headers.get(CONTENT_ENCODING).is_none(),
            "content-encoding must be stripped once plain bytes are written back"
        );
    }

    // P1-8: object key order must survive a Fields rewrite. serde_json's default
    // BTreeMap reordered every key, which breaks APIs that sign the raw JSON
    // string (the user edits one field, the whole body changes order).
    #[test]
    fn body_field_rewrite_patches_only_the_changed_value() {
        let mut rule = response_body_field_rule();
        rule.payload = serde_json::json!({
            "contentType": "application/json",
            "fields": [{
                "operation": "set",
                "path": "$.user.name",
                "value": "ada",
                "valueType": "string",
            }],
            "mode": "fields",
            "target": "response",
        });
        let mut response = response_with_debug_header();
        response.replace_response_body(
            br#"{"user":{"name":"grace"},"amount":1.50,"note":"a\tb","flags":[1, 2.50]}"#.to_vec(),
        );
        response
            .response_headers
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let mut entries = Vec::new();

        let outcome = apply_one_response_rule(&rule, &mut response, false, &mut entries);

        assert_eq!(outcome.ok(), Some("success"), "entries: {entries:?}");
        assert_eq!(
            String::from_utf8(response.response_body.clone()).unwrap(),
            r#"{"user":{"name":"ada"},"amount":1.50,"note":"a\tb","flags":[1, 2.50]}"#,
            "unrelated number literals, escapes and whitespace must be preserved"
        );
    }

    // P2: a no-op Fields rule must not rewrite the whole body just to normalize
    // numbers/whitespace/escapes; signature-sensitive payloads depend on it.
    #[test]
    fn body_field_rewrite_preserves_bytes_when_nothing_changes() {
        let mut rule = response_body_field_rule();
        rule.payload = serde_json::json!({
            "contentType": "application/json",
            "fields": [{
                "operation": "set",
                "path": "$.user.name",
                "value": "grace",
                "valueType": "string",
            }],
            "mode": "fields",
            "target": "response",
        });
        let mut response = response_with_debug_header();
        let original = br#"{"user":{"name":"grace"},"amount":1.50,"note":"a\tb"}"#;
        response.replace_response_body(original.to_vec());
        response
            .response_headers
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let mut entries = Vec::new();

        let outcome = apply_one_response_rule(&rule, &mut response, false, &mut entries);

        assert_eq!(outcome.ok(), Some("success"), "entries: {entries:?}");
        assert_eq!(
            response.response_body.as_slice(),
            original,
            "a no-op field rewrite must keep the original bytes"
        );
    }

    #[test]
    fn response_body_field_rewrite_preserves_key_order() {
        let rule = response_body_field_rule();
        let mut response = response_with_debug_header();
        response.replace_response_body(br#"{"z":1,"a":2,"user":{"name":"grace"}}"#.to_vec());
        response
            .response_headers
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let mut entries = Vec::new();

        let outcome = apply_one_response_rule(&rule, &mut response, false, &mut entries);

        assert_eq!(outcome.ok(), Some("success"), "entries: {entries:?}");
        assert_eq!(
            String::from_utf8(response.response_body.clone()).unwrap(),
            r#"{"z":1,"a":2,"user":{"name":"ada"}}"#,
            "key order must be preserved across a field rewrite"
        );
    }
}
