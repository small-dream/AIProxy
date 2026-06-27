# Bug 审计修复计划 — Phase 3（rule-engine + db 一致性 / 中危）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 修复 BUG_AUDIT_2026-06-27.md Phase 3 共 6 个中危问题（M1/M2/M3/M5/M6/M7），覆盖脚本编译/执行正确性与 db/ws 一致性。

**Architecture:** 每个修复用 TDD。rule-engine 用现有 `base_rule()`/`payload()`/`execute_request_hook()` 测试框架（含 rquickjs runtime）；db 用 `test_conn()` in-memory；ws_upgrade 用 `send_ws_upgrade_via_proxy` 集成测试。

**Tech Stack:** Rust 2021 / rquickjs / rusqlite / hyper。测试 `cargo test -p aiproxy-rule-engine` / `-p aiproxy-db` / `-p aiproxy-proxy-core`。

## Global Constraints

（CLAUDE.md）代码注释英文；跨平台；不留空 catch；错误带上下文；结构化日志；每 task 一次提交（英文 conventional commit + `Co-Authored-By: Claude <noreply@anthropic.com>`）；继续在 `fix/bug-audit-remediation` 分支累积。

## 侦察确认的测试基础设施

- `crates/rule-engine/src/lib.rs`：`base_rule(language, source)`、`payload()`、`execute_request_hook(&compiled, &payload)`、`compiles_typescript_and_detects_entrypoints`（:82）、`supports_short_circuit_mock_responses`（:165）、`fails_open_on_runtime_errors`（:187）。`detect_entrypoints`/`build_runtime_module` 在 `compile.rs`（:60-90, :143-153）。
- `crates/db/src/workspaces.rs`：`is_empty`（:137-145），`seed_default_and_load` 测试（:174-196）。**调用方：`apps/desktop/src-tauri/src/main.rs`**（判断是否 seed default）。
- `crates/db/src/rules.rs`：`clear_script_runs`（:1199-1204）；疑似无调用方（仍修事务正确性）。
- `crates/proxy-core/src/ws_upgrade.rs`：非 101 路径（:322-390，leftover 当 body 在 :338）；测试 `ws_upgrade_non_101_response_no_registry_no_duplicate_session`（tests.rs:1848）。

---

## Task 1: M1 — rule-engine 支持 `export async function` 导出

**Files:**
- Modify: `crates/rule-engine/src/compile.rs:60-90`（`detect_entrypoints` 正则 + contains 检查）、`:143-153`（`build_runtime_module` 替换）
- Test: `crates/rule-engine/src/lib.rs`（`compiles_typescript_and_detects_entrypoints` 附近）

**Bug:** 正则 `export\s+function\s+(onRequest|onResponse)\s*\(` 不匹配 `export async function`；`source.contains("export function onRequest")` 也不匹配。用户写合法 TS async 导出会被拒，报「只支持 onRequest/onResponse」误导信息。deno_ast transpile 后保留 `export async function`。

- [ ] **Step 1: 写失败测试**（lib.rs `mod tests`）

```rust
    #[test]
    fn detects_async_function_entrypoints() {
        let source = "export async function onRequest(ctx) { await ctx.request.getText(); }";
        let entrypoints = detect_entrypoints(source).expect("async export is valid");
        assert!(entrypoints.on_request);
        assert!(!entrypoints.on_response);
    }

    #[test]
    fn compiles_async_function_export_and_runs() {
        let rule = base_rule(
            ScriptRuleLanguage::TypeScript,
            "export async function onRequest(ctx) { ctx.log.info(\"async ok\"); }",
        );
        let compiled = compile_script_rule(&rule).expect("async TS compiles");
        let result = execute_request_hook(&compiled, &payload());
        // Should run (not be rejected); at minimum not a compile/skip failure.
        assert!(result.trace.entries.iter().any(|e| e.message.as_deref() == Some("async ok")));
    }
```

> Worker：核对 `detect_entrypoints` 可见性（`pub(crate)`? 测试在同 crate 用 `super::*`）。`base_rule`/`compile_script_rule`/`execute_request_hook`/`payload` 签名以 lib.rs 现有测试为准。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p aiproxy-rule-engine detects_async_function_entrypoints compiles_async_function_export_and_runs`
Expected: FAIL（当前正则拒绝 async → detect_entrypoints 返回 Err / 不识别）。

- [ ] **Step 3: 修复正则 + 替换**

`compile.rs`：
- `ALLOWED_EXPORT_RE` 改为 `r"export\s+(?:async\s+)?function\s+(onRequest|onResponse)\s*\("`。
- `replace_all` 保持 `function $1(`（替换掉 `export`/`async` 前缀，留下 `function onRequest(`）。
- `on_request = source.contains("export function onRequest")` 这类检查：改为也检查 `export async function onRequest`，或改用一个新的匹配（如对 strip 后判断）。最稳妥：用更新后的正则 `is_match` 判断 on_request/on_response 分别是否存在（`export\s+async\s+function onRequest` 或 `export\s+function onRequest`）。
- `build_runtime_module`：把 `"export function onRequest"` / `"export function onResponse"` 两个替换分支，各增加 `"export async function onRequest"` / `"export async function onResponse"` 替换（替换为 `function onRequest(` 等同结果）。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p aiproxy-rule-engine` — Expected: PASS（新测试 + 既有 `compiles_typescript_and_detects_entrypoints` 等）。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(rule-engine): support export async function entrypoints (M1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: M5 — `workspaces::is_empty` 不再把 DB 错误当空表

**Files:**
- Modify: `crates/db/src/workspaces.rs:137-145`（`is_empty` 改返回 `Result<bool, DbError>`）
- Modify: `apps/desktop/src-tauri/src/main.rs`（调用方：处理 `Result`）
- Test: `crates/db/src/workspaces.rs` `mod tests`

**Bug:** `Err` 分支返回 `true` → 调用方误判「无 workspace」去 seed，可能覆盖既有数据。返回 `bool` 丢失错误。

**设计决策：** 改签名为 `Result<bool, DbError>`（正确传播），并更新 main.rs 调用方处理错误（错误时**不 seed**——保守，错误状态下不写入比覆盖数据安全；记录日志）。若 main.rs 调用方改动过大，fallback：保守返回 `false`（不 seed）+ 日志，但优先 Result。

- [ ] **Step 1: 写失败测试**

```rust
    #[test]
    fn is_empty_propagates_db_error() {
        // An in-memory connection WITHOUT the schema migrated: querying the
        // workspaces table errors. is_empty must propagate Err, not return true.
        let conn = Connection::open_in_memory().unwrap();
        let result = is_empty(&conn);
        assert!(result.is_err(), "is_empty must propagate DB errors, not mask as empty");
    }
```

> Worker：确认未 migrate 的 in-memory conn 查询 workspaces 表确实报错（表不存在）。若 `load_all_workspaces` 在表缺失时返回 Err，测试有效。

- [ ] **Step 2: 运行确认失败** — Expected: FAIL（当前返回 `true`）。

- [ ] **Step 3: 改签名 + 调用方**

`workspaces.rs`：
```rust
pub fn is_empty(conn: &Connection) -> Result<bool, DbError> {
    let workspaces = load_all_workspaces(conn)?;
    Ok(workspaces.is_empty())
}
```

`main.rs` 调用方：把 `if workspaces::is_empty(&conn) { seed... }` 改为处理 `Result`：
```rust
let needs_seed = match workspaces::is_empty(&conn) {
    Ok(empty) => empty,
    Err(e) => {
        tracing::warn!(event = "workspace_is_empty_check_failed", error = %e, "failed to check workspaces; skipping default seed to avoid overwrite");
        false  // do NOT seed on error
    }
};
if needs_seed { /* seed default */ }
```

> Worker：读 main.rs 实际调用上下文，对齐变量名/seed 逻辑。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p aiproxy-db` + `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`（确认 main.rs 编译）。Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(db): propagate DB errors from workspaces::is_empty; don't seed on error (M5)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: M6 — `clear_script_runs` 包事务

**Files:**
- Modify: `crates/db/src/rules.rs:1199-1204`（`clear_script_runs`）
- Test: `crates/db/src/rules.rs`（新增 test，参考 `script_runs_round_trip`）

**Bug:** 先 `DELETE FROM script_run_entries` 再 `DELETE FROM script_runs`，无事务；第二步失败留下「无 entries 的空 run」数据不一致。同 crate 其它多步写都用了 `unchecked_transaction()`。疑似无调用方（仍修正确性）。

- [ ] **Step 1: 写测试**

```rust
    #[test]
    fn clear_script_runs_removes_runs_and_entries_atomically() {
        let conn = test_conn();
        // insert a script_run + entries (reuse helpers from script_runs_round_trip)
        // ... setup ...
        clear_script_runs(&conn).unwrap();
        // both tables empty
        assert!(/* script_runs query */.is_empty());
        assert!(/* script_run_entries query */.is_empty());
    }
```

> Worker：核对 `script_runs_round_trip` 的 setup helper（插入 run + entries 的方式），复用。事务原子性难以在单测中模拟「第二步失败」，所以测试至少锁定「调用后两表都空 + 不留孤儿」；事务本身靠代码审查 + 与同 crate 模式一致。

- [ ] **Step 2: 运行确认状态** — 若 setup 正确，测试在修复前可能已通过（功能正确，只是无事务）；记录状态。重点在 Step 3 加事务。

- [ ] **Step 3: 包事务**

```rust
pub fn clear_script_runs(conn: &Connection) -> Result<(), DbError> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM script_run_entries", [])
        .map_err(|e| DbError::query("clear script run entries", e))?;
    tx.execute("DELETE FROM script_runs", [])
        .map_err(|e| DbError::query("clear script runs", e))?;
    tx.commit().map_err(|e| DbError::query("commit clear script runs", e))?;
    Ok(())
}
```

> 核对 `unchecked_transaction`/`DbError::query` 在同 crate 的用法（参考 `replace_*_runs_for_session`）。

- [ ] **Step 4: 运行确认通过** — `cargo test -p aiproxy-db` PASS。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(db): wrap clear_script_runs in a transaction (M6)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: M2 — `respond()` 校验 status 范围/整数

**Files:**
- Modify: `crates/rule-engine/src/js_bridge.rs:180`（`status: Number(init.status ?? 200)` → 加校验，抛结构化错误）
- Test: `crates/rule-engine/src/lib.rs`（`supports_short_circuit_mock_responses` 附近）

**Bug:** `Number("foo")=NaN`→`null`→u16 反序列化失败；`Number(99999)` 越界；非整数。任意非法 status 让规则 decode 失败，错误信息「invalid type」与真实原因无关。

- [ ] **Step 1: 写失败测试**（JS runtime）

```rust
    #[test]
    fn respond_rejects_invalid_status_with_clear_error() {
        let compiled = compile_script_rule(&base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) { ctx.respond({ status: 99999 }); }"#,
        )).unwrap();
        let result = execute_request_hook(&compiled, &payload());
        // Should surface a clear status-validation error (not a generic decode failure).
        // Assert outcome is RuntimeError AND an error entry mentions status.
        assert!(matches!(result.trace.outcome, ScriptRunOutcome::RuntimeError)
            || result.trace.entries.iter().any(|e| {
                e.kind.as_deref() == Some("error") && e.message.as_deref().unwrap_or("").to_lowercase().contains("status")
            }));
    }
```

> Worker：核对 `ScriptRunOutcome` 变体、entry 的 `kind`/`message` 字段名（参考 `fails_open_on_runtime_errors`）。调整断言以匹配实际错误传播路径。

- [ ] **Step 2: 运行确认失败** — Expected: FAIL（当前 decode 失败，错误不含「status」，或 outcome 不是 RuntimeError）。

- [ ] **Step 3: 加校验**

`js_bridge.rs` respond 构造处，把 `status: Number(init.status ?? 200)` 改为先校验：
```js
const status = Number(init.status ?? 200);
if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("respond status must be an integer in 100..599, got: " + init.status);
}
```
然后在对象里用 `status`。这样非法 status 抛 JS Error → 走异常路径（配合 Task 5 的 entries 保留）→ 结构化呈现。

- [ ] **Step 4: 运行确认通过** — `cargo test -p aiproxy-rule-engine` PASS。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(rule-engine): validate respond() status range and integrality (M2)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: M3 — JS 脚本异常时保留已收集的 entries

**Files:**
- Modify: `crates/rule-engine/src/js_bridge.rs:~203`（`fn(ctx)` 调用包 try/catch，异常时 push error entry 保留前面 entries）
- Test: `crates/rule-engine/src/lib.rs`（`fails_open_on_runtime_errors` 附近）

**Bug:** `fn(ctx)` 无 try/catch；脚本抛异常时 `log`/`extract` 已收集的 entries 全部丢失，只冒泡 quickjs 异常文本，排障困难。

**注意：** 与 Task 4（M2）同改 js_bridge，且 M2 的 status 校验抛 Error 依赖 M3 的 try/catch 来结构化呈现。**建议 Task 4 之后做 Task 5**（或合并）。

- [ ] **Step 1: 写失败测试**

```rust
    #[test]
    fn preserves_entries_collected_before_script_exception() {
        let compiled = compile_script_rule(&base_rule(
            ScriptRuleLanguage::JavaScript,
            r#"export function onRequest(ctx) {
                ctx.log.info("before error");
                ctx.extract("k", "v");
                throw new Error("boom");
            }"#,
        )).unwrap();
        let result = execute_request_hook(&compiled, &payload());
        // The pre-throw entries must survive.
        assert!(result.trace.entries.iter().any(|e| e.message.as_deref() == Some("before error")),
            "entries before the throw must be preserved, got: {:?}", result.trace.entries);
    }
```

> Worker：核对 `ctx.log.info` / `ctx.extract` 的实际 JS API（参考 js_bridge 的 ctx 构造 + 现有测试用法）。

- [ ] **Step 2: 运行确认失败** — Expected: FAIL（当前异常丢失 entries）。

- [ ] **Step 3: 包 try/catch**

`js_bridge.rs` `fn(ctx)` 调用改为：
```js
try {
    fn(ctx);
} catch (e) {
    __aiproxyPushEntry({ kind: "error", level: "error", message: String((e && e.message) || e), payloadJson: null });
}
```
（用 `__aiproxyPushEntry` 或 js_bridge 现有的 entry 推送机制——核对实际 API）。这样异常被捕获为 error entry，前面的 entries 保留。outcome 仍标记为 runtime error（在 Rust 侧检测末尾 error entry 或保留原 invoke 错误传播）。

> Worker：核对 entry 推送的 JS 函数名 + outcome 标记机制（Rust 侧如何判定 RuntimeError）。保持 `fails_open_on_runtime_errors` 仍通过（outcome 仍是错误）。

- [ ] **Step 4: 运行确认通过** — `cargo test -p aiproxy-rule-engine` PASS（含 fails_open + 新测试 + Task 4 的 status 测试）。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(rule-engine): preserve entries when a script throws (M3)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: M7 — WS 升级被拒（非 101）流式转发完整 body

**Files:**
- Modify: `crates/proxy-core/src/ws_upgrade.rs:322-390`（非 101 路径：用 leftover + 继续从 upstream 流式读 body，而非只用 leftover 当完整 body）
- Test: `crates/proxy-core/src/tests.rs`（`ws_upgrade_non_101_response_no_registry_no_duplicate_session` :1848 附近）

**Bug:** upstream 返回非 101（拒绝升级）时，用读 head 时多读的 `leftover_bytes` 当完整 body 一次性返回。实际 body 比 leftover 大则截断；chunked/长连接持续发数据则丢失。

- [ ] **Step 1: 写集成测试**

```rust
    #[tokio::test]
    async fn ws_upgrade_non_101_forwards_full_body_beyond_leftover() {
        // Upstream returns 403 with a body LARGER than the head-read leftover.
        // The proxy must forward the FULL body, not just the leftover bytes.
        // ... set up upstream that writes "HTTP/1.1 403 Forbidden\r\nContent-Length: N\r\n\r\n" + N bytes
        //     where N > leftover buffer size, drive via send_ws_upgrade_via_proxy, assert client
        //     receives all N body bytes ...
    }
```

> Worker：核对 `send_ws_upgrade_via_proxy` 的上游 mock 能力（能否控制上游写完整 head+body）、leftover buffer 大小（读 head 时多读多少）、如何从 client 侧断言收到的 body 字节数。复用 :1848 测试的 setup。如果 leftover 机制使得「body 比 leftover 大」难构造，至少构造 body == 一个明显大于 0 且跨 leftover 边界的场景。

- [ ] **Step 2: 运行确认失败** — Expected: FAIL（当前只转发 leftover，client 收到的 body < 实际）。

- [ ] **Step 3: 流式转发完整 body**

非 101 路径：把 leftover 作为 body 的前缀，然后继续从 upstream 流式读取剩余 body（按 Content-Length 或直到 EOF/chunked 结束），拼成完整 body 返回（或流式转给 client）。不要只用 leftover。

```rust
// Pseudocode: build the response body = leftover ++ remaining upstream body (by Content-Length / chunked / until EOF)
let mut body = leftover_bytes;
// read remaining bytes from upstream until Content-Length satisfied or EOF
// ... then construct the response with the full body
```

> Worker：核对非 101 路径如何构造返回给 client 的响应（`Full<Bytes>`? 流?），以及 upstream stream 的可读性。优先按 Content-Length 读完；无 Content-Length 时读到 EOF。

- [ ] **Step 4: 运行确认通过** — `cargo test -p aiproxy-proxy-core` PASS（含新测试 + `ws_upgrade_non_101_response_no_registry_no_duplicate_session`）。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(ws): forward full body on non-101 upgrade response, not just leftover (M7)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 3 收尾验证

- [ ] `cargo test -p aiproxy-rule-engine`
- [ ] `cargo test -p aiproxy-db`
- [ ] `cargo test -p aiproxy-proxy-core`
- [ ] `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`（M5 改了 main.rs）
- [ ] 更新 `docs/BUG_AUDIT_2026-06-27.md`：M1/M2/M3/M5/M6/M7 标题加 `✅ 已修复（<commit>）`，状态行推进。
