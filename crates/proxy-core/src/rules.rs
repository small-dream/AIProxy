use super::*;
use regex::Regex;

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
    #[serde(default)]
    pub match_type: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteTraceEntry {
    pub after: Option<String>,
    pub before: Option<String>,
    pub kind: String,
    pub key: Option<String>,
    pub message: Option<String>,
    pub sequence: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewriteTrace {
    pub duration_ms: u128,
    pub entries: Vec<RewriteTraceEntry>,
    pub outcome: String,
    pub rule_id: String,
    pub rule_name: String,
    pub rewrite_type: String,
    pub stage: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MapTrace {
    pub duration_ms: u128,
    pub local_path: Option<String>,
    pub mapped_url: Option<String>,
    pub mode: String,
    pub original_url: String,
    pub outcome: String,
    pub rule_id: String,
    pub rule_name: String,
    pub source_pattern: String,
    pub target_value: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleRuleData {
    pub id: String,
    pub enabled: bool,
    pub methods: Vec<String>,
    pub name: String,
    pub note: Option<String>,
    pub priority: u32,
    pub profile_id: String,
    pub stage: String,
    pub url_pattern: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleTrace {
    pub body_bytes: usize,
    pub delay_ms: u64,
    pub latency_ms: u64,
    pub message: Option<String>,
    pub outcome: String,
    pub profile_id: String,
    pub profile_name: String,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub sequence: u32,
    pub stage: String,
    pub transfer_delay_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleRuntimeStats {
    pub dropped_requests: u64,
    pub matched_requests: u64,
    pub request_delay_ms: u64,
    pub response_delay_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ThrottleRuntimeSelection {
    pub(crate) profile: ThrottleProfileData,
    pub(crate) rule: Option<ThrottleRuleData>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ThrottleFailure {
    pub(crate) error: String,
    pub(crate) trace: ThrottleTrace,
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
    rules: Mutex<Vec<ThrottleRuleData>>,
    stats: Mutex<ThrottleRuntimeStats>,
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
            rules: Mutex::new(Vec::new()),
            stats: Mutex::new(ThrottleRuntimeStats {
                dropped_requests: 0,
                matched_requests: 0,
                request_delay_ms: 0,
                response_delay_ms: 0,
            }),
        }
    }

    pub fn set_profiles(&self, profiles: Vec<ThrottleProfileData>) {
        let mut guard = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        *guard = profiles;
    }

    pub fn list_profiles(&self) -> Vec<ThrottleProfileData> {
        self.profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
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

    pub fn set_rules(&self, rules: Vec<ThrottleRuleData>) {
        let mut guard = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        *guard = rules;
    }

    pub fn list_rules(&self) -> Vec<ThrottleRuleData> {
        self.rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn save_rule(&self, rule: ThrottleRuleData) -> ThrottleRuleData {
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

    pub fn runtime_stats(&self) -> ThrottleRuntimeStats {
        self.stats.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub(crate) fn record_trace(&self, trace: &ThrottleTrace) {
        let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        if trace.stage == "request" {
            stats.matched_requests = stats.matched_requests.saturating_add(1);
            stats.request_delay_ms = stats.request_delay_ms.saturating_add(trace.delay_ms);
            if trace.outcome == "dropped" {
                stats.dropped_requests = stats.dropped_requests.saturating_add(1);
            }
        } else {
            stats.response_delay_ms = stats.response_delay_ms.saturating_add(trace.delay_ms);
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
    let rules = manager.rules.lock().unwrap_or_else(|e| e.into_inner());
    let rule = rules
        .iter()
        .filter(|r| {
            r.enabled
                && r.workspace_id == workspace_id
                && pattern_matches(&r.host_pattern, hostname, None)
        })
        .max_by_key(|r| r.priority)?;
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
    fields: Option<Vec<RewriteBodyFieldPayload>>,
    mode: Option<String>,
    target: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RewriteBodyFieldPayload {
    operation: Option<String>,
    path: String,
    value: Option<String>,
    value_type: Option<String>,
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
    pub(crate) map_traces: Vec<MapTrace>,
    pub(crate) rewrite_traces: Vec<RewriteTrace>,
    pub(crate) throttle_selection: Option<ThrottleRuntimeSelection>,
}

#[derive(Debug)]
pub(crate) struct RequestScriptOutcome {
    pub(crate) local_response: Option<UpstreamResponse>,
    pub(crate) traces: Vec<ScriptTrace>,
}

pub(crate) fn pattern_matches(pattern: &str, candidate: &str, match_type: Option<&str>) -> bool {
    let normalized = pattern.trim();

    match match_type.unwrap_or("contains") {
        "exact" => candidate == normalized,
        "regex" => Regex::new(normalized).is_ok_and(|re| re.is_match(candidate)),
        "wildcard" => {
            if normalized.is_empty() || normalized == "*" {
                return true;
            }

            let parts: Vec<&str> = normalized
                .split('*')
                .filter(|part| !part.is_empty())
                .collect();

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
        _ => {
            // "contains" or unknown — substring match
            if normalized.is_empty() || normalized == "*" {
                return true;
            }
            candidate.contains(normalized)
        }
    }
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
        .filter(|rule| pattern_matches(&rule.r#match.url_pattern, request.url.as_str(), rule.r#match.match_type.as_deref()))
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
        .filter(|rule| pattern_matches(&rule.source_pattern, request.url.as_str(), None))
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
        .filter(|rule| pattern_matches(&rule.rule.r#match.url_pattern, request.url.as_str(), None))
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

fn throttle_stage_matches(rule_stage: &str, current_stage: &str) -> bool {
    let normalized = rule_stage.trim();
    normalized.is_empty()
        || normalized.eq_ignore_ascii_case("both")
        || normalized.eq_ignore_ascii_case("either")
        || normalized.eq_ignore_ascii_case(current_stage)
}

pub(crate) fn throttle_selection_matches_stage(
    selection: &ThrottleRuntimeSelection,
    stage: &str,
) -> bool {
    selection
        .rule
        .as_ref()
        .map(|rule| throttle_stage_matches(&rule.stage, stage))
        .unwrap_or(true)
}

fn active_throttle_selection_for_request(
    throttle_manager: &Option<Arc<ThrottleManager>>,
    workspace_id: &str,
    request: &ParsedProxyRequest,
) -> Option<ThrottleRuntimeSelection> {
    let manager = throttle_manager.as_ref()?;
    let profiles = manager.list_profiles();
    let mut rules: Vec<ThrottleRuleData> = manager
        .list_rules()
        .into_iter()
        .filter(|rule| rule.enabled)
        .filter(|rule| rule.workspace_id == workspace_id)
        .filter(|rule| {
            throttle_stage_matches(&rule.stage, "request")
                || throttle_stage_matches(&rule.stage, "response")
        })
        .filter(|rule| method_matches(&rule.methods, &request.method))
        .filter(|rule| {
            pattern_matches(&rule.url_pattern, request.url.as_str(), None)
                || pattern_matches(&rule.url_pattern, &request.host, None)
        })
        .collect();

    rules.sort_by(|left, right| right.priority.cmp(&left.priority));

    for rule in rules {
        if let Some(profile) = profiles
            .iter()
            .find(|profile| profile.workspace_id == workspace_id && profile.id == rule.profile_id)
            .cloned()
        {
            return Some(ThrottleRuntimeSelection {
                profile,
                rule: Some(rule),
            });
        }
    }

    active_throttle_profile_for_workspace(throttle_manager, workspace_id).map(|profile| {
        ThrottleRuntimeSelection {
            profile,
            rule: None,
        }
    })
}

fn parse_rewrite_payload<T: DeserializeOwned>(rule: &RewriteRule) -> Result<T, String> {
    serde_json::from_value(rule.payload.clone()).map_err(|error| {
        format!(
            "rewrite rule '{}' has an invalid payload for type '{}': {error}",
            rule.id, rule.rewrite_type,
        )
    })
}

#[derive(Debug)]
enum JsonPathSegment {
    Index(usize),
    Key(String),
}

fn parse_json_field_path(path: &str) -> Result<Vec<JsonPathSegment>, String> {
    let mut normalized = path.trim();
    if normalized == "$" {
        return Err("body field path must point to a JSON field".to_string());
    }
    if let Some(stripped) = normalized.strip_prefix("$.") {
        normalized = stripped;
    } else if let Some(stripped) = normalized.strip_prefix('$') {
        normalized = stripped.strip_prefix('.').unwrap_or(stripped);
    }

    if normalized.is_empty() {
        return Err("body field path is empty".to_string());
    }

    let chars: Vec<char> = normalized.chars().collect();
    let mut segments = Vec::new();
    let mut key = String::new();
    let mut index = 0;

    while index < chars.len() {
        match chars[index] {
            '.' => {
                if key.is_empty() {
                    if segments.is_empty() || index + 1 >= chars.len() || chars[index + 1] == '.' {
                        return Err(format!(
                            "body field path '{path}' contains an empty segment"
                        ));
                    }
                    index += 1;
                    continue;
                }
                segments.push(JsonPathSegment::Key(std::mem::take(&mut key)));
                index += 1;
            }
            '[' => {
                if !key.is_empty() {
                    segments.push(JsonPathSegment::Key(std::mem::take(&mut key)));
                }
                index += 1;
                let start = index;
                while index < chars.len() && chars[index] != ']' {
                    index += 1;
                }
                if index >= chars.len() || start == index {
                    return Err(format!(
                        "body field path '{path}' contains an invalid array index"
                    ));
                }
                let raw_index: String = chars[start..index].iter().collect();
                let array_index = raw_index.parse::<usize>().map_err(|_| {
                    format!("body field path '{path}' contains a non-numeric array index")
                })?;
                segments.push(JsonPathSegment::Index(array_index));
                index += 1;
            }
            ']' => {
                return Err(format!(
                    "body field path '{path}' contains an unmatched ']'"
                ))
            }
            c => {
                key.push(c);
                index += 1;
            }
        }
    }

    if !key.is_empty() {
        segments.push(JsonPathSegment::Key(key));
    }
    if segments.is_empty() {
        return Err("body field path is empty".to_string());
    }

    Ok(segments)
}

fn json_value_preview(value: &serde_json::Value) -> Option<String> {
    serde_json::to_string(value).ok()
}

fn get_json_path_value<'a>(
    root: &'a serde_json::Value,
    segments: &[JsonPathSegment],
) -> Option<&'a serde_json::Value> {
    let mut current = root;
    for segment in segments {
        match segment {
            JsonPathSegment::Key(key) => current = current.as_object()?.get(key)?,
            JsonPathSegment::Index(index) => current = current.as_array()?.get(*index)?,
        }
    }
    Some(current)
}

fn coerce_body_field_value(field: &RewriteBodyFieldPayload) -> Result<serde_json::Value, String> {
    let raw_value = field.value.as_deref().unwrap_or_default();
    match field
        .value_type
        .as_deref()
        .unwrap_or("string")
        .to_ascii_lowercase()
        .as_str()
    {
        "boolean" => raw_value
            .parse::<bool>()
            .map(serde_json::Value::Bool)
            .map_err(|_| format!("body field '{}' requires a boolean value", field.path)),
        "json" => serde_json::from_str(raw_value)
            .map_err(|error| format!("body field '{}' contains invalid JSON: {error}", field.path)),
        "null" => Ok(serde_json::Value::Null),
        "number" => {
            let number = raw_value
                .parse::<f64>()
                .map_err(|_| format!("body field '{}' requires a numeric value", field.path))?;
            serde_json::Number::from_f64(number)
                .map(serde_json::Value::Number)
                .ok_or_else(|| {
                    format!(
                        "body field '{}' requires a finite numeric value",
                        field.path
                    )
                })
        }
        "string" => Ok(serde_json::Value::String(raw_value.to_string())),
        other => Err(format!(
            "body field '{}' uses unsupported value type '{other}'",
            field.path
        )),
    }
}

fn set_json_path_value(
    root: &mut serde_json::Value,
    segments: &[JsonPathSegment],
    value: serde_json::Value,
) -> Result<(), String> {
    let Some((last, parents)) = segments.split_last() else {
        return Err("body field path is empty".to_string());
    };
    let mut current = root;

    for segment in parents {
        match segment {
            JsonPathSegment::Key(key) => {
                if !current.is_object() {
                    *current = serde_json::Value::Object(serde_json::Map::new());
                }
                let object = current
                    .as_object_mut()
                    .expect("object was just initialized");
                current = object
                    .entry(key.clone())
                    .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            }
            JsonPathSegment::Index(index) => {
                let array = current
                    .as_array_mut()
                    .ok_or_else(|| format!("body field path expects an array at index {index}"))?;
                current = array.get_mut(*index).ok_or_else(|| {
                    format!("body field path array index {index} is out of range")
                })?;
            }
        }
    }

    match last {
        JsonPathSegment::Key(key) => {
            if !current.is_object() {
                *current = serde_json::Value::Object(serde_json::Map::new());
            }
            let object = current
                .as_object_mut()
                .expect("object was just initialized");
            object.insert(key.clone(), value);
            Ok(())
        }
        JsonPathSegment::Index(index) => {
            let array = current
                .as_array_mut()
                .ok_or_else(|| format!("body field path expects an array at index {index}"))?;
            if *index == array.len() {
                array.push(value);
                Ok(())
            } else {
                let slot = array.get_mut(*index).ok_or_else(|| {
                    format!("body field path array index {index} is out of range")
                })?;
                *slot = value;
                Ok(())
            }
        }
    }
}

fn remove_json_path_value(
    root: &mut serde_json::Value,
    segments: &[JsonPathSegment],
) -> Result<(), String> {
    let Some((last, parents)) = segments.split_last() else {
        return Err("body field path is empty".to_string());
    };
    let mut current = root;

    for segment in parents {
        match segment {
            JsonPathSegment::Key(key) => {
                current = current
                    .as_object_mut()
                    .and_then(|object| object.get_mut(key))
                    .ok_or_else(|| format!("body field path parent '{key}' does not exist"))?;
            }
            JsonPathSegment::Index(index) => {
                current = current
                    .as_array_mut()
                    .and_then(|array| array.get_mut(*index))
                    .ok_or_else(|| {
                        format!("body field path array index {index} is out of range")
                    })?;
            }
        }
    }

    match last {
        JsonPathSegment::Key(key) => {
            current
                .as_object_mut()
                .ok_or_else(|| format!("body field path parent for '{key}' is not an object"))?
                .remove(key);
            Ok(())
        }
        JsonPathSegment::Index(index) => {
            let array = current.as_array_mut().ok_or_else(|| {
                format!("body field path parent for index {index} is not an array")
            })?;
            if *index < array.len() {
                array.remove(*index);
                Ok(())
            } else {
                Err(format!(
                    "body field path array index {index} is out of range"
                ))
            }
        }
    }
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

fn bytes_from_script_body(
    body_text: Option<String>,
    body_base64: Option<String>,
) -> Result<Vec<u8>, String> {
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
    request.method = Method::from_bytes(script_request.method.as_bytes()).map_err(|error| {
        format!(
            "invalid script request method '{}': {error}",
            script_request.method
        )
    })?;
    request.url = Url::parse(&script_request.url).map_err(|error| {
        format!(
            "invalid script request url '{}': {error}",
            script_request.url
        )
    })?;
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
    response.status_code = StatusCode::from_u16(script_response.status).map_err(|error| {
        format!(
            "invalid script response status '{}': {error}",
            script_response.status
        )
    })?;
    response.response_headers = header_map_from_script_headers(&script_response.headers);
    response.replace_response_body(bytes_from_script_body(
        script_response.body_text,
        script_response.body_base64,
    )?);
    Ok(())
}

fn upstream_response_from_override(
    override_response: ScriptResponseOverride,
) -> Result<UpstreamResponse, String> {
    let response_body =
        bytes_from_script_body(override_response.body_text, override_response.body_base64)?;

    Ok(UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        request_send_ms: 0,
        response_body_size_bytes: response_body.len(),
        response_body,
        response_headers: header_map_from_script_headers(&override_response.headers),
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::from_u16(override_response.status).map_err(|error| {
            format!(
                "invalid mock response status '{}': {error}",
                override_response.status
            )
        })?,
        tls_ms: None,
        waiting_ms: 0,
    })
}

fn invalid_trace(mut trace: ScriptTrace, message: String) -> ScriptTrace {
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

fn rebuild_request_runtime_state(request: &mut ParsedProxyRequest) -> Result<(), String> {
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

pub(crate) fn apply_request_rewrite_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
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

fn normalize_packet_loss_ratio(packet_loss_ratio: f32) -> f32 {
    if packet_loss_ratio <= 1.0 {
        // Treat values in [0, 1] as a ratio (e.g. 0.05 = 5% loss).
        // To express a percentage, use values > 1.0 (e.g. 5 = 5% loss).
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

    rand::random::<f32>() < normalized
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
    selection: &ThrottleRuntimeSelection,
    body_len: usize,
) -> Result<ThrottleTrace, ThrottleFailure> {
    let profile = &selection.profile;
    if should_drop_for_packet_loss(profile) {
        let error = format!("request dropped by throttle profile '{}'", profile.name);
        return Err(ThrottleFailure {
            error: error.clone(),
            trace: build_throttle_trace(
                selection,
                "request",
                "dropped",
                body_len,
                0,
                0,
                Some(error),
            ),
        });
    }

    let latency_ms = profile.latency_ms as u64;
    let upload_delay_ms = transfer_delay_ms(body_len, profile.upload_kbps);

    if latency_ms > 0 {
        sleep(Duration::from_millis(latency_ms)).await;
    }
    if upload_delay_ms > 0 {
        sleep(Duration::from_millis(upload_delay_ms)).await;
    }

    Ok(build_throttle_trace(
        selection,
        "request",
        "applied",
        body_len,
        latency_ms,
        upload_delay_ms,
        None,
    ))
}

pub(crate) async fn apply_response_throttle(
    selection: &ThrottleRuntimeSelection,
    body_len: usize,
) -> ThrottleTrace {
    let profile = &selection.profile;
    let download_delay_ms = transfer_delay_ms(body_len, profile.download_kbps);

    if download_delay_ms > 0 {
        sleep(Duration::from_millis(download_delay_ms)).await;
    }

    build_throttle_trace(
        selection,
        "response",
        "applied",
        body_len,
        0,
        download_delay_ms,
        None,
    )
}

fn build_throttle_trace(
    selection: &ThrottleRuntimeSelection,
    stage: &str,
    outcome: &str,
    body_bytes: usize,
    latency_ms: u64,
    transfer_delay_ms: u64,
    message: Option<String>,
) -> ThrottleTrace {
    let rule = selection.rule.as_ref();
    ThrottleTrace {
        body_bytes,
        delay_ms: latency_ms.saturating_add(transfer_delay_ms),
        latency_ms,
        message,
        outcome: outcome.to_string(),
        profile_id: selection.profile.id.clone(),
        profile_name: selection.profile.name.clone(),
        rule_id: rule.map(|rule| rule.id.clone()),
        rule_name: rule.map(|rule| rule.name.clone()),
        sequence: 0,
        stage: stage.to_string(),
        transfer_delay_ms,
    }
}

pub(crate) fn apply_request_runtime_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    map_manager: &Option<Arc<MapManager>>,
    throttle_manager: &Option<Arc<ThrottleManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
) -> Result<RequestRuntimeOutcome, String> {
    let rewrite_traces = apply_request_rewrite_rules(rewrite_manager, workspace_id, request)?;
    let (local_response, map_traces) = apply_map_rules(map_manager, workspace_id, request)?;
    let throttle_selection =
        active_throttle_selection_for_request(throttle_manager, workspace_id, request);

    Ok(RequestRuntimeOutcome {
        local_response,
        map_traces,
        rewrite_traces,
        throttle_selection,
    })
}
