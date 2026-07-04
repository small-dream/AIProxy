use super::*;
use regex::Regex;
use std::sync::Arc;

/// Manages rewrite rules in memory.
pub struct RewriteManager {
    // M10: a single `Arc<Vec<...>>` snapshot is rebuilt only when the rule set
    // changes (`set_rules`/`save_rule`/`delete_rule`). `compiled_rules()` hands
    // out a cheap `Arc` clone (refcount bump) instead of deep-cloning every
    // rule under the lock on each request — the previous code paid a full
    // `rule.clone()` (including the serde_json payload) + `Regex` clone per
    // rule per request.
    snapshot: Mutex<Arc<Vec<CompiledRewriteRule>>>,
}

/// Internal wrapper that pairs a rewrite rule with a pre-compiled regex
/// (only populated when `match_type == "regex"`). Not exposed outside the crate.
#[derive(Clone)]
pub(crate) struct CompiledRewriteRule {
    pub rule: RewriteRule,
    // M10: shared behind an `Arc` so cloning the wrapper (e.g. when the
    // hot-path filters a copy out of the snapshot) never recompiles or deep-
    // copies the regex.
    pub compiled_match: Option<Arc<Regex>>,
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
            snapshot: Mutex::new(Arc::new(Vec::new())),
        }
    }

    pub fn set_rules(&self, rules: Vec<RewriteRule>) {
        let compiled = rules
            .into_iter()
            .map(|rule| CompiledRewriteRule {
                compiled_match: compile_match_regex(
                    &rule.r#match.match_type,
                    &rule.r#match.url_pattern,
                )
                .map(Arc::new),
                rule,
            })
            .collect();
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Arc::new(compiled);
    }

    pub fn list_rules(&self) -> Vec<RewriteRule> {
        self.snapshot
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
            )
            .map(Arc::new),
            rule: rule.clone(),
        };
        // M10: rebuild the snapshot under the lock so concurrent readers
        // hand-pulling `compiled_rules()` never observe a half-mutated vec.
        // Preserve the rule's existing position (in-place replace) so UI lists
        // keyed on `list_rules()` order do not visibly reorder on edit.
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        let mut next: Vec<CompiledRewriteRule> = (**guard).clone();
        if let Some(existing) = next.iter_mut().find(|r| r.rule.id == compiled.rule.id) {
            *existing = compiled;
        } else {
            next.push(compiled);
        }
        *guard = Arc::new(next);
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        if !(**guard).iter().any(|r| r.rule.id == rule_id) {
            return; // nothing to do; avoid an unnecessary snapshot rebuild
        }
        // M10: rebuild preserving relative order of the surviving rules.
        let next: Vec<CompiledRewriteRule> = (**guard)
            .iter()
            .filter(|r| r.rule.id != rule_id)
            .cloned()
            .collect();
        *guard = Arc::new(next);
    }

    /// Returns the current compiled-rule snapshot. Cheap: a single refcount
    /// bump on the shared `Arc<Vec<...>>`. Callers may iterate the result
    /// outside the lock.
    pub(crate) fn compiled_rules(&self) -> Arc<Vec<CompiledRewriteRule>> {
        Arc::clone(&self.snapshot.lock().unwrap_or_else(|e| e.into_inner()))
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

    /// Test helper: build a minimal `ThrottleTrace` for the given stage.
    #[cfg(test)]
    fn trace_for_stage(&self, stage: &str, delay_ms: u64) -> ThrottleTrace {
        ThrottleTrace {
            body_bytes: 0,
            delay_ms,
            latency_ms: 0,
            message: None,
            outcome: "delayed".to_string(),
            profile_id: "p".to_string(),
            profile_name: "P".to_string(),
            rule_id: Some("r".to_string()),
            rule_name: Some("R".to_string()),
            sequence: 0,
            stage: stage.to_string(),
            transfer_delay_ms: 0,
        }
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
        // Every throttle hit (request or response stage) counts as one matched
        // request so response-stage rules surface in the stats (L3). Delay and
        // dropped counters remain stage-specific.
        stats.matched_requests = stats.matched_requests.saturating_add(1);
        if trace.stage == "request" {
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

#[cfg(test)]
mod tests {
    use super::*;

    // L3-1: request-stage hit increments matched_requests and request_delay_ms
    #[test]
    fn record_trace_request_stage_counts_matched() {
        let manager = ThrottleManager::new();
        let trace = manager.trace_for_stage("request", 50);
        manager.record_trace(&trace);
        let stats = manager.runtime_stats();
        assert_eq!(stats.matched_requests, 1);
        assert_eq!(stats.request_delay_ms, 50);
        assert_eq!(stats.response_delay_ms, 0);
    }

    // L3-2: response-stage hit also increments matched_requests (L3 fix) and
    // accumulates response_delay_ms.
    #[test]
    fn record_trace_response_stage_counts_matched() {
        let manager = ThrottleManager::new();
        let trace = manager.trace_for_stage("response", 80);
        manager.record_trace(&trace);
        let stats = manager.runtime_stats();
        assert_eq!(stats.matched_requests, 1);
        assert_eq!(stats.response_delay_ms, 80);
        assert_eq!(stats.request_delay_ms, 0);
    }

    // L3-3: mixed request+response hits count each as a matched request.
    #[test]
    fn record_trace_mixed_stages_counts_all_matched() {
        let manager = ThrottleManager::new();
        manager.record_trace(&manager.trace_for_stage("request", 10));
        manager.record_trace(&manager.trace_for_stage("response", 20));
        manager.record_trace(&manager.trace_for_stage("response", 30));
        let stats = manager.runtime_stats();
        assert_eq!(stats.matched_requests, 3);
        assert_eq!(stats.request_delay_ms, 10);
        assert_eq!(stats.response_delay_ms, 50);
    }

    // L3-4: request-stage "dropped" outcome increments dropped_requests.
    #[test]
    fn record_trace_request_dropped_counts_dropped() {
        let manager = ThrottleManager::new();
        let mut trace = manager.trace_for_stage("request", 0);
        trace.outcome = "dropped".to_string();
        manager.record_trace(&trace);
        let stats = manager.runtime_stats();
        assert_eq!(stats.matched_requests, 1);
        assert_eq!(stats.dropped_requests, 1);
    }
}
