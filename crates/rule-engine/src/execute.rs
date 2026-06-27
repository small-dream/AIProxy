use rquickjs::{
    promise::MaybePromise, Context, Function, Runtime,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

use crate::js_bridge::SCRIPT_HOST_BRIDGE;
use crate::types::*;

pub fn execute_request_hook(
    rule: &CompiledScriptRule,
    payload: ScriptHookPayload,
) -> ScriptHookResult {
    execute_hook(rule, "onRequest", ScriptTraceStage::Request, payload)
}

pub fn execute_response_hook(
    rule: &CompiledScriptRule,
    payload: ScriptHookPayload,
) -> ScriptHookResult {
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
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let thread_cancel_flag = Arc::clone(&cancel_flag);

    std::thread::spawn(move || {
        let execution = run_script_in_thread(
            &compiled_code,
            hook_name,
            &payload_json,
            thread_cancel_flag,
            SCRIPT_EXECUTION_TIMEOUT,
        );
        let _ = sender.send(execution);
    });

    match receiver.recv_timeout(SCRIPT_EXECUTION_TIMEOUT + Duration::from_millis(10)) {
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
            if start.elapsed() >= SCRIPT_EXECUTION_TIMEOUT {
                ScriptRunOutcome::TimedOut
            } else {
                ScriptRunOutcome::RuntimeError
            },
            error,
            start.elapsed().as_millis(),
        ),
        Err(_) => {
            cancel_flag.store(true, Ordering::Relaxed);
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(result)) => {
                    let mut entries = sanitize_entries(result.entries);
                    ScriptHookResult {
                        request: result.request,
                        response: result.response,
                        response_override: result.response_override,
                        trace: ScriptTrace {
                            duration_ms: start.elapsed().as_millis(),
                            entries: std::mem::take(&mut entries),
                            outcome: if result.skipped {
                                ScriptRunOutcome::Skipped
                            } else {
                                ScriptRunOutcome::Success
                            },
                            rule_id: rule.rule.id.clone(),
                            rule_name: rule.rule.name.clone(),
                            stage,
                        },
                    }
                }
                Ok(Err(error)) => runtime_failure_trace(
                    rule,
                    stage,
                    if error.contains("interrupted") {
                        ScriptRunOutcome::TimedOut
                    } else {
                        ScriptRunOutcome::RuntimeError
                    },
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
    cancel_flag: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<ScriptInvocationResult, String> {
    let runtime = Runtime::new().map_err(|error| format!("create runtime: {error}"))?;

    // Limit QuickJS heap to 16MB per script execution.
    // Scripts may access request/response bodies containing large JSON payloads.
    // 16MB provides headroom while still preventing runaway allocation.
    runtime.set_memory_limit(16 * 1024 * 1024);
    runtime.set_gc_threshold(8 * 1024 * 1024);

    let started_at = Instant::now();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        cancel_flag.load(Ordering::Relaxed) || started_at.elapsed() >= timeout
    })));
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

        // `__aiproxyInvoke` always returns a Promise (a `Promise.resolve().then(...)`
        // chain) so that async hooks (`export async function`) genuinely run their
        // `await` continuations. Drive the QuickJS microtask queue until the Promise
        // settles, then decode the JSON string it resolves to.
        //
        // `MaybePromise::finish::<T>` runs `execute_pending_job` in a loop. For a
        // resolved Promise it returns the inner value via `FromJs::<T>`; for a
        // non-Promise value it would behave identically to direct coercion. If the
        // job queue drains before settlement (e.g. the hook awaits a never-resolving
        // external async operation, which QuickJS cannot drive on its own), it
        // returns `Error::WouldBlock` — we surface that as a clear runtime failure
        // rather than silently truncating the hook body.
        let maybe: MaybePromise = invoke
            .call((hook_name.to_string(), payload_json.to_string()))
            .map_err(|error| format!("run {hook_name}: {error}"))?;
        let result_json: String = maybe
            .finish::<String>()
            .map_err(|error| format!("await {hook_name} result: {error}"))?;

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
            key: entry
                .key
                .map(|value| trim_to_byte_limit(&value, MAX_LOG_ENTRY_BYTES)),
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
