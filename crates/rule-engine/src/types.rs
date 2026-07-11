use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

pub const MAX_LOG_ENTRY_BYTES: usize = 8 * 1024;
pub(crate) const MAX_SCRIPT_ENTRIES: usize = 50;
pub(crate) const MAX_SCRIPT_SOURCE_BYTES: usize = 128 * 1024;
/// Wall-clock budget for a single script rule hook (onRequest/onResponse).
///
/// Debug scripts routinely `JSON.parse` sizeable request/response bodies and
/// run a few iterations; 50ms (the previous value) was too tight and tripped
/// the interrupt handler on legitimate hooks, masking them as "timed out".
/// 500ms still bounds runaway loops while leaving real scripts room to run.
pub(crate) const SCRIPT_EXECUTION_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRule {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub priority: u32,
    pub r#match: ScriptRuleMatch,
    pub language: ScriptRuleLanguage,
    pub source_type: ScriptRuleSourceType,
    pub source_code: String,
    pub source_path: Option<String>,
    pub entrypoints: ScriptEntrypoints,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRuleMatch {
    pub url_pattern: String,
    pub methods: Vec<String>,
    pub stage: String,
    #[serde(default)]
    pub match_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntrypoints {
    pub on_request: bool,
    pub on_response: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptRuleLanguage {
    JavaScript,
    TypeScript,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptRuleSourceType {
    Inline,
    FileImport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTrace {
    pub duration_ms: u128,
    pub entries: Vec<ScriptRunEntry>,
    pub outcome: ScriptRunOutcome,
    pub rule_id: String,
    pub rule_name: String,
    pub stage: ScriptTraceStage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRunEntry {
    pub kind: ScriptRunEntryKind,
    pub key: Option<String>,
    pub level: Option<ScriptLogLevel>,
    pub message: Option<String>,
    pub payload_json: Option<String>,
    pub sequence: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptRunEntryKind {
    Extraction,
    Log,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptRunOutcome {
    Success,
    Skipped,
    RuntimeError,
    TimedOut,
    InvalidResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptTraceStage {
    Request,
    Response,
}

#[derive(Debug, Clone)]
pub struct CompiledScriptRule {
    pub rule: ScriptRule,
    // M10: the transpiled module source and its source map can be large (the
    // code is bounded by MAX_SCRIPT_SOURCE_BYTES ≈ 128 KiB plus the runtime
    // wrapper). Sharing them behind an `Arc` means the per-request
    // `compiled_rules()` snapshot and the per-rule `spawn_blocking` clone are
    // cheap reference-count bumps instead of full String copies.
    pub compiled_code: Arc<String>,
    pub source_map: Option<Arc<String>>,
    /// Pre-compiled regex for URL pattern matching (populated when match_type == "regex").
    pub compiled_match: Option<Arc<Regex>>,
}

impl CompiledScriptRule {
    pub fn public_rule(&self) -> ScriptRule {
        self.rule.clone()
    }
}

pub struct ScriptManager {
    // M10: a single `Arc<Vec<...>>` snapshot rebuilt only when the rule set
    // changes. `compiled_rules()` returns a cheap `Arc` clone instead of
    // deep-cloning every `compiled_code` String (up to ~128 KiB each) on every
    // request.
    snapshot: Mutex<Arc<Vec<CompiledScriptRule>>>,
}

impl std::fmt::Debug for ScriptManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScriptManager")
            .field("rules_count", &self.list_rules().len())
            .finish()
    }
}

impl Default for ScriptManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ScriptManager {
    pub fn new() -> Self {
        Self {
            snapshot: Mutex::new(Arc::new(Vec::new())),
        }
    }

    pub fn set_rules(&self, rules: Vec<CompiledScriptRule>) {
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Arc::new(rules);
    }

    pub fn list_rules(&self) -> Vec<ScriptRule> {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(CompiledScriptRule::public_rule)
            .collect()
    }

    /// Returns the current compiled-rule snapshot as a shared `Arc<Vec<...>>`.
    /// Cheap: a single refcount bump (no per-rule String/regex copy).
    pub fn compiled_rules(&self) -> Arc<Vec<CompiledScriptRule>> {
        Arc::clone(&self.snapshot.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn save_rule(&self, rule: CompiledScriptRule) -> ScriptRule {
        // M10: rebuild the snapshot under the lock so concurrent readers never
        // observe a half-mutated vec. Preserve the rule's existing position
        // (in-place replace) so UI lists keyed on `list_rules()` order do not
        // visibly reorder on edit.
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        let public = rule.public_rule();
        let rule_id = rule.rule.id.clone();
        let mut next: Vec<CompiledScriptRule> = (**guard).clone();
        if let Some(existing) = next.iter_mut().find(|r| r.rule.id == rule_id) {
            *existing = rule;
        } else {
            next.push(rule);
        }
        *guard = Arc::new(next);
        public
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut guard = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        if !(**guard).iter().any(|r| r.rule.id == rule_id) {
            return; // nothing to do; avoid an unnecessary snapshot rebuild
        }
        let next: Vec<CompiledScriptRule> = (**guard)
            .iter()
            .filter(|r| r.rule.id != rule_id)
            .cloned()
            .collect();
        *guard = Arc::new(next);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSessionInfo {
    pub id: String,
    pub host: String,
    pub method: String,
    pub path: String,
    pub stage: ScriptTraceStage,
    pub url: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRequest {
    pub body_base64: Option<String>,
    pub body_text: Option<String>,
    pub headers: Vec<ScriptHeader>,
    pub method: String,
    pub mime_type: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResponse {
    pub body_base64: Option<String>,
    pub body_text: Option<String>,
    pub headers: Vec<ScriptHeader>,
    pub mime_type: Option<String>,
    pub status: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResponseOverride {
    pub body_base64: Option<String>,
    pub body_text: Option<String>,
    pub headers: Vec<ScriptHeader>,
    pub mime_type: Option<String>,
    pub status: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptHookPayload {
    pub request: ScriptRequest,
    pub response: Option<ScriptResponse>,
    pub session: ScriptSessionInfo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptHookResult {
    pub request: Option<ScriptRequest>,
    pub response: Option<ScriptResponse>,
    pub response_override: Option<ScriptResponseOverride>,
    pub trace: ScriptTrace,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptInvocationResult {
    pub entries: Vec<ScriptRunEntry>,
    pub request: Option<ScriptRequest>,
    pub response: Option<ScriptResponse>,
    pub response_override: Option<ScriptResponseOverride>,
    pub skipped: bool,
    /// Set by the JS bridge when the hook threw/rejected. The bridge catches
    /// the throw, pushes an error entry capturing the message where possible,
    /// and serializes the full collected trace (so pre-throw entries survive)
    /// instead of letting the Promise reject (which would discard the entries).
    /// The Rust side then marks the outcome as `RuntimeError` while keeping
    /// the preserved entries.
    #[serde(default)]
    pub runtime_error: bool,
}
