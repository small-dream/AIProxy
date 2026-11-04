use super::*;
use regex::Regex;
use std::sync::Arc;

/// Immutable Rewrite+Map snapshot shared by both managers for the first
/// automation release. Publishing replaces the whole value under one lock so a
/// request cannot observe a new Rewrite list with an old Map list.
#[derive(Clone)]
pub(crate) struct RuntimeRuleSnapshot {
    pub generation: u64,
    pub rewrite: Arc<Vec<CompiledRewriteRule>>,
    pub map: Arc<Vec<CompiledMapRule>>,
}

struct RuleRuntime {
    snapshot: Mutex<Arc<RuntimeRuleSnapshot>>,
}

impl RuleRuntime {
    fn new() -> Self {
        Self {
            snapshot: Mutex::new(Arc::new(RuntimeRuleSnapshot {
                generation: 0,
                rewrite: Arc::new(Vec::new()),
                map: Arc::new(Vec::new()),
            })),
        }
    }

    fn snapshot(&self) -> Arc<RuntimeRuleSnapshot> {
        Arc::clone(
            &self
                .snapshot
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    fn replace_rewrite(&self, rewrite: Vec<CompiledRewriteRule>) {
        let mut guard = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current = Arc::clone(&guard);
        *guard = Arc::new(RuntimeRuleSnapshot {
            generation: current.generation.saturating_add(1),
            rewrite: Arc::new(rewrite),
            map: Arc::clone(&current.map),
        });
    }

    fn replace_map(&self, map: Vec<CompiledMapRule>) {
        let mut guard = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current = Arc::clone(&guard);
        *guard = Arc::new(RuntimeRuleSnapshot {
            generation: current.generation.saturating_add(1),
            rewrite: Arc::clone(&current.rewrite),
            map: Arc::new(map),
        });
    }

    fn publish(
        &self,
        rewrite: Vec<CompiledRewriteRule>,
        map: Vec<CompiledMapRule>,
        generation: u64,
    ) {
        let mut guard = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *guard = Arc::new(RuntimeRuleSnapshot {
            generation,
            rewrite: Arc::new(rewrite),
            map: Arc::new(map),
        });
    }
}

fn compile_rewrite_rules(rules: Vec<(RewriteRule, Option<String>)>) -> Vec<CompiledRewriteRule> {
    rules
        .into_iter()
        .map(|(rule, host_lock)| CompiledRewriteRule {
            compiled_match: compile_match_regex(
                &rule.r#match.match_type,
                &rule.r#match.url_pattern,
            )
            .map(Arc::new),
            rule,
            host_lock,
        })
        .collect()
}

fn compile_map_rules(rules: Vec<(MapRule, Option<String>)>) -> Vec<CompiledMapRule> {
    rules
        .into_iter()
        .map(|(rule, host_lock)| CompiledMapRule { rule, host_lock })
        .collect()
}

/// Build Rewrite and Map managers backed by the same atomic rule runtime.
pub fn paired_rule_managers() -> (Arc<RewriteManager>, Arc<MapManager>) {
    let runtime = Arc::new(RuleRuntime::new());
    (
        Arc::new(RewriteManager::with_runtime(Arc::clone(&runtime))),
        Arc::new(MapManager::with_runtime(runtime)),
    )
}

/// Manages rewrite rules in memory.
pub struct RewriteManager {
    runtime: Arc<RuleRuntime>,
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
    /// Exact request host this rule may match. Agent rules set this as a
    /// defense-in-depth boundary independent of URL pattern syntax.
    pub host_lock: Option<String>,
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
        Self::with_runtime(Arc::new(RuleRuntime::new()))
    }

    fn with_runtime(runtime: Arc<RuleRuntime>) -> Self {
        Self { runtime }
    }

    pub fn set_rules(&self, rules: Vec<RewriteRule>) {
        self.runtime.replace_rewrite(compile_rewrite_rules(
            rules.into_iter().map(|rule| (rule, None)).collect(),
        ));
    }

    pub fn set_rules_with_host_locks(&self, rules: Vec<(RewriteRule, Option<String>)>) {
        self.runtime.replace_rewrite(compile_rewrite_rules(rules));
    }

    /// Atomically publish both rule kinds when created with
    /// [`paired_rule_managers`]. The Map manager shares the same runtime.
    pub fn publish_rules_atomic(
        &self,
        rewrite: Vec<(RewriteRule, Option<String>)>,
        map: Vec<(MapRule, Option<String>)>,
        generation: u64,
    ) {
        self.runtime.publish(
            compile_rewrite_rules(rewrite),
            compile_map_rules(map),
            generation,
        );
    }

    pub fn list_rules(&self) -> Vec<RewriteRule> {
        self.runtime
            .snapshot()
            .rewrite
            .iter()
            .map(|cr| cr.rule.clone())
            .collect()
    }

    pub fn list_rules_with_host_locks(&self) -> Vec<(RewriteRule, Option<String>)> {
        self.runtime
            .snapshot()
            .rewrite
            .iter()
            .map(|entry| (entry.rule.clone(), entry.host_lock.clone()))
            .collect()
    }

    pub fn save_rule(&self, rule: RewriteRule) -> RewriteRule {
        self.store_rule(rule, HostLockUpdate::Preserve)
    }

    /// Save an Agent rule together with its exact-host boundary. The host lock
    /// is evaluated before the URL pattern on every request.
    pub fn save_rule_with_host_lock(
        &self,
        rule: RewriteRule,
        host_lock: impl Into<String>,
    ) -> RewriteRule {
        self.store_rule(rule, HostLockUpdate::Set(host_lock.into()))
    }

    fn store_rule(&self, rule: RewriteRule, host_lock_update: HostLockUpdate) -> RewriteRule {
        let current = self.runtime.snapshot();
        let host_lock = match host_lock_update {
            HostLockUpdate::Set(host_lock) => Some(host_lock),
            HostLockUpdate::Preserve => current
                .rewrite
                .iter()
                .find(|entry| entry.rule.id == rule.id)
                .and_then(|entry| entry.host_lock.clone()),
        };
        let compiled = CompiledRewriteRule {
            compiled_match: compile_match_regex(
                &rule.r#match.match_type,
                &rule.r#match.url_pattern,
            )
            .map(Arc::new),
            rule: rule.clone(),
            host_lock,
        };
        let mut next = (*current.rewrite).clone();
        if let Some(existing) = next.iter_mut().find(|r| r.rule.id == compiled.rule.id) {
            *existing = compiled;
        } else {
            next.push(compiled);
        }
        self.runtime.replace_rewrite(next);
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let current = self.runtime.snapshot();
        if !current.rewrite.iter().any(|r| r.rule.id == rule_id) {
            return; // nothing to do; avoid an unnecessary snapshot rebuild
        }
        let next: Vec<CompiledRewriteRule> = current
            .rewrite
            .iter()
            .filter(|r| r.rule.id != rule_id)
            .cloned()
            .collect();
        self.runtime.replace_rewrite(next);
    }

    /// Returns the current compiled-rule snapshot. Cheap: a single refcount
    /// bump on the shared `Arc<Vec<...>>`. Callers may iterate the result
    /// outside the lock.
    #[allow(dead_code)]
    pub(crate) fn compiled_rules(&self) -> Arc<Vec<CompiledRewriteRule>> {
        Arc::clone(&self.runtime.snapshot().rewrite)
    }

    pub(crate) fn runtime_snapshot(&self) -> Arc<RuntimeRuleSnapshot> {
        self.runtime.snapshot()
    }

    pub fn runtime_generation(&self) -> u64 {
        self.runtime.snapshot().generation
    }

    pub(crate) fn shares_runtime_with(&self, map: &MapManager) -> bool {
        Arc::ptr_eq(&self.runtime, &map.runtime)
    }
}

enum HostLockUpdate {
    Preserve,
    Set(String),
}

/// Manages map rules (local + remote) in memory.
pub struct MapManager {
    runtime: Arc<RuleRuntime>,
}

#[derive(Clone)]
pub(crate) struct CompiledMapRule {
    pub rule: MapRule,
    pub host_lock: Option<String>,
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
        Self::with_runtime(Arc::new(RuleRuntime::new()))
    }

    fn with_runtime(runtime: Arc<RuleRuntime>) -> Self {
        Self { runtime }
    }

    pub fn set_rules(&self, rules: Vec<MapRule>) {
        self.runtime.replace_map(compile_map_rules(
            rules.into_iter().map(|rule| (rule, None)).collect(),
        ));
    }

    pub fn set_rules_with_host_locks(&self, rules: Vec<(MapRule, Option<String>)>) {
        self.runtime.replace_map(compile_map_rules(rules));
    }

    pub fn list_rules(&self) -> Vec<MapRule> {
        self.runtime
            .snapshot()
            .map
            .iter()
            .map(|entry| entry.rule.clone())
            .collect()
    }

    pub fn list_rules_with_host_locks(&self) -> Vec<(MapRule, Option<String>)> {
        self.runtime
            .snapshot()
            .map
            .iter()
            .map(|entry| (entry.rule.clone(), entry.host_lock.clone()))
            .collect()
    }

    pub fn save_rule(&self, rule: MapRule) -> MapRule {
        let current = self.runtime.snapshot();
        let host_lock = current
            .map
            .iter()
            .find(|entry| entry.rule.id == rule.id)
            .and_then(|entry| entry.host_lock.clone());
        let compiled = CompiledMapRule {
            rule: rule.clone(),
            host_lock,
        };
        let mut rules = (*current.map).clone();
        if let Some(existing) = rules.iter_mut().find(|entry| entry.rule.id == rule.id) {
            *existing = compiled;
        } else {
            rules.push(compiled);
        }
        self.runtime.replace_map(rules);
        rule
    }

    /// Save an Agent map rule together with its exact-host boundary.
    pub fn save_rule_with_host_lock(&self, rule: MapRule, host_lock: impl Into<String>) -> MapRule {
        let mut rules = (*self.runtime.snapshot().map).clone();
        let compiled = CompiledMapRule {
            rule: rule.clone(),
            host_lock: Some(host_lock.into()),
        };
        if let Some(existing) = rules.iter_mut().find(|entry| entry.rule.id == rule.id) {
            *existing = compiled;
        } else {
            rules.push(compiled);
        }
        self.runtime.replace_map(rules);
        rule
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut rules = (*self.runtime.snapshot().map).clone();
        rules.retain(|entry| entry.rule.id != rule_id);
        self.runtime.replace_map(rules);
    }

    #[allow(dead_code)]
    pub(crate) fn compiled_rules(&self) -> Vec<CompiledMapRule> {
        (*self.runtime.snapshot().map).clone()
    }

    pub(crate) fn runtime_snapshot(&self) -> Arc<RuntimeRuleSnapshot> {
        self.runtime.snapshot()
    }

    pub fn runtime_generation(&self) -> u64 {
        self.runtime.snapshot().generation
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
    #[serde(default)]
    pub match_type: Option<String>,
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
