use regex::Regex;
use std::sync::{Arc, OnceLock};

use crate::types::*;

pub fn compile_script_rule(input: ScriptRule) -> Result<CompiledScriptRule, String> {
    validate_script_rule(&input)?;
    let entrypoints = detect_entrypoints(&input.source_code)?;
    let transpiled = transpile_source(&input.source_code, &input.language)?;
    let compiled_code = build_runtime_module(&transpiled.code);

    let compiled_match = if input.r#match.match_type.as_deref() == Some("regex") {
        let pattern = input.r#match.url_pattern.trim();
        match Regex::new(pattern) {
            Ok(re) => Some(Arc::new(re)),
            Err(e) => {
                tracing::warn!(
                    event = "rules.regex_compile_failed",
                    pattern = pattern,
                    error = %e,
                    "regex compile failed for script rule"
                );
                None
            }
        }
    } else {
        None
    };

    Ok(CompiledScriptRule {
        rule: ScriptRule {
            entrypoints,
            ..input
        },
        compiled_code: Arc::new(compiled_code),
        source_map: transpiled.source_map.map(Arc::new),
        compiled_match,
    })
}

pub(crate) fn validate_script_rule(rule: &ScriptRule) -> Result<(), String> {
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

pub(crate) fn detect_entrypoints(source: &str) -> Result<ScriptEntrypoints, String> {
    static ALLOWED_EXPORT_RE: OnceLock<Regex> = OnceLock::new();
    static ANY_EXPORT_RE: OnceLock<Regex> = OnceLock::new();
    static ON_REQUEST_RE: OnceLock<Regex> = OnceLock::new();
    static ON_RESPONSE_RE: OnceLock<Regex> = OnceLock::new();

    let allowed_export_re = ALLOWED_EXPORT_RE.get_or_init(|| {
        Regex::new(r"export\s+(?:async\s+)?function\s+(onRequest|onResponse)\s*\(")
            .expect("valid allowed export regex")
    });
    let any_export_re =
        ANY_EXPORT_RE.get_or_init(|| Regex::new(r"\bexport\b").expect("valid any export regex"));
    let on_request_re = ON_REQUEST_RE.get_or_init(|| {
        Regex::new(r"export\s+(?:async\s+)?function\s+onRequest\s*\(")
            .expect("valid onRequest export regex")
    });
    let on_response_re = ON_RESPONSE_RE.get_or_init(|| {
        Regex::new(r"export\s+(?:async\s+)?function\s+onResponse\s*\(")
            .expect("valid onResponse export regex")
    });

    // Strip every allowed export (both sync and async) down to a bare `function`,
    // so that any remaining `export` keyword is by definition unsupported.
    let stripped = allowed_export_re.replace_all(source, "function $1(");
    if any_export_re.is_match(&stripped) {
        return Err(
            "only 'export function onRequest' and 'export function onResponse' are supported"
                .to_string(),
        );
    }

    let on_request = on_request_re.is_match(source);
    let on_response = on_response_re.is_match(source);

    if !on_request && !on_response {
        return Err("script must export onRequest and/or onResponse".to_string());
    }

    Ok(ScriptEntrypoints {
        on_request,
        on_response,
    })
}

pub(crate) struct TranspiledSource {
    pub(crate) code: String,
    pub(crate) source_map: Option<String>,
}

pub(crate) fn transpile_source(
    source: &str,
    language: &ScriptRuleLanguage,
) -> Result<TranspiledSource, String> {
    use deno_ast::{
        parse_module, EmitOptions, MediaType, ModuleSpecifier, ParseParams, SourceMapOption,
        TranspileModuleOptions, TranspileOptions,
    };

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

pub(crate) fn build_runtime_module(transpiled_source: &str) -> String {
    transpiled_source
        .replace(
            "export async function onRequest",
            "globalThis.__aiproxyScriptExports.onRequest = async function onRequest",
        )
        .replace(
            "export function onRequest",
            "globalThis.__aiproxyScriptExports.onRequest = function onRequest",
        )
        .replace(
            "export async function onResponse",
            "globalThis.__aiproxyScriptExports.onResponse = async function onResponse",
        )
        .replace(
            "export function onResponse",
            "globalThis.__aiproxyScriptExports.onResponse = function onResponse",
        )
}
