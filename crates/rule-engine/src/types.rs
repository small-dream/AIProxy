use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub(crate) const MAX_LOG_ENTRY_BYTES: usize = 8 * 1024;
pub(crate) const MAX_SCRIPT_ENTRIES: usize = 50;
pub(crate) const MAX_SCRIPT_SOURCE_BYTES: usize = 128 * 1024;
pub(crate) const SCRIPT_EXECUTION_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(50);

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
    pub compiled_code: String,
    pub source_map: Option<String>,
    /// Pre-compiled regex for URL pattern matching (populated when match_type == "regex").
    pub compiled_match: Option<Regex>,
}

impl CompiledScriptRule {
    pub fn public_rule(&self) -> ScriptRule {
        self.rule.clone()
    }
}

pub struct ScriptManager {
    rules: Mutex<Vec<CompiledScriptRule>>,
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
            rules: Mutex::new(Vec::new()),
        }
    }

    pub fn set_rules(&self, rules: Vec<CompiledScriptRule>) {
        let mut guard = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        *guard = rules;
    }

    pub fn list_rules(&self) -> Vec<ScriptRule> {
        self.rules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(CompiledScriptRule::public_rule)
            .collect()
    }

    pub fn compiled_rules(&self) -> Vec<CompiledScriptRule> {
        self.rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn save_rule(&self, rule: CompiledScriptRule) -> ScriptRule {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = rules.iter_mut().find(|r| r.rule.id == rule.rule.id) {
            *existing = rule.clone();
        } else {
            rules.push(rule.clone());
        }
        rule.public_rule()
    }

    pub fn delete_rule(&self, rule_id: &str) {
        let mut rules = self.rules.lock().unwrap_or_else(|e| e.into_inner());
        rules.retain(|r| r.rule.id != rule_id);
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
}
