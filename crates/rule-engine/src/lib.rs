use deno_ast::{
    parse_module, EmitOptions, MediaType, ModuleSpecifier, ParseParams, SourceMapOption,
    TranspileModuleOptions, TranspileOptions,
};
use regex::Regex;
use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use std::{
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_LOG_ENTRY_BYTES: usize = 8 * 1024;
const MAX_SCRIPT_ENTRIES: usize = 50;
const MAX_SCRIPT_SOURCE_BYTES: usize = 128 * 1024;
const SCRIPT_EXECUTION_TIMEOUT: Duration = Duration::from_millis(50);

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledScriptRule {
    pub rule: ScriptRule,
    pub compiled_code: String,
    pub source_map: Option<String>,
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
struct ScriptInvocationResult {
    entries: Vec<ScriptRunEntry>,
    request: Option<ScriptRequest>,
    response: Option<ScriptResponse>,
    response_override: Option<ScriptResponseOverride>,
    skipped: bool,
}

pub fn compile_script_rule(input: ScriptRule) -> Result<CompiledScriptRule, String> {
    validate_script_rule(&input)?;
    let entrypoints = detect_entrypoints(&input.source_code)?;
    let transpiled = transpile_source(&input.source_code, &input.language)?;
    let compiled_code = build_runtime_module(&transpiled.code);

    Ok(CompiledScriptRule {
        rule: ScriptRule {
            entrypoints,
            ..input
        },
        compiled_code,
        source_map: transpiled.source_map,
    })
}

pub fn execute_request_hook(rule: &CompiledScriptRule, payload: ScriptHookPayload) -> ScriptHookResult {
    execute_hook(rule, "onRequest", ScriptTraceStage::Request, payload)
}

pub fn execute_response_hook(rule: &CompiledScriptRule, payload: ScriptHookPayload) -> ScriptHookResult {
    execute_hook(rule, "onResponse", ScriptTraceStage::Response, payload)
}

fn execute_hook(
    rule: &CompiledScriptRule,
    hook_name: &'static str,
    stage: ScriptTraceStage,
    payload: ScriptHookPayload,
) -> ScriptHookResult {
    let start = Instant::now();

    let hook_enabled = match stage {
        ScriptTraceStage::Request => rule.rule.entrypoints.on_request,
        ScriptTraceStage::Response => rule.rule.entrypoints.on_response,
    };

    if !hook_enabled {
        return ScriptHookResult {
            request: None,
            response: None,
            response_override: None,
            trace: ScriptTrace {
                duration_ms: 0,
                entries: Vec::new(),
                outcome: ScriptRunOutcome::Skipped,
                rule_id: rule.rule.id.clone(),
                rule_name: rule.rule.name.clone(),
                stage,
            },
        };
    }

    let payload_json = match serde_json::to_string(&payload) {
        Ok(value) => value,
        Err(error) => {
            return runtime_failure_trace(
                rule,
                stage,
                ScriptRunOutcome::InvalidResult,
                format!("failed to serialize script payload: {error}"),
                start.elapsed().as_millis(),
            );
        }
    };

    let compiled_code = rule.compiled_code.clone();
    let (sender, receiver) = mpsc::channel();

    std::thread::spawn(move || {
        let execution = run_script_in_thread(&compiled_code, hook_name, &payload_json);
        let _ = sender.send(execution);
    });

    match receiver.recv_timeout(SCRIPT_EXECUTION_TIMEOUT) {
        Ok(Ok(result)) => {
            let mut entries = sanitize_entries(result.entries);
            let outcome = if result.skipped {
                ScriptRunOutcome::Skipped
            } else {
                ScriptRunOutcome::Success
            };

            ScriptHookResult {
                request: result.request,
                response: result.response,
                response_override: result.response_override,
                trace: ScriptTrace {
                    duration_ms: start.elapsed().as_millis(),
                    entries: std::mem::take(&mut entries),
                    outcome,
                    rule_id: rule.rule.id.clone(),
                    rule_name: rule.rule.name.clone(),
                    stage,
                },
            }
        }
        Ok(Err(error)) => runtime_failure_trace(
            rule,
            stage,
            ScriptRunOutcome::RuntimeError,
            error,
            start.elapsed().as_millis(),
        ),
        Err(_) => runtime_failure_trace(
            rule,
            stage,
            ScriptRunOutcome::TimedOut,
            format!(
                "script exceeded the {}ms execution limit",
                SCRIPT_EXECUTION_TIMEOUT.as_millis()
            ),
            start.elapsed().as_millis(),
        ),
    }
}

fn runtime_failure_trace(
    rule: &CompiledScriptRule,
    stage: ScriptTraceStage,
    outcome: ScriptRunOutcome,
    message: String,
    duration_ms: u128,
) -> ScriptHookResult {
    ScriptHookResult {
        request: None,
        response: None,
        response_override: None,
        trace: ScriptTrace {
            duration_ms,
            entries: vec![ScriptRunEntry {
                kind: ScriptRunEntryKind::Error,
                key: None,
                level: Some(ScriptLogLevel::Error),
                message: Some(trim_to_byte_limit(&message, MAX_LOG_ENTRY_BYTES)),
                payload_json: None,
                sequence: 0,
            }],
            outcome,
            rule_id: rule.rule.id.clone(),
            rule_name: rule.rule.name.clone(),
            stage,
        },
    }
}

fn run_script_in_thread(
    compiled_code: &str,
    hook_name: &str,
    payload_json: &str,
) -> Result<ScriptInvocationResult, String> {
    let runtime = Runtime::new().map_err(|error| format!("create runtime: {error}"))?;
    let context = Context::full(&runtime).map_err(|error| format!("create context: {error}"))?;

    context.with(|ctx| -> Result<ScriptInvocationResult, String> {
        ctx.eval::<(), _>(SCRIPT_HOST_BRIDGE)
            .map_err(|error| format!("install bridge: {error}"))?;
        ctx.eval::<(), _>(compiled_code)
            .map_err(|error| format!("evaluate script: {error}"))?;

        let globals = ctx.globals();
        let invoke: Function = globals
            .get("__aiproxyInvoke")
            .map_err(|error| format!("load invoke bridge: {error}"))?;
        let result_json: String = invoke
            .call((hook_name.to_string(), payload_json.to_string()))
            .map_err(|error| format!("run {hook_name}: {error}"))?;

        serde_json::from_str(&result_json)
            .map_err(|error| format!("decode {hook_name} result: {error}"))
    })
}

fn sanitize_entries(entries: Vec<ScriptRunEntry>) -> Vec<ScriptRunEntry> {
    entries
        .into_iter()
        .take(MAX_SCRIPT_ENTRIES)
        .enumerate()
        .map(|(index, entry)| ScriptRunEntry {
            kind: entry.kind,
            key: entry.key.map(|value| trim_to_byte_limit(&value, MAX_LOG_ENTRY_BYTES)),
            level: entry.level,
            message: entry
                .message
                .map(|value| trim_to_byte_limit(&value, MAX_LOG_ENTRY_BYTES)),
            payload_json: entry
                .payload_json
                .map(|value| trim_to_byte_limit(&value, MAX_LOG_ENTRY_BYTES)),
            sequence: index as u32,
        })
        .collect()
}

fn trim_to_byte_limit(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }

    let mut truncated = String::new();
    for ch in value.chars() {
        let char_len = ch.len_utf8();
        if truncated.len() + char_len > limit.saturating_sub(3) {
            break;
        }
        truncated.push(ch);
    }
    truncated.push_str("...");
    truncated
}

fn validate_script_rule(rule: &ScriptRule) -> Result<(), String> {
    if rule.name.trim().is_empty() {
        return Err("script rule name is required".to_string());
    }

    if rule.source_code.trim().is_empty() {
        return Err("script source code is required".to_string());
    }

    if rule.source_code.len() > MAX_SCRIPT_SOURCE_BYTES {
        return Err(format!(
            "script source exceeds the {} KB limit",
            MAX_SCRIPT_SOURCE_BYTES / 1024
        ));
    }

    Ok(())
}

fn detect_entrypoints(source: &str) -> Result<ScriptEntrypoints, String> {
    static ALLOWED_EXPORT_RE: OnceLock<Regex> = OnceLock::new();
    static ANY_EXPORT_RE: OnceLock<Regex> = OnceLock::new();

    let allowed_export_re = ALLOWED_EXPORT_RE.get_or_init(|| {
        Regex::new(r"export\s+function\s+(onRequest|onResponse)\s*\(")
            .expect("valid allowed export regex")
    });
    let any_export_re = ANY_EXPORT_RE.get_or_init(|| {
        Regex::new(r"\bexport\b").expect("valid any export regex")
    });

    let stripped = allowed_export_re.replace_all(source, "function $1(");
    if any_export_re.is_match(&stripped) {
        return Err("only 'export function onRequest' and 'export function onResponse' are supported".to_string());
    }

    let on_request = source.contains("export function onRequest");
    let on_response = source.contains("export function onResponse");

    if !on_request && !on_response {
        return Err("script must export onRequest and/or onResponse".to_string());
    }

    Ok(ScriptEntrypoints {
        on_request,
        on_response,
    })
}

struct TranspiledSource {
    code: String,
    source_map: Option<String>,
}

fn transpile_source(source: &str, language: &ScriptRuleLanguage) -> Result<TranspiledSource, String> {
    match language {
        ScriptRuleLanguage::JavaScript => Ok(TranspiledSource {
            code: source.to_string(),
            source_map: None,
        }),
        ScriptRuleLanguage::TypeScript => {
            let parsed = parse_module(ParseParams {
                specifier: ModuleSpecifier::parse("file:///script.ts")
                    .expect("hardcoded script specifier should be valid"),
                media_type: MediaType::TypeScript,
                text: source.to_string().into(),
                capture_tokens: false,
                maybe_syntax: None,
                scope_analysis: false,
            })
            .map_err(|error| format!("parse TypeScript: {error}"))?;

            let emitted = parsed
                .transpile(
                    &TranspileOptions::default(),
                    &TranspileModuleOptions::default(),
                    &EmitOptions {
                        source_map: SourceMapOption::Separate,
                        ..EmitOptions::default()
                    },
                )
                .map_err(|error| format!("transpile TypeScript: {error}"))?
                .into_source();

            Ok(TranspiledSource {
                code: emitted.text,
                source_map: emitted.source_map,
            })
        }
    }
}

fn build_runtime_module(transpiled_source: &str) -> String {
    transpiled_source
        .replace(
            "export function onRequest",
            "globalThis.__aiproxyScriptExports.onRequest = function onRequest",
        )
        .replace(
            "export function onResponse",
            "globalThis.__aiproxyScriptExports.onResponse = function onResponse",
        )
}

const SCRIPT_HOST_BRIDGE: &str = r#"
globalThis.__aiproxyScriptExports = globalThis.__aiproxyScriptExports || {};

function __aiproxyClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function __aiproxyNormalizeHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .filter((item) => item && typeof item.name === "string" && typeof item.value === "string")
    .map((item) => ({ name: item.name, value: item.value }));
}

function __aiproxyDecodeBase64(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let str = value.replace(/=+$/, "");
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i += 1) {
    const index = chars.indexOf(str[i]);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(output.split("").map((char) => "%" + char.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  } catch (_error) {
    return output;
  }
}

function __aiproxyEncodeUtf8(value) {
  const normalized = typeof value === "string" ? value : JSON.stringify(value);
  try {
    return unescape(encodeURIComponent(normalized));
  } catch (_error) {
    return normalized;
  }
}

function __aiproxyEncodeBase64(value) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const input = __aiproxyEncodeUtf8(value);
  let output = "";
  let i = 0;
  while (i < input.length) {
    const a = input.charCodeAt(i++);
    const b = input.charCodeAt(i++);
    const c = input.charCodeAt(i++);
    const triplet = (a << 16) | ((b || 0) << 8) | (c || 0);
    output += chars[(triplet >> 18) & 63];
    output += chars[(triplet >> 12) & 63];
    output += Number.isNaN(b) ? "=" : chars[(triplet >> 6) & 63];
    output += Number.isNaN(c) ? "=" : chars[triplet & 63];
  }
  return output;
}

function __aiproxySetHeader(headers, name, value) {
  const normalized = Array.isArray(headers) ? headers : [];
  const next = normalized.filter((entry) => String(entry.name || "").toLowerCase() !== String(name || "").toLowerCase());
  if (typeof value === "string") {
    next.push({ name, value });
  }
  return next;
}

function __aiproxyAttachBodyHelpers(target) {
  if (!target || typeof target !== "object") return target;

  target.getText = function getText() {
    if (typeof target.bodyText === "string") return target.bodyText;
    if (typeof target.bodyBase64 === "string") return __aiproxyDecodeBase64(target.bodyBase64);
    return "";
  };

  target.setText = function setText(text, mimeType) {
    target.bodyText = String(text ?? "");
    target.bodyBase64 = null;
    if (typeof mimeType === "string" && mimeType.length > 0) {
      target.mimeType = mimeType;
      target.headers = __aiproxySetHeader(target.headers, "content-type", mimeType);
    }
  };

  target.getJson = function getJson() {
    const text = target.getText();
    return text ? JSON.parse(text) : null;
  };

  target.setJson = function setJson(value, mimeType) {
    const contentType = typeof mimeType === "string" && mimeType.length > 0
      ? mimeType
      : "application/json";
    target.setText(JSON.stringify(value, null, 2), contentType);
  };

  target.getBase64 = function getBase64() {
    if (typeof target.bodyBase64 === "string") return target.bodyBase64;
    if (typeof target.bodyText === "string") return __aiproxyEncodeBase64(target.bodyText);
    return "";
  };

  target.setBase64 = function setBase64(value, mimeType) {
    target.bodyBase64 = String(value ?? "");
    target.bodyText = null;
    if (typeof mimeType === "string" && mimeType.length > 0) {
      target.mimeType = mimeType;
      target.headers = __aiproxySetHeader(target.headers, "content-type", mimeType);
    }
  };

  target.setHeader = function setHeader(name, value) {
    target.headers = __aiproxySetHeader(target.headers, name, value);
  };

  target.removeHeader = function removeHeader(name) {
    target.headers = __aiproxySetHeader(target.headers, name, undefined);
  };

  return target;
}

globalThis.__aiproxyInvoke = function __aiproxyInvoke(hookName, payloadJson) {
  const payload = JSON.parse(payloadJson);
  const entries = [];
  let responseOverride = null;

  const pushEntry = (entry) => {
    if (entries.length >= 50) return;
    entries.push({
      sequence: entries.length,
      ...entry,
    });
  };

  const request = __aiproxyAttachBodyHelpers(__aiproxyClone(payload.request));
  const response = payload.response ? __aiproxyAttachBodyHelpers(__aiproxyClone(payload.response)) : null;
  const session = __aiproxyClone(payload.session);

  const ctx = {
    request,
    response,
    session,
    log: {
      debug(message, data) {
        pushEntry({ kind: "log", level: "debug", message: String(message ?? ""), payloadJson: data === undefined ? null : JSON.stringify(data), key: null });
      },
      info(message, data) {
        pushEntry({ kind: "log", level: "info", message: String(message ?? ""), payloadJson: data === undefined ? null : JSON.stringify(data), key: null });
      },
      warn(message, data) {
        pushEntry({ kind: "log", level: "warn", message: String(message ?? ""), payloadJson: data === undefined ? null : JSON.stringify(data), key: null });
      },
      error(message, data) {
        pushEntry({ kind: "log", level: "error", message: String(message ?? ""), payloadJson: data === undefined ? null : JSON.stringify(data), key: null });
      },
    },
    extract(key, value) {
      pushEntry({
        kind: "extraction",
        level: null,
        key: String(key ?? ""),
        message: null,
        payloadJson: value === undefined ? null : JSON.stringify(value),
      });
    },
    respond(init) {
      if (!init || typeof init !== "object") {
        throw new Error("respond() requires a response object");
      }
      responseOverride = {
        status: Number(init.status ?? 200),
        headers: __aiproxyNormalizeHeaders(init.headers),
        bodyText: typeof init.bodyText === "string" ? init.bodyText : null,
        bodyBase64: typeof init.bodyBase64 === "string" ? init.bodyBase64 : null,
        mimeType: typeof init.mimeType === "string" ? init.mimeType : null,
      };
      if (responseOverride.mimeType) {
        responseOverride.headers = __aiproxySetHeader(responseOverride.headers, "content-type", responseOverride.mimeType);
      }
    },
  };

  const fn = globalThis.__aiproxyScriptExports[hookName];
  if (typeof fn !== "function") {
    return JSON.stringify({
      skipped: true,
      request,
      response,
      responseOverride,
      entries,
    });
  }

  fn(ctx);

  return JSON.stringify({
    skipped: false,
    request: ctx.request,
    response: ctx.response,
    responseOverride,
    entries,
  });
};
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn base_rule(language: ScriptRuleLanguage, source: &str) -> ScriptRule {
        ScriptRule {
            id: "script-1".to_string(),
            workspace_id: "default".to_string(),
            name: "Script".to_string(),
            note: None,
            enabled: true,
            priority: 100,
            r#match: ScriptRuleMatch {
                url_pattern: "example.com".to_string(),
                methods: vec!["GET".to_string()],
                stage: "either".to_string(),
            },
            language,
            source_type: ScriptRuleSourceType::Inline,
            source_code: source.to_string(),
            source_path: None,
            entrypoints: ScriptEntrypoints {
                on_request: false,
                on_response: false,
            },
        }
    }

    fn payload() -> ScriptHookPayload {
        ScriptHookPayload {
            request: ScriptRequest {
                body_base64: None,
                body_text: Some("{\"ok\":true}".to_string()),
                headers: vec![ScriptHeader {
                    name: "content-type".to_string(),
                    value: "application/json".to_string(),
                }],
                method: "GET".to_string(),
                mime_type: Some("application/json".to_string()),
                url: "https://example.com/api".to_string(),
            },
            response: Some(ScriptResponse {
                body_base64: None,
                body_text: Some("{\"token\":\"abc\"}".to_string()),
                headers: vec![ScriptHeader {
                    name: "content-type".to_string(),
                    value: "application/json".to_string(),
                }],
                mime_type: Some("application/json".to_string()),
                status: 200,
            }),
            session: ScriptSessionInfo {
                id: "session-1".to_string(),
                host: "example.com".to_string(),
                method: "GET".to_string(),
                path: "/api".to_string(),
                stage: ScriptTraceStage::Request,
                url: "https://example.com/api".to_string(),
                workspace_id: "default".to_string(),
            },
        }
    }

    #[test]
    fn compiles_typescript_and_detects_entrypoints() {
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::TypeScript,
            r#"
export function onRequest(ctx: { request: { setHeader: (name: string, value: string) => void } }) {
  ctx.request.setHeader("x-script", "1");
}
"#,
        ))
        .unwrap();

        assert!(compiled.rule.entrypoints.on_request);
        assert!(!compiled.rule.entrypoints.on_response);
        assert!(compiled.compiled_code.contains("__aiproxyScriptExports.onRequest"));
    }

    #[test]
    fn rejects_unsupported_exports() {
        let error = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            "export const nope = 1;",
        ))
        .unwrap_err();

        assert!(error.contains("only"));
    }

    #[test]
    fn executes_request_hook_and_mutates_the_request() {
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"
export function onRequest(ctx) {
  ctx.request.setHeader("x-script", "enabled");
  ctx.log.info("mutated", { url: ctx.request.url });
}
"#,
        ))
        .unwrap();

        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.trace.outcome, ScriptRunOutcome::Success);
        assert!(result
            .request
            .unwrap()
            .headers
            .iter()
            .any(|header| header.name == "x-script" && header.value == "enabled"));
        assert_eq!(result.trace.entries.len(), 1);
    }

    #[test]
    fn executes_response_hook_and_supports_extraction() {
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"
export function onResponse(ctx) {
  const body = ctx.response.getJson();
  ctx.extract("token", body.token);
  ctx.response.setHeader("x-response-script", "1");
}
"#,
        ))
        .unwrap();

        let mut input = payload();
        input.session.stage = ScriptTraceStage::Response;
        let result = execute_response_hook(&compiled, input);

        assert_eq!(result.trace.outcome, ScriptRunOutcome::Success);
        assert_eq!(result.trace.entries[0].kind, ScriptRunEntryKind::Extraction);
        assert!(result
            .response
            .unwrap()
            .headers
            .iter()
            .any(|header| header.name == "x-response-script"));
    }

    #[test]
    fn supports_short_circuit_mock_responses() {
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"
export function onRequest(ctx) {
  ctx.respond({
    status: 201,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyText: "{\"ok\":true}",
    mimeType: "application/json",
  });
}
"#,
        ))
        .unwrap();

        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.response_override.unwrap().status, 201);
    }

    #[test]
    fn fails_open_on_runtime_errors() {
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            "export function onRequest() { throw new Error('boom'); }",
        ))
        .unwrap();

        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.trace.outcome, ScriptRunOutcome::RuntimeError);
        assert!(result.request.is_none());
    }
}
