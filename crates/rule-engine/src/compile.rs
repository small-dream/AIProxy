use regex::Regex;
use std::sync::{Arc, OnceLock};

use crate::types::*;

pub fn compile_script_rule(input: ScriptRule) -> Result<CompiledScriptRule, String> {
    validate_script_rule(&input)?;
    let entrypoints = detect_entrypoints(&input.source_code)?;
    let transpiled = transpile_source(&input.source_code, &input.language)?;
    let compiled_code = build_runtime_module(&transpiled.code);

    let compiled_match = compile_script_match(&input.r#match);

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

/// Pre-compile a script rule's URL regex. Shared by `compile_script_rule` and
/// the startup loader, which rebuilds rules from stored rows without
/// recompiling the source. Non-regex and invalid patterns yield `None`, and a
/// regex rule without a compiled pattern matches nothing.
pub fn compile_script_match(rule_match: &ScriptRuleMatch) -> Option<Arc<Regex>> {
    if rule_match.match_type.as_deref() != Some("regex") {
        return None;
    }
    let pattern = rule_match.url_pattern.trim();
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

/// Every function a script may export. Keep in sync with `build_runtime_module`.
const ENTRYPOINT_EXPORT_PATTERN: &str =
    r"export\s+(async\s+)?function\s+(onRequest|onResponse|decodeRequest|decodeResponse)\s*\(";

pub(crate) fn detect_entrypoints(source: &str) -> Result<ScriptEntrypoints, String> {
    static ALLOWED_EXPORT_RE: OnceLock<Regex> = OnceLock::new();
    static ANY_EXPORT_RE: OnceLock<Regex> = OnceLock::new();

    let allowed_export_re = ALLOWED_EXPORT_RE
        .get_or_init(|| Regex::new(ENTRYPOINT_EXPORT_PATTERN).expect("valid allowed export regex"));
    let any_export_re =
        ANY_EXPORT_RE.get_or_init(|| Regex::new(r"\bexport\b").expect("valid any export regex"));

    // Strip every allowed export (both sync and async) down to a bare `function`,
    // so that any remaining `export` keyword is by definition unsupported.
    let stripped = allowed_export_re.replace_all(source, "function $2(");
    if any_export_re.is_match(&stripped) {
        return Err(
            "only 'export function onRequest', 'onResponse', 'decodeRequest' and \
             'decodeResponse' are supported"
                .to_string(),
        );
    }

    let mut entrypoints = ScriptEntrypoints {
        on_request: false,
        on_response: false,
        decode_request: false,
        decode_response: false,
    };
    for captures in allowed_export_re.captures_iter(source) {
        match &captures[2] {
            "onRequest" => entrypoints.on_request = true,
            "onResponse" => entrypoints.on_response = true,
            "decodeRequest" => entrypoints.decode_request = true,
            _ => entrypoints.decode_response = true,
        }
    }

    if !entrypoints.has_proxy_hook() && !entrypoints.decode_request && !entrypoints.decode_response
    {
        return Err(
            "script must export onRequest, onResponse, decodeRequest or decodeResponse".to_string(),
        );
    }

    Ok(entrypoints)
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
    // MUST mirror `detect_entrypoints`' entrypoint regex exactly: every source
    // that passes validation is rewritten here. Literal single-space replaces
    // used to skip sources like `export\nfunction onRequest(`, leaving a bare
    // `export` in the module and no `__aiproxyScriptExports` entry — the rule
    // was accepted but its hooks never fired.
    static ENTRYPOINT_EXPORT_RE: OnceLock<Regex> = OnceLock::new();
    let export_re = ENTRYPOINT_EXPORT_RE.get_or_init(|| {
        Regex::new(ENTRYPOINT_EXPORT_PATTERN).expect("valid entrypoint export regex")
    });

    export_re
        .replace_all(transpiled_source, |caps: &regex::Captures| {
            // Group 1 is optional: `caps.get` (not indexing) so a sync export
            // with no `async` group does not panic.
            let async_kw = match caps.get(1) {
                Some(m) if !m.is_empty() => "async ",
                _ => "",
            };
            let hook = &caps[2];
            format!("globalThis.__aiproxyScriptExports.{hook} = {async_kw}function {hook}(")
        })
        .into_owned()
}
