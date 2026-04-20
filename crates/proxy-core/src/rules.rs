use super::*;

// ---------------------------------------------------------------------------
// Rewrite / Map / Throttle types and managers
// ---------------------------------------------------------------------------

/// A generic rewrite rule matching on URL pattern, methods, and stage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRuleMatch {
    pub methods: Vec<String>,
    pub stage: String,
    pub url_pattern: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRule {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub note: Option<String>,
    pub priority: u32,
    pub r#match: RewriteRuleMatch,
    pub rewrite_type: String,
    pub workspace_id: String,
    pub payload: serde_json::Value,
}

/// A map rule (local or remote) matching on source URL pattern.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapRule {
    pub id: String,
    pub enabled: bool,
    pub mode: String,
    pub name: String,
    pub note: Option<String>,
    pub preserve_path: bool,
    pub preserve_query: bool,
    pub priority: u32,
    pub source_pattern: String,
    pub target_value: String,
    pub workspace_id: String,
}

/// A throttle profile for bandwidth/latency/packet-loss simulation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleProfileData {
    pub id: String,
    pub download_kbps: u32,
    pub enabled: bool,
    pub latency_ms: u32,
    pub name: String,
    pub note: Option<String>,
    pub packet_loss_ratio: f32,
    pub preset: bool,
    pub upload_kbps: u32,
    pub workspace_id: String,
}

/// Manages rewrite rules in memory.
pub struct RewriteManager {
    rules: Mutex<Vec<RewriteRule>>,
}

impl std::fmt::Debug for RewriteManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RewriteManager")
            .field("rules_count", &self.list_rules().len())
            .finish()
    }
}

impl Default for RewriteManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RewriteManager {
    pub fn new() -> Self {
        Self {
            rules: Mutex::new(Vec::new()),
        }
    }

    pub fn set_rules(&self, rules: Vec<RewriteRule>) {
        let mut guard = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        *guard = rules;
    }

    pub fn list_rules(&self) -> Vec<RewriteRule> {
        self.rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn save_rule(&self, rule: RewriteRule) -> RewriteRule {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
            *existing = rule.clone();
        } else {
            rules.push(rule.clone());
        }
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.retain(|r| r.id != rule_id);
    }
}

/// Manages map rules (local + remote) in memory.
pub struct MapManager {
    rules: Mutex<Vec<MapRule>>,
}

impl std::fmt::Debug for MapManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MapManager")
            .field("rules_count", &self.list_rules().len())
            .finish()
    }
}

impl Default for MapManager {
    fn default() -> Self {
        Self::new()
    }
}

impl MapManager {
    pub fn new() -> Self {
        Self {
            rules: Mutex::new(Vec::new()),
        }
    }

    pub fn set_rules(&self, rules: Vec<MapRule>) {
        let mut guard = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        *guard = rules;
    }

    pub fn list_rules(&self) -> Vec<MapRule> {
        self.rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn save_rule(&self, rule: MapRule) -> MapRule {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
            *existing = rule.clone();
        } else {
            rules.push(rule.clone());
        }
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.retain(|r| r.id != rule_id);
    }
}

/// Manages throttle profiles in memory.
pub struct ThrottleManager {
    profiles: Mutex<Vec<ThrottleProfileData>>,
}

impl std::fmt::Debug for ThrottleManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThrottleManager")
            .field("profiles_count", &self.list_profiles().len())
            .finish()
    }
}

impl Default for ThrottleManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ThrottleManager {
    pub fn new() -> Self {
        Self {
            profiles: Mutex::new(Vec::new()),
        }
    }

    pub fn set_profiles(&self, profiles: Vec<ThrottleProfileData>) {
        let mut guard = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        *guard = profiles;
    }

    pub fn list_profiles(&self) -> Vec<ThrottleProfileData> {
        self.profiles.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn save_profile(&self, profile: ThrottleProfileData) -> ThrottleProfileData {
        let mut profiles = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        profile
    }

    pub fn delete_profile(&self, profile_id: &str) {
        let mut profiles = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        profiles.retain(|p| p.id != profile_id);
    }

    pub fn set_active_profile(&self, workspace_id: &str, profile_id: Option<&str>) {
        let mut profiles = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        for profile in profiles.iter_mut() {
            if profile.workspace_id == workspace_id {
                profile.enabled = match profile_id {
                    Some(id) => profile.id == id,
                    None => false,
                };
            }
        }
    }
}

/// A DNS mapping rule that overrides hostname resolution to a custom IP.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DnsMappingRule {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub note: Option<String>,
    pub priority: u32,
    pub host_pattern: String,
    pub target_ip: String,
    pub workspace_id: String,
}

/// Manages DNS mapping rules in memory.
pub struct DnsManager {
    rules: Mutex<Vec<DnsMappingRule>>,
}

impl std::fmt::Debug for DnsManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DnsManager")
            .field("rules_count", &self.list_rules().len())
            .finish()
    }
}

impl Default for DnsManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DnsManager {
    pub fn new() -> Self {
        Self {
            rules: Mutex::new(Vec::new()),
        }
    }

    pub fn set_rules(&self, rules: Vec<DnsMappingRule>) {
        let mut guard = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        *guard = rules;
    }

    pub fn list_rules(&self) -> Vec<DnsMappingRule> {
        self.rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn save_rule(&self, rule: DnsMappingRule) -> DnsMappingRule {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
            *existing = rule.clone();
        } else {
            rules.push(rule.clone());
        }
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.retain(|r| r.id != rule_id);
    }
}

/// Look up a DNS override for the given hostname. Returns the target IP if a
/// matching, enabled rule is found (highest priority first).
pub(crate) fn resolve_dns_override(
    dns_manager: &Option<std::sync::Arc<DnsManager>>,
    workspace_id: &str,
    hostname: &str,
) -> Option<std::net::IpAddr> {
    let manager = dns_manager.as_ref()?;
    let rules = manager.list_rules();
    let mut matched: Vec<&DnsMappingRule> = rules
        .iter()
        .filter(|r| r.enabled && r.workspace_id == workspace_id && pattern_matches(&r.host_pattern, hostname))
        .collect();
    matched.sort_by(|a, b| b.priority.cmp(&a.priority));
    let rule = matched.first()?;
    rule.target_ip.parse().ok()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewriteHeaderPayload {
    header_name: String,
    operation: String,
    target: String,
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewriteQueryPayload {
    operation: String,
    param_name: String,
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewriteBodyPayload {
    content_type: String,
    target: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewriteRedirectPayload {
    preserve_path: bool,
    preserve_query: bool,
    target_url: String,
}

#[derive(Debug)]
pub(crate) struct RequestRuntimeOutcome {
    pub(crate) local_response: Option<UpstreamResponse>,
    pub(crate) throttle_profile: Option<ThrottleProfileData>,
}

#[derive(Debug)]
pub(crate) struct RequestScriptOutcome {
    pub(crate) local_response: Option<UpstreamResponse>,
    pub(crate) traces: Vec<ScriptTrace>,
}

fn pattern_matches(pattern: &str, candidate: &str) -> bool {
    let normalized = pattern.trim();

    if normalized.is_empty() || normalized == "*" {
        return true;
    }

    if !normalized.contains('*') {
        return candidate.contains(normalized);
    }

    let parts: Vec<&str> = normalized.split('*').filter(|part| !part.is_empty()).collect();

    if parts.is_empty() {
        return true;
    }

    let mut search_start = 0_usize;

    for (index, part) in parts.iter().enumerate() {
        if let Some(relative_index) = candidate[search_start..].find(part) {
            let absolute_index = search_start + relative_index;

            if index == 0 && !normalized.starts_with('*') && absolute_index != 0 {
                return false;
            }

            search_start = absolute_index + part.len();
        } else {
            return false;
        }
    }

    if normalized.ends_with('*') {
        return true;
    }

    if let Some(last) = parts.last() {
        return candidate.ends_with(last);
    }

    true
}

fn method_matches(methods: &[String], method: &Method) -> bool {
    methods.is_empty()
        || methods
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(method.as_str()))
}

fn rewrite_stage_matches(rule_stage: &str, current_stage: &str) -> bool {
    rule_stage.eq_ignore_ascii_case("either") || rule_stage.eq_ignore_ascii_case(current_stage)
}

fn active_rewrite_rules_for_stage(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    workspace_id: &str,
    stage: &str,
    request: &ParsedProxyRequest,
) -> Vec<RewriteRule> {
    let Some(manager) = rewrite_manager else {
        return Vec::new();
    };

    let mut rules: Vec<RewriteRule> = manager
        .list_rules()
        .into_iter()
        .filter(|rule| rule.enabled)
        .filter(|rule| rule.workspace_id == workspace_id)
        .filter(|rule| rewrite_stage_matches(&rule.r#match.stage, stage))
        .filter(|rule| method_matches(&rule.r#match.methods, &request.method))
        .filter(|rule| pattern_matches(&rule.r#match.url_pattern, request.url.as_str()))
        .collect();

    rules.sort_by(|left, right| right.priority.cmp(&left.priority));
    rules
}

fn active_map_rule_for_request(
    map_manager: &Option<Arc<MapManager>>,
    workspace_id: &str,
    request: &ParsedProxyRequest,
) -> Option<MapRule> {
    let Some(manager) = map_manager else {
        return None;
    };

    let mut rules: Vec<MapRule> = manager
        .list_rules()
        .into_iter()
        .filter(|rule| rule.enabled)
        .filter(|rule| rule.workspace_id == workspace_id)
        .filter(|rule| pattern_matches(&rule.source_pattern, request.url.as_str()))
        .collect();

    rules.sort_by(|left, right| right.priority.cmp(&left.priority));
    rules.into_iter().next()
}

fn active_script_rules_for_stage(
    script_manager: &Option<Arc<ScriptManager>>,
    workspace_id: &str,
    stage: &str,
    request: &ParsedProxyRequest,
) -> Vec<CompiledScriptRule> {
    let Some(manager) = script_manager else {
        return Vec::new();
    };

    let mut rules: Vec<CompiledScriptRule> = manager
        .compiled_rules()
        .into_iter()
        .filter(|rule| rule.rule.enabled)
        .filter(|rule| rule.rule.workspace_id == workspace_id)
        .filter(|rule| rewrite_stage_matches(&rule.rule.r#match.stage, stage))
        .filter(|rule| method_matches(&rule.rule.r#match.methods, &request.method))
        .filter(|rule| pattern_matches(&rule.rule.r#match.url_pattern, request.url.as_str()))
        .collect();

    rules.sort_by(|left, right| right.rule.priority.cmp(&left.rule.priority));
    rules
}

pub(crate) fn active_throttle_profile_for_workspace(
    throttle_manager: &Option<Arc<ThrottleManager>>,
    workspace_id: &str,
) -> Option<ThrottleProfileData> {
    let Some(manager) = throttle_manager else {
        return None;
    };

    manager
        .list_profiles()
        .into_iter()
        .find(|profile| profile.workspace_id == workspace_id && profile.enabled)
}

fn parse_rewrite_payload<T: DeserializeOwned>(rule: &RewriteRule) -> Result<T, String> {
    serde_json::from_value(rule.payload.clone()).map_err(|error| {
        format!(
            "rewrite rule '{}' has an invalid payload for type '{}': {error}",
            rule.id,
            rule.rewrite_type,
        )
    })
}

pub(crate) fn host_header_value(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    }
}

fn script_headers_from_entries(entries: &[ProxyHeaderEntry]) -> Vec<ScriptHeader> {
    entries
        .iter()
        .map(|entry| ScriptHeader {
            name: entry.name.clone(),
            value: entry.value.clone(),
        })
        .collect()
}

fn script_headers_from_map(headers: &HeaderMap) -> Vec<ScriptHeader> {
    build_header_entries_from_map(headers)
        .into_iter()
        .map(|entry| ScriptHeader {
            name: entry.name,
            value: entry.value,
        })
        .collect()
}

fn body_text_and_base64(
    body: &[u8],
    content_type: Option<&HeaderValue>,
    content_encoding: Option<&HeaderValue>,
) -> (Option<String>, Option<String>, Option<String>) {
    match build_body_reference(body, content_type, content_encoding, body.len(), false) {
        Some(reference) => (
            reference.inline_text(),
            reference.base64_text(),
            reference.mime_type.clone(),
        ),
        None => (None, None, None),
    }
}

fn build_script_request(
    workspace_id: &str,
    stage: ScriptTraceStage,
    request: &ParsedProxyRequest,
) -> (ScriptSessionInfo, ScriptRequest) {
    let (body_text, body_base64, mime_type) = body_text_and_base64(
        &request.body,
        request.headers.get(CONTENT_TYPE),
        request.headers.get(reqwest::header::CONTENT_ENCODING),
    );

    (
        ScriptSessionInfo {
            id: request.request_id.clone(),
            host: request.host.clone(),
            method: request.method.to_string(),
            path: request.path.clone(),
            stage,
            url: request.url.to_string(),
            workspace_id: workspace_id.to_string(),
        },
        ScriptRequest {
            body_base64,
            body_text,
            headers: script_headers_from_entries(&request.request_headers),
            method: request.method.to_string(),
            mime_type,
            url: request.url.to_string(),
        },
    )
}

fn build_script_response(response: &UpstreamResponse) -> ScriptResponse {
    let (body_text, body_base64, mime_type) = body_text_and_base64(
        &response.response_body,
        response.response_headers.get(CONTENT_TYPE),
        response
            .response_headers
            .get(reqwest::header::CONTENT_ENCODING),
    );

    ScriptResponse {
        body_base64,
        body_text,
        headers: script_headers_from_map(&response.response_headers),
        mime_type,
        status: response.status_code.as_u16(),
    }
}

fn bytes_from_script_body(body_text: Option<String>, body_base64: Option<String>) -> Result<Vec<u8>, String> {
    if let Some(text) = body_text {
        return Ok(text.into_bytes());
    }

    if let Some(base64_text) = body_base64 {
        return BASE64_STANDARD
            .decode(base64_text)
            .map_err(|error| format!("decode script body base64: {error}"));
    }

    Ok(Vec::new())
}

fn header_map_from_script_headers(headers: &[ScriptHeader]) -> HeaderMap {
    let mut header_map = HeaderMap::new();
    for header in headers {
        if let Ok(name) = HeaderName::from_bytes(header.name.as_bytes()) {
            if let Ok(value) = HeaderValue::from_str(&header.value) {
                header_map.append(name, value);
            }
        }
    }
    header_map
}

fn apply_script_request_to_runtime(
    request: &mut ParsedProxyRequest,
    script_request: ScriptRequest,
) -> Result<(), String> {
    request.method = Method::from_bytes(script_request.method.as_bytes())
        .map_err(|error| format!("invalid script request method '{}': {error}", script_request.method))?;
    request.url = Url::parse(&script_request.url)
        .map_err(|error| format!("invalid script request url '{}': {error}", script_request.url))?;
    request.request_headers = script_request
        .headers
        .into_iter()
        .map(|header| ProxyHeaderEntry {
            name: header.name,
            value: header.value,
        })
        .collect();
    request.body = bytes_from_script_body(script_request.body_text, script_request.body_base64)?;
    rebuild_request_runtime_state(request)
}

fn apply_script_response_to_runtime(
    response: &mut UpstreamResponse,
    script_response: ScriptResponse,
) -> Result<(), String> {
    response.status_code = StatusCode::from_u16(script_response.status)
        .map_err(|error| format!("invalid script response status '{}': {error}", script_response.status))?;
    response.response_headers = header_map_from_script_headers(&script_response.headers);
    response.replace_response_body(bytes_from_script_body(
        script_response.body_text,
        script_response.body_base64,
    )?);
    Ok(())
}

fn upstream_response_from_override(override_response: ScriptResponseOverride) -> Result<UpstreamResponse, String> {
    let response_body =
        bytes_from_script_body(override_response.body_text, override_response.body_base64)?;

    Ok(UpstreamResponse {
        body_truncated: false,
        response_body_size_bytes: response_body.len(),
        response_body,
        response_headers: header_map_from_script_headers(&override_response.headers),
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::from_u16(override_response.status)
            .map_err(|error| format!("invalid mock response status '{}': {error}", override_response.status))?,
        waiting_ms: 0,
    })
}

fn invalid_trace(
    mut trace: ScriptTrace,
    message: String,
) -> ScriptTrace {
    let next_sequence = trace.entries.len() as u32;
    trace.outcome = ScriptRunOutcome::InvalidResult;
    trace.entries.push(ScriptRunEntry {
        kind: ScriptRunEntryKind::Error,
        key: None,
        level: Some(ScriptLogLevel::Error),
        message: Some(message),
        payload_json: None,
        sequence: next_sequence,
    });
    trace
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
    });
}

fn remove_header_entry(headers: &mut Vec<ProxyHeaderEntry>, name: &str) {
    headers.retain(|entry| !entry.name.eq_ignore_ascii_case(name));
}

fn rebuild_request_runtime_state(request: &mut ParsedProxyRequest) -> Result<(), String> {
    request.headers = build_upstream_headers_from_entries(&request.request_headers)?;
    request.host = request
        .url
        .host_str()
        .ok_or_else(|| "request URL does not contain a host after runtime transformation".to_string())?
        .to_string();
    request.path = build_request_path(&request.url);
    request.protocol = request.url.scheme().to_string();
    request.query_params = build_query_params(&request.url);
    set_header_entry(&mut request.request_headers, "Host", &host_header_value(&request.url));
    request.raw_request = build_raw_http_head(
        &format!("{} {} HTTP/1.1", request.method.as_str(), request.path),
        &request.request_headers,
    );

    Ok(())
}

pub(crate) fn apply_request_rewrite_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
) -> Result<(), String> {
    for rule in active_rewrite_rules_for_stage(rewrite_manager, workspace_id, "request", request) {
        match rule.rewrite_type.as_str() {
            "header" => {
                let payload: RewriteHeaderPayload = parse_rewrite_payload(&rule)?;

                if !payload.target.eq_ignore_ascii_case("request") {
                    continue;
                }

                if payload.operation.eq_ignore_ascii_case("remove") {
                    remove_header_entry(&mut request.request_headers, &payload.header_name);
                } else if let Some(value) = payload.value.as_deref() {
                    set_header_entry(&mut request.request_headers, &payload.header_name, value);
                }
            }
            "query" => {
                let payload: RewriteQueryPayload = parse_rewrite_payload(&rule)?;
                let mut query_pairs: Vec<(String, String)> = request
                    .url
                    .query_pairs()
                    .map(|(name, value)| (name.into_owned(), value.into_owned()))
                    .collect();

                query_pairs.retain(|(name, _)| !name.eq_ignore_ascii_case(&payload.param_name));

                if !payload.operation.eq_ignore_ascii_case("remove") {
                    query_pairs.push((
                        payload.param_name,
                        payload.value.unwrap_or_default(),
                    ));
                }

                request.url.set_query(None);
                if !query_pairs.is_empty() {
                    let mut pairs = request.url.query_pairs_mut();
                    for (name, value) in &query_pairs {
                        pairs.append_pair(name, value);
                    }
                }
            }
            "body" => {
                let payload: RewriteBodyPayload = parse_rewrite_payload(&rule)?;

                if !payload.target.eq_ignore_ascii_case("request") {
                    continue;
                }

                request.body = payload.text.into_bytes();
                set_header_entry(
                    &mut request.request_headers,
                    CONTENT_TYPE.as_str(),
                    &payload.content_type,
                );
            }
            "redirect" => {
                let payload: RewriteRedirectPayload = parse_rewrite_payload(&rule)?;
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
            }
            _ => {}
        }

        rebuild_request_runtime_state(request)?;
    }

    Ok(())
}

pub(crate) fn apply_response_rewrite_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    workspace_id: &str,
    request: &ParsedProxyRequest,
    response: &mut UpstreamResponse,
) -> Result<(), String> {
    for rule in active_rewrite_rules_for_stage(rewrite_manager, workspace_id, "response", request) {
        match rule.rewrite_type.as_str() {
            "header" => {
                let payload: RewriteHeaderPayload = parse_rewrite_payload(&rule)?;

                if !payload.target.eq_ignore_ascii_case("response") {
                    continue;
                }

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
            }
            "body" => {
                let payload: RewriteBodyPayload = parse_rewrite_payload(&rule)?;

                if !payload.target.eq_ignore_ascii_case("response") {
                    continue;
                }

                response.replace_response_body(payload.text.into_bytes());

                if let Ok(content_type) = HeaderValue::from_str(&payload.content_type) {
                    response.response_headers.insert(CONTENT_TYPE, content_type);
                }
            }
            _ => {}
        }
    }

    Ok(())
}

pub(crate) fn apply_request_script_rules(
    script_manager: &Option<Arc<ScriptManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
) -> RequestScriptOutcome {
    let mut local_response = None;
    let mut traces = Vec::new();

    for rule in active_script_rules_for_stage(script_manager, workspace_id, "request", request) {
        let (session, script_request) =
            build_script_request(workspace_id, ScriptTraceStage::Request, request);
        let result = execute_request_hook(
            &rule,
            ScriptHookPayload {
                request: script_request,
                response: None,
                session,
            },
        );

        let mut trace = result.trace;

        if let Some(response_override) = result.response_override {
            match upstream_response_from_override(response_override) {
                Ok(response) => {
                    local_response = Some(response);
                    traces.push(trace);
                    break;
                }
                Err(error) => {
                    traces.push(invalid_trace(trace, error));
                    continue;
                }
            }
        }

        if let Some(script_request) = result.request {
            if let Err(error) = apply_script_request_to_runtime(request, script_request) {
                trace = invalid_trace(trace, error);
            }
        }

        traces.push(trace);
    }

    RequestScriptOutcome {
        local_response,
        traces,
    }
}

pub(crate) fn apply_response_script_rules(
    script_manager: &Option<Arc<ScriptManager>>,
    workspace_id: &str,
    request: &ParsedProxyRequest,
    response: &mut UpstreamResponse,
) -> Vec<ScriptTrace> {
    let mut traces = Vec::new();

    for rule in active_script_rules_for_stage(script_manager, workspace_id, "response", request) {
        let (session, script_request) =
            build_script_request(workspace_id, ScriptTraceStage::Response, request);
        let result = execute_response_hook(
            &rule,
            ScriptHookPayload {
                request: script_request,
                response: Some(build_script_response(response)),
                session,
            },
        );

        let mut trace = result.trace;

        if let Some(script_response) = result.response {
            if let Err(error) = apply_script_response_to_runtime(response, script_response) {
                trace = invalid_trace(trace, error);
            }
        }

        traces.push(trace);
    }

    traces
}

fn apply_remote_map_rule(request: &mut ParsedProxyRequest, rule: &MapRule) -> Result<(), String> {
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

    request.url = mapped_url;
    rebuild_request_runtime_state(request)
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
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
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
        response_body_size_bytes: body.len(),
        response_body: body,
        response_headers: headers,
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::OK,
        waiting_ms: 0,
    })
}

fn apply_local_map_rule(request: &ParsedProxyRequest, rule: &MapRule) -> Result<UpstreamResponse, String> {
    let target_path = PathBuf::from(&rule.target_value);

    if target_path.is_file() {
        return build_local_file_response(&target_path);
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
        return build_local_file_response(&resolved_path);
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
) -> Result<Option<UpstreamResponse>, String> {
    let Some(rule) = active_map_rule_for_request(map_manager, workspace_id, request) else {
        return Ok(None);
    };

    match rule.mode.as_str() {
        "local" => apply_local_map_rule(request, &rule).map(Some),
        "remote" => {
            apply_remote_map_rule(request, &rule)?;
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn normalize_packet_loss_ratio(packet_loss_ratio: f32) -> f32 {
    if packet_loss_ratio <= 1.0 {
        packet_loss_ratio.max(0.0)
    } else {
        (packet_loss_ratio / 100.0).clamp(0.0, 1.0)
    }
}

fn should_drop_for_packet_loss(profile: &ThrottleProfileData) -> bool {
    let normalized = normalize_packet_loss_ratio(profile.packet_loss_ratio);

    if normalized <= 0.0 {
        return false;
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let sample = (nanos % 10_000) as f32 / 10_000.0;

    sample < normalized
}

fn transfer_delay_ms(byte_count: usize, kbps: u32) -> u64 {
    if byte_count == 0 || kbps == 0 {
        return 0;
    }

    let bits = (byte_count as u128) * 8;
    let bits_per_second = (kbps as u128) * 1024;
    let millis = (bits * 1_000).div_ceil(bits_per_second);

    millis as u64
}

pub(crate) async fn apply_request_throttle(
    profile: &ThrottleProfileData,
    body_len: usize,
) -> Result<(), String> {
    if should_drop_for_packet_loss(profile) {
        return Err(format!(
            "request dropped by throttle profile '{}'",
            profile.name
        ));
    }

    let latency_ms = profile.latency_ms as u64;
    let upload_delay_ms = transfer_delay_ms(body_len, profile.upload_kbps);

    if latency_ms > 0 {
        sleep(Duration::from_millis(latency_ms)).await;
    }
    if upload_delay_ms > 0 {
        sleep(Duration::from_millis(upload_delay_ms)).await;
    }

    Ok(())
}

pub(crate) async fn apply_response_throttle(profile: &ThrottleProfileData, body_len: usize) {
    let latency_ms = profile.latency_ms as u64;
    let download_delay_ms = transfer_delay_ms(body_len, profile.download_kbps);

    if latency_ms > 0 {
        sleep(Duration::from_millis(latency_ms)).await;
    }
    if download_delay_ms > 0 {
        sleep(Duration::from_millis(download_delay_ms)).await;
    }
}

pub(crate) fn apply_request_runtime_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    map_manager: &Option<Arc<MapManager>>,
    throttle_manager: &Option<Arc<ThrottleManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
) -> Result<RequestRuntimeOutcome, String> {
    apply_request_rewrite_rules(rewrite_manager, workspace_id, request)?;
    let local_response = apply_map_rules(map_manager, workspace_id, request)?;
    let throttle_profile = active_throttle_profile_for_workspace(throttle_manager, workspace_id);

    Ok(RequestRuntimeOutcome {
        local_response,
        throttle_profile,
    })
}
