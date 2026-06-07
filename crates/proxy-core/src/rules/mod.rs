use super::*;

mod types;
mod patterns;
mod managers;
mod rewrite;
mod map;
mod throttle;
mod script;
mod json_path;

// Re-export all pub types from types.rs
pub use types::{
    RewriteRuleMatch, RewriteRule, RewriteTraceEntry, RewriteTrace,
    MapRule, MapTrace,
    ThrottleProfileData, ThrottleRuleData, ThrottleTrace, ThrottleRuntimeStats,
};

// Re-export all pub structs from managers.rs
pub use managers::{
    RewriteManager, MapManager, ThrottleManager, DnsManager, DnsMappingRule,
};

// Re-export pub(crate) types that are used outside this module
pub(crate) use types::{
    ThrottleRuntimeSelection, ThrottleFailure, RequestRuntimeOutcome, RequestScriptOutcome,
};

// Re-export pub(crate) functions used outside this module
pub(crate) use patterns::{pattern_matches, compile_match_regex};
pub(crate) use rewrite::{
    apply_request_rewrite_rules, apply_response_rewrite_rules,
    method_matches, rewrite_stage_matches, rebuild_request_runtime_state,
};
pub(crate) use map::apply_map_rules;
pub(crate) use throttle::{apply_request_throttle, apply_response_throttle};
pub(crate) use script::{apply_request_script_rules, apply_response_script_rules};

// ---------------------------------------------------------------------------
// Pipeline orchestration functions (reference multiple managers)
// ---------------------------------------------------------------------------

/// Look up a DNS override for the given hostname. Returns the target IP if a
/// matching, enabled rule is found (highest priority first).
pub(crate) fn resolve_dns_override(
    dns_manager: &Option<std::sync::Arc<DnsManager>>,
    workspace_id: &str,
    hostname: &str,
) -> Option<std::net::IpAddr> {
    let manager = dns_manager.as_ref()?;
    let rules = manager.list_rules();
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

pub(crate) fn host_header_value(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    }
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

    let mut compiled = manager
        .compiled_rules()
        .into_iter()
        .filter(|cr| cr.rule.enabled)
        .filter(|cr| cr.rule.workspace_id == workspace_id)
        .filter(|cr| rewrite_stage_matches(&cr.rule.r#match.stage, stage))
        .filter(|cr| method_matches(&cr.rule.r#match.methods, &request.method))
        .filter(|cr| {
            // Use pre-compiled regex for "regex" match type; fall back to
            // pattern_matches for other match types (exact/wildcard/contains).
            match cr.rule.r#match.match_type.as_deref() {
                Some("regex") => cr.compiled_match.as_ref().is_some_and(|re| re.is_match(request.url.as_str())),
                _ => pattern_matches(
                    &cr.rule.r#match.url_pattern,
                    request.url.as_str(),
                    cr.rule.r#match.match_type.as_deref(),
                ),
            }
        })
        .collect::<Vec<_>>();

    compiled.sort_by(|left, right| right.rule.priority.cmp(&left.rule.priority));
    compiled.into_iter().map(|cr| cr.rule).collect()
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
        .filter(|rule| pattern_matches(&rule.rule.r#match.url_pattern, request.url.as_str(), rule.rule.r#match.match_type.as_deref()))
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

pub(crate) fn apply_request_runtime_rules(
    rewrite_manager: &Option<Arc<RewriteManager>>,
    map_manager: &Option<Arc<MapManager>>,
    throttle_manager: &Option<Arc<ThrottleManager>>,
    workspace_id: &str,
    request: &mut ParsedProxyRequest,
    is_http2: bool,
) -> Result<RequestRuntimeOutcome, String> {
    let rewrite_traces =
        apply_request_rewrite_rules(rewrite_manager, workspace_id, request, is_http2)?;
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
