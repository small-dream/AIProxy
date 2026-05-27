# Upstream Request Timeout — Fix Stuck Loading Sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an upstream request timeout so that HTTP/2 (and HTTP/1.1) requests that never receive a response from the upstream server get a 504 Gateway Timeout session instead of staying in "pending" forever.

**Architecture:** Wrap the `forward_request()` call at both call sites (plain HTTP in `server.rs`, HTTPS/MITM in `mitm_service.rs`) with `tokio::time::timeout()`. On timeout, emit a completed session with status 504 and return an error response to the client. This is a minimal, targeted fix — no changes to `forward_request()` internals or the connection pool.

**Tech Stack:** Rust, Tokio async runtime, hyper HTTP library.

---

### Task 1: Add upstream timeout constant

**Files:**
- Modify: `crates/proxy-core/src/lib.rs:37-38`

- [ ] **Step 1: Add `UPSTREAM_REQUEST_TIMEOUT` constant**

Add the constant next to the existing client timeout constants at line 38 in `lib.rs`:

```rust
const CLIENT_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
const CLIENT_BODY_READ_TIMEOUT: Duration = Duration::from_secs(30);
const UPSTREAM_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
```

120 seconds is generous — it covers slow APIs and large file uploads while still preventing indefinite hangs.

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p aiproxy-proxy-core 2>&1 | tail -5`
Expected: `Finished` with no errors.

---

### Task 2: Add timeout to HTTPS/MITM request path

**Files:**
- Modify: `crates/proxy-core/src/mitm_service.rs:354-359`

This is the primary fix — the path where the user's stuck request was happening.

- [ ] **Step 1: Add `timeout` import and wrap `forward_request` call**

At line 354-360 in `mitm_service.rs`, the current code is:

```rust
    // --- Forward upstream ---
    let upstream_result: Result<UpstreamResponse, String> = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            crate::server::forward_request(&https_request, &state.dns_manager, &state.workspace_id, Some(state.upstream_pool.clone())).await
        }
    };
```

Replace with:

```rust
    // --- Forward upstream ---
    let upstream_result: Result<UpstreamResponse, String> = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            match tokio::time::timeout(
                crate::UPSTREAM_REQUEST_TIMEOUT,
                crate::server::forward_request(&https_request, &state.dns_manager, &state.workspace_id, Some(state.upstream_pool.clone())),
            ).await {
                Ok(result) => result,
                Err(_) => Err(format!(
                    "upstream request timed out after {}s",
                    crate::UPSTREAM_REQUEST_TIMEOUT.as_secs(),
                )),
            }
        }
    };
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p aiproxy-proxy-core 2>&1 | tail -5`
Expected: `Finished` with no errors.

---

### Task 3: Add timeout to plain HTTP request path

**Files:**
- Modify: `crates/proxy-core/src/server.rs:638`

The plain HTTP path has the same vulnerability — no upstream timeout.

- [ ] **Step 1: Wrap `forward_request` call with timeout**

At line 638 in `server.rs`, the current code is:

```rust
            forward_request(&request, &dns_manager, &active_workspace_id, Some(upstream_pool.clone())).await
```

Replace with:

```rust
            match tokio::time::timeout(
                UPSTREAM_REQUEST_TIMEOUT,
                forward_request(&request, &dns_manager, &active_workspace_id, Some(upstream_pool.clone())),
            ).await {
                Ok(result) => result,
                Err(_) => Err(format!(
                    "upstream request timed out after {}s",
                    UPSTREAM_REQUEST_TIMEOUT.as_secs(),
                )),
            }
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p aiproxy-proxy-core 2>&1 | tail -5`
Expected: `Finished` with no errors.

---

### Task 4: Verify the full build and run existing tests

- [ ] **Step 1: Full cargo check**

Run: `cargo check -p aiproxy-proxy-core 2>&1`
Expected: `Finished` with no errors or warnings related to the changes.

- [ ] **Step 2: Run existing tests**

Run: `cargo test -p aiproxy-proxy-core 2>&1`
Expected: All existing tests pass. No test should be affected since this only adds a timeout wrapper around existing async calls.

- [ ] **Step 3: Commit**

```bash
git add crates/proxy-core/src/lib.rs crates/proxy-core/src/server.rs crates/proxy-core/src/mitm_service.rs
git commit -m "fix: add upstream request timeout to prevent stuck loading sessions

HTTP/2 pooled connections could hang indefinitely if the upstream server
accepted the stream but never responded. The pending session (statusCode=0)
was never replaced with a completed session, leaving the UI stuck in loading.

Add a 120s upstream request timeout to both the HTTPS/MITM and plain HTTP
forward paths. On timeout, a 504 Gateway Timeout session is emitted."
```
