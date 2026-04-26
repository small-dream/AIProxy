# Code Review Report: AIProxy (pharles)

**Date:** 2026-04-26  
**Scope:** Performance issues and logic bugs across the entire codebase  
**Layers reviewed:** Rust core crates, Tauri app layer, Frontend React/TypeScript  

---

## Executive Summary

| Severity | Performance | Logic Bug | Total |
|----------|-------------|-----------|-------|
| **High** | 7 | 10 | **17** |
| **Medium** | 18 | 16 | **34** |
| **Low** | 10 | 8 | **18** |
| **Total** | **35** | **34** | **69** |

The most critical issues are:
1. **Broken TLS certificate caching** (`CertStorage::clone` creates empty cache) — every MITM connection regenerates a certificate
2. **Missing DB transactions** in multi-statement write operations — risk of data corruption on failure
3. **Unbounded channels** — OOM risk when frontend can't keep up with event stream
4. **Accept loop breaks on transient errors** — a single `ECONNABORTED` kills the entire proxy
5. **WebSocket frame size unbounded** — malicious peer can OOM the proxy
6. **DB write failures silently ignored** — in-memory and DB state diverge permanently

---

## Remediation Status (2026-04-26)

Verified and fixed in this pass:

- [x] H1 Unbounded proxy session/WebSocket event channels: replaced the main proxy event channels with bounded `mpsc::channel(4096)` and awaited sends for backpressure.
- [x] H2/H3 HTTP response head reader: replaced byte-at-a-time reading with chunked reads, added `MAX_HEADER_BYTES`, and preserved any over-read WebSocket bytes for the relay.
- [x] H4 Accept loop: changed transient `listener.accept()` failures to log and continue instead of stopping the proxy.
- [x] H5 WebSocket frame allocation: added `MAX_WS_FRAME_SIZE` and checked `u64 -> usize` conversion before allocation.
- [x] H6 Direct request HTTP client: reused a process-wide `reqwest::Client` instead of creating one per direct request.
- [x] H8/H9/H10/M24/M28 DB atomicity: wrapped session upsert, breakpoint replacement, script-run replacement, environment variable replacement, and collection-tree deletion in transactions.
- [x] H11 Collection deletion recursion: replaced recursive deletion with an iterative visited-set traversal to avoid cycles/stack overflow.
- [x] H12 Body store path traversal: validated body path segments and made reads/existence checks reject paths outside the body store.
- [x] H13/M30/L15 TLS host cert cache: shared `CertStorage` cache across clones, avoided check-then-insert races by holding the cache lock through insertion, and made cache clearing poison-tolerant.
- [x] H14 Issuer certificate re-signing: cached the root issuer certificate in `RootCaPair`/`RootCaSignData` and reused it for host cert signing.
- [x] H17/M42 Command DB failures and active throttle writes: changed rule/throttle/DNS/breakpoint command handlers to return DB errors before mutating in-memory managers, and made active throttle profile persistence transactional.
- [x] H7 Script timeout handling: added a QuickJS interrupt handler and timeout test so infinite-loop scripts return `TimedOut` instead of continuing indefinitely.
- [x] H16/F1/F2 Long-list memory/rendering: capped in-memory WebSocket messages, added an LRU cap for session detail cache, and virtualized the Session Explorer and WebSocket message list.
- [x] H15 Session persistence lock contention: split row construction/status reads out of the DB lock and moved eviction DB/body/cache cleanup out of the session-list lock.
- [x] M6 Request body DoS guard: added request body read timeout and `Content-Length` upper bound.
- [x] M31 Windows PowerShell thumbprint handling: passed thumbprints as PowerShell arguments instead of interpolating them into scripts.
- [x] M37 List command DB errors: changed DB-backed list commands to return errors instead of silently returning empty arrays.
- [x] M41 Proxy restart behavior: removed the unconditional session clear during proxy start/restart.
- [x] M1/M2 Response spool I/O: moved response spool file creation/read/write to Tokio fs APIs and increased the read buffer.
- [x] M3/M4 DNS override and WSS TLS config: build the overridden request once with the original `Host` header, and cache the dangerous WSS client TLS config.
- [x] M9 DNS override lookup: replaced clone/sort lookup with a single-pass `max_by_key` while holding the manager lock.
- [x] M10/M11 Throttle behavior: use `rand` for packet loss sampling and avoid applying latency twice per request/response cycle.
- [x] M12/M13/M14 WebSocket relay internals: mask outgoing frames in chunks, warn on duplicate registry entries, and recover from poisoned registry mutexes.
- [x] M16 Proxy body serialization: load body bytes once when serializing instead of cloning/reading twice.
- [x] M26/M27 Session DB cleanup/casts: explicitly delete dependent session rows in a transaction and saturate `duration_ms` conversion to `i64`.
- [x] M38 Shutdown order: abort the collector before shutting down the proxy server.
- [x] M43 Session Explorer expanded lookup: replaced repeated array membership checks with a `Set`.
- [x] M18/M19 Content-Encoding decode: parsed comma-separated encodings exactly and decoded stacked encodings in reverse order.
- [x] M36 Delete rule unknown type: now returns an error for unknown rule types.
- [x] F3 Throttle profile fallback logic: limited local fallback deactivation to profiles in the same workspace.

Verified but not completed in this pass:

- [ ] Remaining medium/low performance cleanups not listed above remain open unless separately addressed.

Validation:

- [x] `cargo check`
- [x] `cargo test -p aiproxy-db -p aiproxy-tls-manager -p aiproxy-rule-engine -p aiproxy-proxy-core` (passed outside sandbox; sandbox run cannot bind local test ports)
- [x] `pnpm --filter @aiproxy/desktop typecheck`
- [x] `pnpm --filter @aiproxy/desktop lint`
- [ ] `cargo fmt` could not run because `rustfmt` is not installed for the active stable toolchain.

---

## High Severity Issues

### 1. Unbounded channels — OOM risk under load

- **File:** `crates/proxy-core/src/server.rs:35`
- **Category:** Performance
- **Description:** `session_sender`/`session_receiver` and `ws_message_sender`/`ws_message_receiver` use `mpsc::unbounded_channel()`. If the consumer is slow or blocked, the proxy keeps pushing messages without backpressure. With 1024 concurrent connections each producing session details, memory grows without limit.
- **Code:**
  ```rust
  let (session_sender, session_receiver) = mpsc::unbounded_channel();
  let (ws_message_sender, ws_message_receiver) = mpsc::unbounded_channel();
  ```
- **Fix:** Use `mpsc::channel(4096)` with `.send().await` for backpressure.

---

### 2. Byte-at-a-time HTTP response head reading

- **File:** `crates/proxy-core/src/server.rs:1403-1417`
- **Category:** Performance
- **Description:** `read_http_response_head` reads one byte at a time with `read_exact(&mut byte)`. For a typical 200-500 byte response head, this results in 200-500 individual read syscalls. This is on the hot path for every WebSocket upgrade.
- **Code:**
  ```rust
  async fn read_http_response_head<R: AsyncReadExt + Unpin>(reader: &mut R) -> Result<String, String> {
      let mut buf = Vec::new();
      let mut byte = [0u8; 1];
      loop {
          reader.read_exact(&mut byte).await.map_err(|e| format!("read response head: {e}"))?;
          buf.push(byte[0]);
          if buf.len() >= 4 && &buf[buf.len() - 4..] == b"\r\n\r\n" {
              return String::from_utf8(buf).map_err(|e| format!("response head utf8: {e}"));
          }
      }
  }
  ```
- **Fix:** Read in larger chunks (e.g., 4KB) and scan for `\r\n\r\n` within the buffer, similar to `read_proxy_request_from_stream`.

---

### 3. No size limit on response head reading — OOM from malicious upstream

- **File:** `crates/proxy-core/src/server.rs:1403-1417`
- **Category:** Logic Bug
- **Description:** `read_http_response_head` has no maximum size limit. A malicious upstream server could send an infinite stream without `\r\n\r\n`, causing unbounded memory allocation. `read_proxy_request_from_stream` correctly has `MAX_HEADER_BYTES`, but this function does not.
- **Fix:** Add `if buf.len() > MAX_HEADER_BYTES { return Err(...); }` inside the loop.

---

### 4. Accept error kills entire proxy

- **File:** `crates/proxy-core/src/server.rs:123-130`
- **Category:** Logic Bug
- **Description:** When `listener.accept()` returns an error, the server `break`s out of the main accept loop, shutting down the proxy. Transient errors (`ECONNABORTED`, `EMFILE`, `EINTR`) are recoverable and should not stop the proxy.
- **Code:**
  ```rust
  Err(error) => {
      emit_log("ERROR", "listener_accept_failed", &[("error", error.to_string())]);
      break;  // shuts down the entire proxy
  }
  ```
- **Fix:** Log the error and `continue` instead of `break`. Only `break` on non-recoverable errors.

---

### 5. WebSocket frame size unbounded — OOM from malicious peer

- **File:** `crates/proxy-core/src/ws.rs:103`
- **Category:** Logic Bug
- **Description:** `parse_ws_frame` allocates `vec![0u8; payload_len as usize]` with no limit. On 32-bit targets, the `u64` to `usize` cast silently truncates. Even on 64-bit, a malicious peer sending `payload_len = u64::MAX` causes OOM.
- **Code:**
  ```rust
  let mut payload = vec![0u8; payload_len as usize];
  ```
- **Fix:** Add `if payload_len > MAX_WS_FRAME_SIZE { return Err(...); }` and use `usize::try_from(payload_len)`.

---

### 6. New HTTP Client per request — no connection reuse

- **File:** `crates/proxy-core/src/server.rs:2071-2225`
- **Category:** Performance
- **Description:** `send_direct_request` creates a brand new `Client` for every request. The `Client` manages a connection pool, TLS session cache, and DNS cache. Creating a new one each time means no connection reuse, no TLS session resumption, and repeated DNS lookups.
- **Code:**
  ```rust
  let client = Client::builder()
      .redirect(Policy::none())
      .no_proxy()
      .build()
      .map_err(|e| format!("failed to create HTTP client: {e}"))?;
  ```
- **Fix:** Accept a shared `Arc<Client>` as parameter, or use a module-level `OnceLock<Client>`.

---

### 7. Leaked thread on script timeout

- **File:** `crates/rule-engine/src/lib.rs:337-342`
- **Category:** Logic Bug
- **Description:** When a script times out, the spawned thread continues running the JS runtime to completion. Under sustained timeouts, this leaks OS threads and memory. There is no mechanism to kill or join the timed-out thread.
- **Code:**
  ```rust
  std::thread::spawn(move || {
      let execution = run_script_in_thread(&compiled_code, hook_name, &payload_json);
      let _ = sender.send(execution);
  });
  match receiver.recv_timeout(SCRIPT_EXECUTION_TIMEOUT) {
      // On timeout, the thread is abandoned
  ```
- **Fix:** Store the `JoinHandle` and either detach with a warning log, or use a cooperative cancellation mechanism (e.g., `AtomicBool` flag).

---

### 8. `upsert_session` not in a transaction

- **File:** `crates/db/src/sessions.rs:46-83`
- **Category:** Logic Bug
- **Description:** `upsert_session` performs two `INSERT OR REPLACE` statements without a transaction. If the second insert fails (disk full, constraint violation), the summary is committed but the detail is lost, leaving an orphaned summary row.
- **Fix:** Wrap both inserts in a transaction: `let tx = conn.transaction()?; ... tx.commit()?;`

---

### 9. `replace_breakpoint_rules` not atomic

- **File:** `crates/db/src/rules.rs:257-271`
- **Category:** Logic Bug
- **Description:** Deletes all rules then inserts new ones without a transaction. If any insert fails or the process crashes, all breakpoint rules are lost. The doc comment says "atomically" but it is not.
- **Fix:** Wrap in a transaction.

---

### 10. `replace_script_runs_for_session` not atomic

- **File:** `crates/db/src/rules.rs:480-534`
- **Category:** Logic Bug
- **Description:** Same pattern: deletes then inserts without a transaction. Script run data can be partially lost on failure.
- **Fix:** Wrap in a transaction.

---

### 11. `delete_collection_tree` has no cycle detection

- **File:** `crates/db/src/collections.rs:117-141`
- **Category:** Logic Bug
- **Description:** Recursively deletes children by following `parent_id` references. If a cycle exists (A's parent is B, B's parent is A), this recurses infinitely until stack overflow.
- **Code:**
  ```rust
  fn delete_collection_tree(conn: &Connection, id: &str) -> Result<(), String> {
      let children: Vec<String> = ...;
      for child_id in children {
          delete_collection_tree(conn, &child_id)?;  // no cycle detection
      }
  ```
- **Fix:** Track visited IDs in a `HashSet` or use an iterative approach with a work queue.

---

### 12. Path traversal vulnerability in `body_store`

- **File:** `crates/db/src/body_store.rs:75`
- **Category:** Logic Bug
- **Description:** `resolve_body_path` joins `base_dir` with an arbitrary `relative_path` from the database. A path like `../../etc/passwd` would read arbitrary files. Similarly, `write_body` constructs paths from `session_id` without sanitization.
- **Code:**
  ```rust
  pub fn resolve_body_path(&self, relative_path: &str) -> PathBuf {
      self.base_dir.join(relative_path)
  }
  ```
- **Fix:** Validate that the resolved path is still under `base_dir` using `canonicalize` + `starts_with`. Validate `session_id` contains only safe characters.

---

### 13. `CertStorage::clone()` creates disconnected empty cache

- **File:** `crates/tls-manager/src/storage.rs:24-34`
- **Category:** Logic Bug
- **Description:** The `Clone` implementation creates a **fresh empty** `host_cache` instead of sharing the existing cache. When `CertStorage` is cloned (in `RootCaPair::create_server_config`), the resolver gets a clone with an empty cache completely disconnected from the original. This **completely defeats certificate caching** — every MITM connection regenerates a certificate.
- **Code:**
  ```rust
  impl std::clone::Clone for CertStorage {
      fn clone(&self) -> Self {
          Self {
              host_cache: Mutex::new(HashMap::new()), // fresh empty cache!
          }
      }
  }
  ```
- **Fix:** Wrap `host_cache` in `Arc<Mutex<HashMap<...>>>` so clones share the same cache.

---

### 14. Re-self-signs issuer cert on every host cert signing

- **File:** `crates/tls-manager/src/generator.rs:198`
- **Category:** Performance
- **Description:** Both `sign_host_certificate` and `sign_host_certificate_from_data` call `params.clone().self_signed(&key_pair)?` to re-derive the issuer certificate on **every single host certificate signing**. This is an expensive RSA operation that produces the same result every time.
- **Code:**
  ```rust
  let issuer_cert = root_ca.cert_params.clone().self_signed(&root_ca.key_pair)?;
  let cert = params.signed_by(&host_key_pair, &issuer_cert, &root_ca.key_pair)?;
  ```
- **Fix:** Pre-compute and cache the issuer certificate in `RootCaPair` at construction time.

---

### 15. Lock contention in `upsert_session` — 4 mutexes on hot path

- **File:** `apps/desktop/src-tauri/src/bootstrap/mod.rs:313-413`
- **Category:** Performance
- **Description:** `upsert_session` acquires the `db` mutex, then `status` mutex, then `session_details` mutex, then `sessions` mutex. The eviction loop re-acquires `db` and `session_details` per iteration. This is called for every proxied request.
- **Fix:** Restructure into clearly separated phases with minimal lock hold times. Collect IDs to evict, release lock, then perform DB deletes separately.

---

### 16. Unbounded `session_details` HashMap

- **File:** `apps/desktop/src-tauri/src/bootstrap/mod.rs:71, 367-370`
- **Category:** Performance
- **Description:** The `session_details` HashMap grows to 15,000 entries with no LRU eviction. Each `ProxySessionDetail` can be large (headers, cookies, body references), leading to significant memory pressure.
- **Fix:** Implement an LRU cache with configurable capacity (e.g., 500-1000 entries). Use a crate like `lru` or `moka`.

---

### 17. DB write failures silently ignored — in-memory and DB state diverge

- **File:** `apps/desktop/src-tauri/src/commands/mod.rs` (multiple locations)
- **Category:** Logic Bug
- **Description:** Multiple command handlers persist to DB first, then update in-memory state. If the DB write fails, the error is logged but the in-memory update proceeds anyway. On app restart, the change is lost. Affects `set_breakpoint_rules`, `save_rewrite_rule`, `save_map_rule`, `save_dns_mapping`, `save_throttle_profile`, `set_active_throttle_profile`.
- **Code:**
  ```rust
  if let Err(error) = aiproxy_db::rules::save_rewrite_rule(&conn, &row) {
      log_error("desktop.commands", "save_rewrite_rule_db_failed", &[("error", error)]);
  }
  // In-memory update proceeds regardless:
  state.read_rewrite_manager().save_rule(input)
  ```
- **Fix:** Return the DB error to the frontend. Do not update in-memory state if DB write fails.

---

## Medium Severity Issues

### Rust — proxy-core

| # | File | Cat | Issue | Fix |
|---|------|-----|-------|-----|
| M1 | `server.rs:822` | Perf | Blocking `std::fs::File` in async `read_response_body_with_limit` | Use `tokio::fs::File` or `spawn_blocking` |
| M2 | `server.rs:913` | Perf | Blocking file read in `write_spooled_upstream_response` | Use `tokio::fs::File`, increase buffer to 64KB |
| M3 | `server.rs:723` | Perf | DNS override rebuilds entire request (double clone of headers+body) | Determine overridden URL upfront, build request once |
| M4 | `server.rs:1025` | Perf | `build_dangerous_client_tls_config()` called per WSS connection | Cache with `OnceLock` |
| M5 | `server.rs:860` | Bug | After body truncation, empty `extend_from_slice` on every subsequent chunk | Add early `continue` when `!preserve_full_body` and buffer is full |
| M6 | `server.rs:2032` | Bug | No timeout on request body read + no upper bound on `Content-Length` | Add timeout and `MAX_CAPTURED_BODY_BYTES` check |
| M7 | `breakpoints.rs:84` | Perf | `BreakpointManager` uses `Mutex` + clones entire rule list per request | Use `RwLock` for read-mostly access |
| M8 | `rules.rs:64+` | Perf | All rule managers use `Mutex` + clone entire list per read | Use `RwLock` or `Arc`-swap (copy-on-write) |
| M9 | `rules.rs:295` | Perf | `resolve_dns_override` clones + sorts for a single lookup | Use `max_by` in single pass under read lock |
| M10 | `rules.rs:1095` | Bug | `should_drop_for_packet_loss` uses `SystemTime` nanos as "random" | Use `rand::thread_rng()` |
| M11 | `rules.rs:1123` | Bug | `latency_ms` applied twice per request-response cycle | Apply latency only once, or split in half |
| M12 | `ws.rs:175` | Perf | WebSocket masking allocates full-payload `Vec` | Mask in-place or write in chunks |
| M13 | `ws.rs:320` | Bug | `WsConnectionRegistry::register` silently replaces existing entry | Check for duplicate and warn/error |
| M14 | `ws.rs:321+` | Bug | `.expect()` on mutex instead of `.unwrap_or_else(\|e\| e.into_inner())` | Use consistent poison recovery |
| M15 | `types.rs:328` | Perf | `ProxyBodyReference::load_bytes()` clones `Arc<[u8]>` into `Vec` every call | Return `Arc<[u8]>` directly |
| M16 | `types.rs:337` | Perf | `serialize()` calls `load_bytes()` twice — double clone of body bytes | Load once, derive both inline and base64 from it |
| M17 | `http_io.rs:314` | Perf | Always decodes body even when not needed for display | Check `should_render_body_as_text` before decoding |
| M18 | `http_io.rs:346` | Bug | `decode_body_bytes` uses substring matching (`contains("br")`) | Parse as comma-separated tokens with exact match |
| M19 | `http_io.rs:346` | Bug | Only decodes one encoding layer — `Content-Encoding: gzip, br` not handled | Decode in reverse order of application |
| M20 | `logging.rs:18` | Perf | Opens+writes+closes log file on every emission | Keep file open or use channel-based batch writer |

### Rust — rule-engine

| # | File | Cat | Issue | Fix |
|---|------|-----|-------|-----|
| M21 | `lib.rs:334` | Perf | `compiled_code` cloned on every hook execution | Store as `Arc<str>` |
| M22 | `lib.rs:163` | Perf | `list_rules()` clones every rule | Return references or use Arc-swap |
| M23 | `lib.rs:570` | Bug | `build_runtime_module` uses fragile `.replace()` — breaks on comments/strings | Use regex or AST-based approach |

### Rust — db

| # | File | Cat | Issue | Fix |
|---|------|-----|-------|-----|
| M24 | `environments.rs:110` | Bug | `set_environment_variables` not atomic | Wrap in transaction |
| M25 | `sessions.rs:103` | Bug | `filter_map(.ok())` silently drops corrupted rows (many locations) | Log warnings or return aggregate error |
| M26 | `sessions.rs:164` | Bug | `delete_sessions_by_ids` relies on CASCADE for details/ws_messages | Add explicit deletes for safety |
| M27 | `sessions.rs:59` | Bug | `u128` to `i64` truncation for `duration_ms` | Change to `u64` with saturating cast |
| M28 | `collections.rs:117` | Bug | `delete_collection_tree` not atomic | Wrap in transaction |
| M29 | `workspaces.rs:62` | Bug | `load_workspace` swallows all errors as `None` | Return `Result<Option<...>, String>` |

### Rust — tls-manager

| # | File | Cat | Issue | Fix |
|---|------|-----|-------|-----|
| M30 | `storage.rs:149` | Bug | TOCTOU race in `get_or_create_host_certified_key` | Use `entry().or_insert_with()` while holding lock |
| M31 | `trust.rs:77` | Bug | PowerShell script injection via thumbprint interpolation | Pass thumbprint as parameter, not string interpolation |
| M32 | `trust.rs:122` | Perf | `is_trusted_linux` reads all system certs per call | Cache result in `OnceCell` |
| M33 | `trust.rs:85` | Perf | `is_trusted_windows` spawns PowerShell per call | Cache result |

### Tauri App Layer

| # | File | Cat | Issue | Fix |
|---|------|-----|-------|-----|
| M34 | `commands/mod.rs` | Perf | Blocking DB I/O in async Tauri commands | Use `spawn_blocking` for DB operations |
| M35 | `bootstrap/mod.rs:197` | Bug | `read_session_detail` acquires 3 mutexes with stale data risk | Load summary and detail in single DB query |
| M36 | `commands/mod.rs:2278` | Bug | `delete_rule` silently succeeds for unknown rule types | Return error for unknown types |
| M37 | `commands/mod.rs` | Bug | List commands return empty Vec on DB error | Return `Result<Vec<...>, String>` |
| M38 | `commands/mod.rs:1144` | Bug | Collector aborted *after* proxy server shutdown | Abort collector first, then shutdown server |
| M39 | `session_stats.rs:73` | Perf | Opens+writes+closes log file + `create_dir_all` on every session | Keep file open, create dir once at init |
| M40 | `bootstrap/mod.rs:190` | Perf | `read_sessions` clones entire 15,000-entry Vec per call | Use `Arc<ProxySessionSummary>` or serialize under lock |
| M41 | `commands/mod.rs:957` | Bug | `start_proxy_impl` clears all sessions on proxy restart | Make session clearing optional |
| M42 | `commands/mod.rs:2401` | Perf | N+1 DB writes when setting active throttle profile | Batch update in single transaction |

### Frontend

| # | File | Cat | Issue | Fix |
|---|------|-----|-------|-----|
| M43 | `SessionExplorerPane.tsx` | Perf | `expandedHosts.includes()` O(n) per tree node | Use `Set.has()` for O(1) |
| M44 | `use-session-events.ts` | Bug | `onSessionUpsert` invalidates session detail on every event | Only invalidate when session ID matches selected |
| M45 | `use-breakpoint-events.ts` | Bug | Race condition in event listener cleanup | Ensure async `unlisten` completes before cleanup |
| M46 | `use-session-context-actions.ts` | Bug | `handleRepeatDirect` silently swallows errors | Show error feedback to user |
| M47 | `SessionInspectorJsonTree.tsx` | Bug | Resets expansion state when `value` object reference changes | Use stable key or preserve expansion across updates |

---

## Low Severity Issues

| # | File | Cat | Issue |
|---|------|-----|-------|
| L1 | `server.rs:2121` | Perf | Unnecessary clones of `header_map` and `body_bytes` in `send_direct_request` — move instead of clone |
| L2 | `server.rs:1931` | Perf | New `chunk` buffer allocated on every `read_proxy_request_from_stream` call |
| L3 | `server.rs:239` | Perf | CA cert response built with `format!` — write header and body separately |
| L4 | `server.rs:920` | Perf | Response head built as String then converted to bytes — write directly to stream |
| L5 | `server.rs:1277` | Bug | WSS `ServerName` parse failure falls back to `Ipv4Addr::LOCALHOST` — try IP parse first, else error |
| L6 | `server.rs:898` | Bug | Spooled response files never cleaned up on crash — add startup cleanup |
| L7 | `rule-engine/lib.rs:179` | Perf | Double clone in `save_rule` — extract public_rule first, then move |
| L8 | `rule-engine/lib.rs:357` | Perf | Unnecessary `std::mem::take` on already-owned value |
| L9 | `rule-engine/lib.rs:461` | Perf | `trim_to_byte_limit` does not pre-allocate String — use `with_capacity` |
| L10 | `rule-engine/lib.rs:67` | Perf | `duration_ms` as `u128` is overkill — use `u64` |
| L11 | `db/workspaces.rs:91` | Bug | `is_empty` swallows database errors — return `Result<bool, String>` |
| L12 | `db/sessions.rs:290` | Bug | LIKE pattern escaping misses backslash — escape `\\` first |
| L13 | `tls-manager/generator.rs:47` | Perf | Unnecessary clone of `params` in `RootCaPair::generate` |
| L14 | `tls-manager/generator.rs:246` | Perf | Per-byte allocation in `compute_fingerprint` — pre-allocate and `write!` |
| L15 | `tls-manager/storage.rs:181` | Bug | Inconsistent mutex poisoning handling in `clear_host_cache` |
| L16 | `tls-manager/lib.rs:10` | Perf | Double string allocation in `emit_log` field escaping |
| L17 | `bootstrap/mod.rs:183` | Perf | `read_status()` clones `BootstrapStatus` on every call in hot path |
| L18 | `commands/mod.rs:3036` | Perf | `substitute_vars` does O(n*m) string replacement — single-pass replacement |

---

## Frontend High Severity Issues (Detailed)

### F1. No virtualization for session explorer tree

- **File:** `apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx`
- **Category:** Performance
- **Description:** The session explorer renders all sessions as DOM nodes without virtualization. With thousands of sessions grouped by host, this causes severe DOM bloat and rendering lag.
- **Fix:** Use `react-virtuoso` or `@tanstack/virtual` for the session list.

### F2. No virtualization for WebSocket message list

- **File:** `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx`
- **Category:** Performance
- **Description:** WebSocket messages are rendered as a flat list without virtualization. Long-lived connections can accumulate thousands of messages, causing DOM bloat. Additionally, the message array grows without bound.
- **Fix:** Add virtualization and a message count limit (e.g., keep last 10,000 messages).

### F3. Incorrect throttle profile enabled logic

- **File:** `apps/desktop/src/services/commands/index.ts`
- **Category:** Logic Bug
- **Description:** When saving a throttle profile, the code incorrectly toggles `enabled` on ALL other profiles for the workspace instead of only deactivating the previously active profile.
- **Fix:** Only modify the `enabled` flag on the previously active profile and the newly saved profile.

---

## Priority Recommendations

Fix these issues first, in order:

1. **`CertStorage::clone()` (tls-manager)** — Completely breaks TLS certificate caching. Every MITM connection regenerates a certificate instead of using the cache. Use `Arc<Mutex<HashMap>>` for shared cache.

2. **Add transactions to DB write operations** — `upsert_session`, `replace_breakpoint_rules`, `replace_script_runs_for_session`, `set_environment_variables`, `delete_collection_tree` all risk data corruption on failure.

3. **Use bounded channels** — Replace `mpsc::unbounded_channel()` with `mpsc::channel(4096)` to prevent OOM when the frontend can't keep up.

4. **Fix accept loop error handling** — `continue` instead of `break` on transient accept errors to prevent proxy from dying.

5. **Add WebSocket frame size limit** — Prevent OOM from malicious peers.

6. **Fix response head reading** — Read in chunks (not byte-at-a-time) and add a size limit.

7. **Cache issuer certificate** — Pre-compute in `RootCaPair` instead of re-signing on every host cert.

8. **Share HTTP Client** — Reuse a single `Client` in `send_direct_request` for connection pooling.

9. **Fix DB write error handling** — Don't update in-memory state if DB write fails; return error to frontend.

10. **Add virtualization** — Use `react-virtuoso` or similar for session explorer tree and WebSocket message list.

11. **Fix `delete_collection_tree`** — Add cycle detection (visited `HashSet`) and wrap in transaction.

12. **Fix path traversal in `body_store`** — Validate paths don't escape base directory.

13. **Fix `decode_body_bytes`** — Parse `Content-Encoding` as comma-separated tokens and decode in reverse order.

14. **Fix throttle latency double-application** — Apply `latency_ms` only once per request-response cycle.

15. **Fix `build_runtime_module`** — Use regex or AST-based export rewriting instead of fragile `.replace()`.
