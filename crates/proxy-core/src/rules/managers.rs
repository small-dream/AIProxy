use super::*;
use regex::Regex;

/// Manages rewrite rules in memory.
pub struct RewriteManager {
    rules: Mutex<Vec<CompiledRewriteRule>>,
}

/// Internal wrapper that pairs a rewrite rule with a pre-compiled regex
/// (only populated when `match_type == "regex"`). Not exposed outside the crate.
pub(crate) struct CompiledRewriteRule {
    pub rule: RewriteRule,
    pub compiled_match: Option<Regex>,
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
        let compiled = rules
            .into_iter()
            .map(|rule| CompiledRewriteRule {
                compiled_match: compile_match_regex(
                    &rule.r#match.match_type,
                    &rule.r#match.url_pattern,
                ),
                rule,
            })
            .collect();
        let mut guard = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        *guard = compiled;
    }

    pub fn list_rules(&self) -> Vec<RewriteRule> {
        self.rules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|cr| cr.rule.clone())
            .collect()
    }

    pub fn save_rule(&self, rule: RewriteRule) -> RewriteRule {
        let compiled = CompiledRewriteRule {
            compiled_match: compile_match_regex(
                &rule.r#match.match_type,
                &rule.r#match.url_pattern,
            ),
            rule: rule.clone(),
        };
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = rules.iter_mut().find(|r| r.rule.id == compiled.rule.id) {
            *existing = compiled;
        } else {
            rules.push(compiled);
        }
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.retain(|r| r.rule.id != rule_id);
    }

    /// Returns compiled rewrite rules for use in hot-path matching.
    pub(crate) fn compiled_rules(&self) -> Vec<CompiledRewriteRule> {
        self.rules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|cr| CompiledRewriteRule {
                rule: cr.rule.clone(),
                compiled_match: cr.compiled_match.clone(),
            })
            .collect()
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
