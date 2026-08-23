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
pub use execute::{execute_request_hook, execute_response_hook, trim_to_byte_limit};
pub use types::MAX_LOG_ENTRY_BYTES;

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
    fn detects_async_function_entrypoints() {
        use crate::compile::detect_entrypoints;
        let source = "export async function onRequest(ctx) { await ctx.request.getText(); }";
        let entrypoints = detect_entrypoints(source).expect("async export is valid");
        assert!(entrypoints.on_request);
        assert!(!entrypoints.on_response);
    }

    /// Validation accepts non-single-space separators (`export\nfunction ...`)
    /// while the runtime rewrite used to replace literal single spaces only —
    /// such rules were accepted but their hooks never fired. The rewrite must
    /// handle everything validation lets through.
    #[test]
    fn compiles_odd_whitespace_javascript_entrypoint_and_runs() {
        let rule = base_rule(
            ScriptRuleLanguage::JavaScript,
            "export\n  function onRequest(ctx) {\n  ctx.log.info(\"odd-ws ok\");\n}",
        );
        let compiled = compile_script_rule(rule).expect("odd-whitespace JS compiles");
        assert!(compiled
            .compiled_code
            .contains("globalThis.__aiproxyScriptExports.onRequest = function onRequest("));
        assert!(!compiled.compiled_code.contains("\nexport"));

        let result = execute_request_hook(&compiled, payload());
        assert!(result
            .trace
            .entries
            .iter()
            .any(|e| e.message.as_deref() == Some("odd-ws ok")));
    }

    #[test]
    fn rewrites_async_and_sync_entrypoints_with_odd_whitespace() {
        use crate::compile::build_runtime_module;
        let module = build_runtime_module(
            "export\nasync\tfunction onResponse(ctx) {}\nexport  function onRequest(ctx) {}",
        );
        assert!(module.contains(
            "globalThis.__aiproxyScriptExports.onResponse = async function onResponse("
        ));
        assert!(module
            .contains("globalThis.__aiproxyScriptExports.onRequest = function onRequest("));
    }

    #[test]
    fn detects_mixed_async_and_sync_entrypoints() {
        use crate::compile::detect_entrypoints;
        let source = r#"
export async function onRequest(ctx) { await ctx.request.getText(); }
export function onResponse(ctx) { ctx.log.info("sync"); }
"#;
        let entrypoints = detect_entrypoints(source).expect("mixed exports are valid");
        assert!(entrypoints.on_request);
        assert!(entrypoints.on_response);
    }

    #[test]
    fn compiles_async_function_export_and_runs() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            "export async function onRequest(ctx) { ctx.log.info(\"async ok\"); }",
        );
        let compiled = compile_script_rule(rule).expect("async TS compiles");
        let result = execute_request_hook(&compiled, payload());
        // Should run (not be rejected); at minimum not a compile/skip failure.
        assert!(result
            .trace
            .entries
            .iter()
            .any(|e| e.message.as_deref() == Some("async ok")));
    }

    /// Locks the async-await semantics for `export async function` hooks.
    ///
    /// Before this fix, an async hook whose body used `await` would execute only
    /// up to the first `await`; everything after it (including a trailing
    /// `ctx.log.info("after-await")`) was silently dropped because the returned
    /// Promise was never awaited and the microtask queue was never drained.
    ///
    /// The invoke path now drives the QuickJS microtask queue via
    /// `rquickjs::promise::MaybePromise::finish`, so the post-await continuation
    /// genuinely runs. This test asserts the deciding case: the "after-await" log
    /// entry MUST be present. If it is missing with outcome `Success`, the silent
    /// truncation bug has regressed.
    #[test]
    fn async_hook_runs_continuations_after_await() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            r#"
export async function onRequest(ctx) {
  ctx.log.info("before-await");
  await Promise.resolve();
  ctx.log.info("after-await");
  ctx.request.setHeader("x-async", "ran");
}
"#,
        );
        let compiled = compile_script_rule(rule).expect("async TS with await compiles");
        let result = execute_request_hook(&compiled, payload());

        assert_eq!(
            result.trace.outcome,
            ScriptRunOutcome::Success,
            "async hook should complete successfully, got {:?}: {:?}",
            result.trace.outcome,
            result.trace.entries
        );
        let messages: Vec<&str> = result
            .trace
            .entries
            .iter()
            .map(|e| e.message.as_deref().unwrap_or(""))
            .collect();
        assert!(
            messages.contains(&"before-await"),
            "pre-await log missing: {:?}",
            messages
        );
        assert!(
            messages.contains(&"after-await"),
            "post-await continuation did NOT run (silent truncation regressed): {:?}",
            messages
        );
        // Mutation performed after the await must also be visible.
        assert!(
            result
                .request
                .as_ref()
                .and_then(|r| r.headers.iter().find(|h| h.name == "x-async"))
                .map(|h| h.value.as_str())
                == Some("ran"),
            "post-await request mutation missing"
        );
    }

    /// An async hook that performs a short-circuit `ctx.respond(...)` AFTER an
    /// await must produce the mock response. This is the exact failure mode the
    /// reviewer flagged (respond-after-await was silently dropped).
    #[test]
    fn async_hook_short_circuits_after_await() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            r#"
export async function onRequest(ctx) {
  await Promise.resolve();
  ctx.respond({ status: 202, bodyText: "mocked", mimeType: "text/plain" });
}
"#,
        );
        let compiled = compile_script_rule(rule).expect("async short-circuit compiles");
        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.trace.outcome, ScriptRunOutcome::Success);
        assert_eq!(
            result
                .response_override
                .as_ref()
                .expect("respond() after await should set override")
                .status,
            202
        );
    }

    // M13: a script that calls respond() twice (a common missing-else/return
    // mistake) must keep the FIRST override and surface a warning entry, instead
    // of silently overwriting the first with the second.
    #[test]
    fn double_respond_keeps_first_and_warns() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            r#"
export function onRequest(ctx) {
  ctx.respond({ status: 201, bodyText: "first" });
  ctx.respond({ status: 418, bodyText: "second" });
}
"#,
        );
        let compiled = compile_script_rule(rule).expect("double-respond compiles");
        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.trace.outcome, ScriptRunOutcome::Success);
        let override_response = result
            .response_override
            .as_ref()
            .expect("respond() should set an override");
        // The FIRST override wins (the intended short-circuit).
        assert_eq!(override_response.status, 201);
        assert_eq!(override_response.body_text.as_deref(), Some("first"));

        // A warn entry documents the ignored duplicate respond().
        let has_warn = result.trace.entries.iter().any(|entry| {
            entry.level == Some(ScriptLogLevel::Warn)
                && entry
                    .message
                    .as_deref()
                    .unwrap_or_default()
                    .contains("more than once")
        });
        assert!(
            has_warn,
            "expected a warn entry for the duplicate respond(), got entries: {:?}",
            result.trace.entries
        );
    }

    /// An async hook that throws AFTER an await must surface as a runtime
    /// failure (Promise rejection), not be silently swallowed. This complements
    /// `fails_open_on_runtime_errors` (which covers sync throws) for the async
    /// post-await path.
    #[test]
    fn async_hook_throw_after_await_surfaces_as_runtime_error() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            r#"
export async function onRequest(ctx) {
  await Promise.resolve();
  throw new Error("async boom");
}
"#,
        );
        let compiled = compile_script_rule(rule).expect("async throw compiles");
        let result = execute_request_hook(&compiled, payload());

        assert_eq!(
            result.trace.outcome,
            ScriptRunOutcome::RuntimeError,
            "async throw-after-await must surface, not silently truncate: {:?}",
            result.trace.entries
        );
    }

    // Finding #2 regression guard: a log-only / no-op script (one that reads
    // the body but does NOT mutate it) must report `request: None` / `response:
    // None`. The Rust side only strips content-encoding / replaces the body
    // when the script actually changed it; previously the JS bridge always
    // echoed the cloned request/response back, so even a no-op onResponse on a
    // gzip response would decode→replace→strip content-encoding and change wire
    // behavior for every matched script.
    #[test]
    fn no_op_script_reports_no_request_or_response_mutation() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            r#"
export function onRequest(ctx) {
  // Read the body but do not mutate the request.
  const text = ctx.request.getText();
  ctx.log.info("saw body length " + (text ? text.length : 0));
}
"#,
        );
        let compiled = compile_script_rule(rule).expect("no-op script compiles");
        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.trace.outcome, ScriptRunOutcome::Success);
        assert!(
            result.request.is_none(),
            "a no-op script must not report a request mutation (got {:?})",
            result.request
        );
        assert!(
            result.response.is_none(),
            "a no-op script must not report a response mutation (got {:?})",
            result.response
        );
    }

    // Finding #2 positive case: a script that DOES mutate the request (via a
    // body helper) must still report the mutated request so the Rust side
    // applies it (and strips content-encoding). Guards against the fix
    // over-correcting and dropping real edits.
    #[test]
    fn mutating_script_reports_request_mutation() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            r#"
export function onRequest(ctx) {
  ctx.request.setText(JSON.stringify({ edited: true }), "application/json");
}
"#,
        );
        let compiled = compile_script_rule(rule).expect("mutating script compiles");
        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.trace.outcome, ScriptRunOutcome::Success);
        let request = result
            .request
            .as_ref()
            .expect("a mutating script must report the edited request");
        assert_eq!(request.body_text.as_deref(), Some("{\"edited\":true}"));
    }

    // Finding #2 positive case (direct field write): a script that mutates via
    // direct field assignment (ctx.request.url = ...) must also be detected.
    #[test]
    fn direct_field_mutation_is_detected() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            r#"
export function onRequest(ctx) {
  ctx.request.url = "https://edited.example.com/new-path";
}
"#,
        );
        let compiled = compile_script_rule(rule).expect("direct-write script compiles");
        let result = execute_request_hook(&compiled, payload());

        assert_eq!(result.trace.outcome, ScriptRunOutcome::Success);
        let request = result
            .request
            .as_ref()
            .expect("a direct field write must be detected as a mutation");
        assert_eq!(request.url, "https://edited.example.com/new-path");
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

    /// `ctx.respond()` must validate that `status` is an integer in the legal
    /// HTTP range. Before this fix, an out-of-range (`99999`) or non-numeric
    /// (`"foo"`) status flowed into `Number(init.status ?? 200)`, producing NaN
    /// -> JSON null or a u16 overflow, which then failed as a generic
    /// "invalid type" / "expected u16" decode error that exposed the raw value
    /// but never named `status` as the culprit field. The bridge now throws a
    /// JS Error ("respond status must be an integer in 100..599...") BEFORE the
    /// result is serialized, so the invalid value can no longer reach the Rust
    /// deserializer.
    ///
    /// Note: surfacing the literal thrown message in the trace entry is M3
    /// (Task 5) work — rquickjs currently collapses the rejection to a generic
    /// "Exception generated by QuickJS". What M2 guarantees and what we assert
    /// here is (a) a RuntimeError outcome (clear, intentional failure) and
    /// (b) the misleading u16 decode failure is gone — the validation now
    /// intercepts in JS before deserialization.
    #[test]
    fn respond_rejects_invalid_status_with_clear_error() {
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) { ctx.respond({ status: 99999 }); }"#,
        ))
        .unwrap();
        let result = execute_request_hook(&compiled, payload());

        // Validation must surface as a RuntimeError — not silently succeed and
        // not bleed into a downstream decode failure on the success path.
        assert!(
            matches!(result.trace.outcome, ScriptRunOutcome::RuntimeError),
            "expected RuntimeError for invalid status, got {:?}: {:?}",
            result.trace.outcome,
            result.trace.entries
        );
        // The pre-fix signature was a serde decode error that leaked the raw
        // value ("invalid value: integer `99999`, expected u16"). After M2 the
        // JS bridge validates first, so that decode-error fingerprint must be
        // gone — proving the validation intercepts before deserialization.
        let leaked_decode_error = result.trace.entries.iter().any(|e| {
            e.kind == ScriptRunEntryKind::Error
                && e.message.as_deref().unwrap_or("").contains("expected u16")
        });
        assert!(
            !leaked_decode_error,
            "invalid status should be validated in JS, not leak as a u16 decode error: {:?}",
            result.trace.entries
        );
        assert!(
            result.response_override.is_none(),
            "invalid status must not produce a response override: {:?}",
            result.response_override
        );
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

    /// When a hook throws AFTER collecting entries (`ctx.log.*`, `ctx.extract`),
    /// the pre-throw entries must survive in the trace. Before M3 the throw
    /// rejected the bridge Promise, the serialization step never ran, and the
    /// Rust `runtime_failure_trace` path built a trace containing only the
    /// generic error entry — every diagnostic the script emitted before failing
    /// was lost, making script debugging nearly impossible. The fix catches the
    /// throw inside the JS Promise chain, pushes an error entry capturing the
    /// message where possible, and surfaces the whole collected trace while
    /// still marking the outcome as RuntimeError (the failure is not masked).
    #[test]
    fn preserves_entries_collected_before_script_exception() {
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) {
                ctx.log.info("before error");
                ctx.extract("k", "v");
                throw new Error("boom");
            }"#,
        ))
        .unwrap();

        let result = execute_request_hook(&compiled, payload());

        // Outcome must still be a runtime failure — we preserve entries, we do
        // not mask the error.
        assert_eq!(
            result.trace.outcome,
            ScriptRunOutcome::RuntimeError,
            "throw must still surface as RuntimeError: {:?}",
            result.trace.entries
        );

        // The pre-throw log entry must survive.
        let messages: Vec<&str> = result
            .trace
            .entries
            .iter()
            .map(|e| e.message.as_deref().unwrap_or(""))
            .collect();
        assert!(
            messages.contains(&"before error"),
            "pre-throw log entry lost on throw, got: {:?}",
            result.trace.entries
        );

        // The pre-throw extraction must survive.
        assert!(
            result
                .trace
                .entries
                .iter()
                .any(|e| e.kind == ScriptRunEntryKind::Extraction && e.key.as_deref() == Some("k")),
            "pre-throw extraction lost on throw, got: {:?}",
            result.trace.entries
        );

        // The JS bridge catches the throw in JS (where the thrown Error's
        // `.message` is still reachable) and pushes it as an error entry — so
        // the original message ("boom") is surfaced, not rquickjs's generic
        // "Exception generated by QuickJS".
        let has_original_error_message = result.trace.entries.iter().any(|e| {
            e.kind == ScriptRunEntryKind::Error
                && e.level == Some(ScriptLogLevel::Error)
                && e.message.as_deref() == Some("boom")
        });
        assert!(
            has_original_error_message,
            "thrown error message should be surfaced in an error entry, got: {:?}",
            result.trace.entries
        );
    }

    #[test]
    fn times_out_infinite_loops() {
        // A `while(true){}` must not succeed: the script engine's interrupt
        // handler (or, under heavy concurrent load, an OOM/RuntimeError) ends
        // the run before it returns a result. Asserting the exact outcome
        // (TimedOut vs RuntimeError) made this test flaky under `cargo test
        // --workspace` CPU contention — both are valid "did not succeed"
        // results, so assert the contract (no request produced, non-success
        // outcome) instead of the mechanism.
        let compiled = compile_script_rule(base_rule(
            ScriptRuleLanguage::JavaScript,
            "export function onRequest() { while (true) {} }",
        ))
        .unwrap();

        let result = execute_request_hook(&compiled, payload());

        assert_ne!(
            result.trace.outcome,
            ScriptRunOutcome::Success,
            "infinite loop must not succeed, got {:?}: {:?}",
            result.trace.outcome,
            result.trace.entries
        );
        assert!(
            result.request.is_none(),
            "infinite loop must not produce a request, got {:?}",
            result.request
        );
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

    // M10: ScriptManager.compiled_rules() returns a shared Arc snapshot; two
    // reads without an intervening mutation share the same Arc, and the large
    // compiled_code String is shared (Arc<String>) across reads — no per-call
    // deep clone of the transpiled module source.
    #[test]
    fn compiled_rules_snapshot_is_shared_until_mutation() {
        use std::sync::Arc;

        let rule = base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) { }"#,
        );
        let compiled = compile_script_rule(rule).unwrap();

        let manager = ScriptManager::new();
        manager.set_rules(vec![compiled]);

        let snap_a = manager.compiled_rules();
        let snap_b = manager.compiled_rules();
        assert!(
            Arc::ptr_eq(&snap_a, &snap_b),
            "compiled_rules() should share the snapshot Arc until a mutation"
        );

        // compiled_code is shared (Arc<String>) across snapshot reads.
        let code_a = &snap_a[0].compiled_code;
        let code_b = &snap_b[0].compiled_code;
        assert!(
            Arc::ptr_eq(code_a, code_b),
            "compiled_code should be shared (Arc<String>) across reads"
        );

        // A mutation rebuilds the snapshot.
        manager.delete_rule("script-1");
        let snap_c = manager.compiled_rules();
        assert!(
            !Arc::ptr_eq(&snap_a, &snap_c),
            "snapshot must be rebuilt after a mutation"
        );
    }

    /// M7: a hook that awaits a never-settling Promise (`new Promise(() => {})`)
    /// must produce a distinct, operator-actionable error message rather than a
    /// generic await failure, so the cause is obvious in the script trace.
    ///
    /// `MaybePromise::finish` returns `Error::WouldBlock` as soon as the QuickJS
    /// job queue drains before settlement — this happens immediately (the queue
    /// is empty after the constructor returns), well before the wall-clock
    /// timeout. The error message must mention "never settled".
    #[test]
    fn never_settling_hook_produces_clear_error() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            "export async function onRequest(ctx) { await new Promise(() => {}); }",
        );
        let compiled = compile_script_rule(rule).expect("never-settling hook compiles");
        let result = execute_request_hook(&compiled, payload());

        // The hook must not report Success — it failed because the Promise
        // never settled.
        assert_ne!(
            result.trace.outcome,
            ScriptRunOutcome::Success,
            "a never-settling Promise must not be reported as Success"
        );
        // The error entry must surface the actionable WouldBlock diagnostic.
        let error_messages: Vec<String> = result
            .trace
            .entries
            .iter()
            .filter(|e| e.kind == ScriptRunEntryKind::Error)
            .filter_map(|e| e.message.clone())
            .collect();
        assert!(
            error_messages.iter().any(|m| m.contains("never settled")),
            "expected an error mentioning 'never settled', got: {error_messages:?}"
        );
    }
}
