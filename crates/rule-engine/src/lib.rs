mod compile;
mod execute;
mod js_bridge;
mod types;

// Public API re-exports — consumers use `aiproxy_rule_engine::ScriptRule` etc.
pub use types::{
    CompiledScriptRule, ScriptEntrypoints, ScriptHeader, ScriptHookPayload, ScriptHookResult,
    ScriptLogLevel, ScriptManager, ScriptRequest, ScriptResponse, ScriptResponseOverride,
    ScriptRule, ScriptRuleLanguage, ScriptRuleMatch, ScriptRuleSourceType, ScriptRunEntry,
    ScriptRunEntryKind, ScriptRunOutcome, ScriptSessionInfo, ScriptTrace, ScriptTraceStage,
};

pub use compile::compile_script_rule;
pub use execute::{execute_request_hook, execute_response_hook};

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
                match_type: None,
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
        assert!(compiled
            .compiled_code
            .contains("__aiproxyScriptExports.onRequest"));
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

    #[test]
    fn times_out_infinite_loops() {
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            "export function onRequest() { while (true) {} }",
        ))
        .unwrap();

        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.trace.outcome, ScriptRunOutcome::TimedOut);
        assert!(result.request.is_none());
    }

    #[test]
    fn memory_limit_is_enforced() {
        // Script that tries to allocate well over 16MB via the real hook path.
        // Should hit the QuickJS memory limit and return RuntimeError, not succeed.
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"
export function onRequest() {
    var arrays = [];
    for (var i = 0; i < 2000; i++) {
        arrays.push(new Uint8Array(1024 * 1024));
    }
}
"#,
        ))
        .unwrap();

        let result = execute_request_hook(&compiled, payload());

        assert!(
            matches!(result.trace.outcome, ScriptRunOutcome::RuntimeError),
            "expected RuntimeError from OOM, got {:?}",
            result.trace.outcome
        );
        assert!(result.request.is_none());
    }

    #[test]
    fn compiles_regex_match_type_successfully() {
        let mut rule = base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) { }"#,
        );
        rule.r#match.url_pattern = r"example\.com/\d+".to_string();
        rule.r#match.match_type = Some("regex".to_string());

        let compiled = compile_script_rule(rule).unwrap();
        assert!(compiled.compiled_match.is_some());

        let re = compiled.compiled_match.unwrap();
        assert!(re.is_match("http://example.com/123"));
        assert!(!re.is_match("http://example.com/abc"));
    }

    #[test]
    fn invalid_regex_match_type_compiles_but_produces_no_match() {
        let mut rule = base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) { }"#,
        );
        rule.r#match.url_pattern = "[invalid(".to_string();
        rule.r#match.match_type = Some("regex".to_string());

        let compiled = compile_script_rule(rule).unwrap();
        // Invalid regex gracefully degrades to None (no match).
        assert!(compiled.compiled_match.is_none());
    }

    #[test]
    fn compiled_match_refreshes_after_rule_update() {
        let mut rule_v1 = base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) { }"#,
        );
        rule_v1.r#match.url_pattern = r"example\.com/\d+".to_string();
        rule_v1.r#match.match_type = Some("regex".to_string());

        let compiled_v1 = compile_script_rule(rule_v1).unwrap();
        let re_v1 = compiled_v1.compiled_match.as_ref().unwrap();
        assert!(re_v1.is_match("http://example.com/123"));
        assert!(!re_v1.is_match("http://example.com/abc"));

        // Update the rule with a different regex pattern.
        let mut rule_v2 = base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) { }"#,
        );
        rule_v2.r#match.url_pattern = r"example\.com/[a-z]+".to_string();
        rule_v2.r#match.match_type = Some("regex".to_string());

        let compiled_v2 = compile_script_rule(rule_v2).unwrap();
        let re_v2 = compiled_v2.compiled_match.as_ref().unwrap();
        assert!(!re_v2.is_match("http://example.com/123"));
        assert!(re_v2.is_match("http://example.com/abc"));
    }
}
