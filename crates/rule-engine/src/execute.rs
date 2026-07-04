use rquickjs::{promise::MaybePromise, Context, Function, Runtime};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

use crate::js_bridge::SCRIPT_HOST_BRIDGE;
use crate::types::*;

/// Maximum number of script hook executions that may run concurrently.
///
/// Each script hook spawns an OS thread that owns a full QuickJS runtime
/// (16MB heap). Without a cap, N concurrent in-flight requests × M matched
/// script rules could spawn an unbounded number of threads and exhaust the
/// process thread/fd limit or memory. This gate bounds the live script threads
/// regardless of incoming request volume (the proxy's connection semaphore only
/// limits sockets, not script threads). Callers that cannot acquire a permit in
/// time fail-open with a RuntimeError trace rather than spawning past the cap.
const MAX_CONCURRENT_SCRIPT_THREADS: usize = 64;

/// How long to wait for a free script slot before failing the hook open.
/// Kept at the script timeout so a steady burst can drain without spuriously
/// rejecting hooks that would have completed in time.
const SCRIPT_SLOT_ACQUIRE_TIMEOUT: Duration = SCRIPT_EXECUTION_TIMEOUT;

/// A permit-based concurrency gate for script hook execution (see
/// [`MAX_CONCURRENT_SCRIPT_THREADS`]). Implemented with a Mutex + Condvar so it
/// can be acquired from the synchronous `execute_hook` path (which runs inside
/// the async proxy task) without pulling in an async semaphore dependency.
struct ScriptConcurrencyGate {
    available: Mutex<usize>,
    not_empty: Condvar,
}

impl ScriptConcurrencyGate {
    const fn new() -> Self {
        Self {
            available: Mutex::new(MAX_CONCURRENT_SCRIPT_THREADS),
            not_empty: Condvar::new(),
        }
    }

    /// Block until a permit is available or `deadline`. Returns a guard whose
    /// `Drop` returns the permit to the pool, or `None` if the deadline elapsed.
    fn acquire(&self, deadline: Instant) -> Option<ScriptPermitGuard<'_>> {
        // Mutex poisoned: a prior thread panicked while holding a permit. Recover
        // by treating the pool as one slot emptier (the panicked thread leaked
        // its slot) and proceeding rather than deadlocking. Re-locking on poison
        // is safe because we only ever decrement under the lock we hold.
        let mut guard = self.available.lock().unwrap_or_else(|e| e.into_inner());
        while *guard == 0 {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let lock_result = self.not_empty.wait_timeout(guard, deadline - now);
            let (next_guard, wait_result) = match lock_result {
                Ok(pair) => pair,
                // Poisoned again during wake: treat as immediately available to
                // avoid an infinite poison-loop, then decrement below.
                Err(poison) => {
                    let (g, _w) = poison.into_inner();
                    guard = g;
                    break;
                }
            };
            guard = next_guard;
            if wait_result.timed_out() && *guard == 0 {
                return None;
            }
        }
        *guard = guard.saturating_sub(1);
        Some(ScriptPermitGuard { gate: self })
    }
}

struct ScriptPermitGuard<'a> {
    gate: &'a ScriptConcurrencyGate,
}

impl Drop for ScriptPermitGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.gate.available.lock() {
            *guard = guard.saturating_add(1);
        }
        self.gate.not_empty.notify_one();
    }
}

/// Process-wide gate. `static` is fine: the gate holds no per-request state.
static SCRIPT_GATE: ScriptConcurrencyGate = ScriptConcurrencyGate::new();

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

    // Acquire a concurrency permit BEFORE spawning. This blocks the calling
    // (async) task briefly, mirroring the existing `recv_timeout` behavior, but
    // caps the number of live QuickJS-runtime threads regardless of incoming
    // request volume. If no slot frees up in time, fail open with a
    // RuntimeError trace instead of spawning past the cap.
    let permit = match SCRIPT_GATE.acquire(start + SCRIPT_SLOT_ACQUIRE_TIMEOUT) {
        Some(permit) => permit,
        None => {
            return runtime_failure_trace(
                rule,
                stage,
                ScriptRunOutcome::RuntimeError,
                format!(
                    "script concurrency limit ({} concurrent) reached; hook skipped to avoid \
                     thread exhaustion",
                    MAX_CONCURRENT_SCRIPT_THREADS
                ),
                start.elapsed().as_millis(),
            );
        }
    };

    let (sender, receiver) = mpsc::channel();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let thread_cancel_flag = Arc::clone(&cancel_flag);

    std::thread::spawn(move || {
        // The permit is moved into the thread and released on its exit (Drop),
        // so the slot is freed as soon as this runtime finishes — even on error
        // or timeout-eviction.
        let _permit = permit;
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
            // The JS bridge catches hook throws/rejections and re-resolves with
            // `runtimeError: true` so the pre-throw entries survive (M3). Such
            // a result is a deliberate failure: mark it RuntimeError and, to
            // preserve the fail-open semantics shared with `runtime_failure_trace`,
            // drop any request/response mutations the script made before throwing
            // — but keep the entries (logs/extractions) the user needs to debug.
            let outcome = if result.runtime_error {
                ScriptRunOutcome::RuntimeError
            } else if result.skipped {
                ScriptRunOutcome::Skipped
            } else {
                ScriptRunOutcome::Success
            };
            let (request, response, response_override) = if result.runtime_error {
                (None, None, None)
            } else {
                (result.request, result.response, result.response_override)
            };

            ScriptHookResult {
                request,
                response,
                response_override,
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
                    let (request, response, response_override) = if result.runtime_error {
                        (None, None, None)
                    } else {
                        (result.request, result.response, result.response_override)
                    };
                    ScriptHookResult {
                        request,
                        response,
                        response_override,
                        trace: ScriptTrace {
                            duration_ms: start.elapsed().as_millis(),
                            entries: std::mem::take(&mut entries),
                            outcome: if result.runtime_error {
                                ScriptRunOutcome::RuntimeError
                            } else if result.skipped {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Barrier;
    use std::thread;

    #[test]
    fn gate_releases_permit_on_drop() {
        let gate = ScriptConcurrencyGate::new();
        // Acquire and immediately drop returns the full capacity.
        {
            let _g = gate.acquire(Instant::now() + Duration::from_secs(1));
            assert!(_g.is_some());
        }
        assert_eq!(
            *gate.available.lock().unwrap(),
            MAX_CONCURRENT_SCRIPT_THREADS
        );
    }

    #[test]
    fn gate_enforces_capacity_concurrently() {
        // Use a fresh gate with a tiny capacity so the test does not depend on
        // the global `MAX_CONCURRENT_SCRIPT_THREADS` and cannot interfere with
        // the process-wide static.
        const CAP: usize = 4;
        let gate = Arc::new(ScriptConcurrencyGate {
            available: Mutex::new(CAP),
            not_empty: Condvar::new(),
        });

        // Hold all permits on worker threads that block until released.
        let release = Arc::new(Barrier::new(CAP + 1));
        let mut handles = Vec::new();
        for _ in 0..CAP {
            let gate = Arc::clone(&gate);
            let release = Arc::clone(&release);
            handles.push(thread::spawn(move || {
                let _permit = gate
                    .acquire(Instant::now() + Duration::from_secs(5))
                    .unwrap();
                release.wait();
            }));
        }
        // Give the workers a moment to grab their permits.
        thread::sleep(Duration::from_millis(100));

        // A CAP+1th acquire must time out while all permits are held.
        let extra = gate.acquire(Instant::now() + Duration::from_millis(150));
        assert!(extra.is_none(), "expected acquire to time out at capacity");

        // Release the workers; a new acquire should now succeed.
        release.wait();
        for handle in handles {
            handle.join().unwrap();
        }
        let recovered = gate.acquire(Instant::now() + Duration::from_secs(5));
        assert!(recovered.is_some());
        assert_eq!(*gate.available.lock().unwrap(), CAP - 1);
    }
}
