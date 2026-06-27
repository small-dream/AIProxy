# Bug 审计修复计划 — Phase 2（Rust 网络层：超时 / 泄漏 / 协议）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 修复 BUG_AUDIT_2026-06-27.md Phase 2 共 8 个网络层问题（H3/H4/H5/H6/H7/H9/H10/M4），消除无超时导致的永久挂起/资源耗尽与协议正确性缺陷。

**Architecture:** 每个修复用 TDD：先写失败/行为测试，再改最小实现。proxy-core 已有成熟测试基础设施（`override_upstream_request_timeout_for_test`、`TcpListener` mock 上游、`send_ws_upgrade_via_proxy`、502 先例 `ws_upgrade_upstream_connect_failure_emits_502_not_499`），尽量复用。任务按「先易后难、先独立」排序，让早期 task 建立的模式被后续复用。

**Tech Stack:** Rust 2021 / tokio / hyper / rusqlite。测试 `cargo test -p aiproxy-proxy-core` / `cargo test -p aiproxy-db`。

## Global Constraints

（CLAUDE.md，所有 task 隐含遵守）
- 代码注释用英文；跨平台（Windows/macOS/Linux）处理或 fallback；不留空 catch；错误带上下文。
- 关键链路补结构化日志（tracing event），不要静默失败。
- 超时值：优先复用现有 `upstream_request_timeout()` / `CLIENT_HEADER_READ_TIMEOUT` 等常量；新增超时常量需命名清晰且可配置（参考既有 `_for_test` override 模式）。
- 提交：每 task 一次，英文 conventional commit，结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 分支：继续在 `fix/bug-audit-remediation` 上累积。

## 关键测试基础设施（侦察确认，所有 task 复用）

- `crates/proxy-core/src/tests.rs`：`TcpListener::bind(("127.0.0.1",0))` + `tokio::spawn` 模拟上游；`override_upstream_request_timeout_for_test(Duration)`；`timeout(Duration, session_future)` 等待；`start_proxy_server`/`allocate_unused_port`；`send_ws_upgrade_via_proxy`；`read_http_response_head`；502 先例 `ws_upgrade_upstream_connect_failure_emits_502_not_499`（:1679）；超时先例 `plain_http_upstream_timeout_emits_a_completed_gateway_timeout_session`（:1278）。
- `crates/proxy-core/src/ws.rs`：`parse_ws_frame` 可用 `std::io::Cursor` 纯单测；先例 `write_and_parse_frame_small`（:614）。
- `crates/proxy-core/src/breakpoints.rs`：`cancel_all_sends_forward_resolution`（:709）、`cancel_for_rules_only_targets_matching_rules`（:731）。
- `crates/db/src/sessions.rs`：`test_conn()`（in-memory SQLite）；`delete_by_ids`（:655）；proptest 模式见 body_store.rs。

---

## Task 1: H7 — `delete_sessions_by_ids` 分批，避免 SQLite 变量上限

**Files:**
- Modify: `crates/db/src/sessions.rs:294-380`（`delete_sessions_by_ids`）
- Test: `crates/db/src/sessions.rs` `mod tests`（`delete_by_ids` 附近，:655）

**Bug:** 整个 ID 列表构造 `?1..?N` 占位符，超过 `SQLITE_LIMIT_VARIABLE_NUMBER`（999/32766）即 prepare 失败、事务回滚；后台清理（`bootstrap/mod.rs:273`）失败被 `eprintln!` 吞掉，旧 session 永删不掉、DB 膨胀。

**Interfaces:** `delete_sessions_by_ids` 签名不变（`&Connection, &[String]` → `Result<usize, DbError>`）。

- [ ] **Step 1: 写失败测试**（新增到 sessions.rs `mod tests`）

```rust
    #[test]
    fn delete_sessions_by_ids_handles_more_than_variable_limit() {
        let conn = test_conn();
        // Insert enough rows to exceed SQLITE_LIMIT_VARIABLE_NUMBER on any
        // SQLite version (default 999, newer 32766). 5000 sits above 999 and
        // stays well under memory limits for an in-memory db.
        let ids: Vec<String> = (0..5000).map(|i| format!("bulk-{i}")).collect();
        for id in &ids {
            upsert_session(&conn, &test_summary(id, "example.com"), &test_detail(id))
                .unwrap();
        }
        let deleted = delete_sessions_by_ids(&conn, &ids).expect("batched delete succeeds");
        assert_eq!(deleted, ids.len());
        // Confirm they are actually gone.
        for id in &ids {
            assert!(
                load_session_summary(&conn, id).unwrap().is_none(),
                "session {id} should be deleted"
            );
        }
    }
```

> Worker：核对 `test_summary`/`test_detail`/`upsert_session`/`load_session_summary` 的真实签名与 `delete_by_ids`（:655）测试的构造方式，对齐字段。若 helper 名不同，用现有同名 helper。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p aiproxy-db delete_sessions_by_ids_handles_more_than_variable_limit`
Expected: FAIL（当前实现整批 prepare，5000 > 变量上限 → query error）。

- [ ] **Step 3: 实现分批**

把单次 prepare+execute 改为按固定批大小（如 500，远低于 999）循环，每批独立事务或整体一个事务分批 execute。保留返回总删除数。示例：

```rust
const DELETE_BATCH_SIZE: usize = 500;

pub fn delete_sessions_by_ids(conn: &Connection, ids: &[String]) -> Result<usize, DbError> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut total = 0usize;
    for chunk in ids.chunks(DELETE_BATCH_SIZE) {
        // build ?1..?N for this chunk only, bind, execute — same statements
        // as today but scoped to chunk.len() (<=500).
        total += /* existing per-statement logic applied to chunk */;
    }
    Ok(total)
}
```

> 保持每条 DELETE 语句的占位符数 = `chunk.len()`，不复用跨批占位符。若原实现把同一组占位符用于多条 DELETE，改为每批重建。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p aiproxy-db` — Expected: PASS（含新测试 + 既有 `delete_by_ids`）。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(db): batch delete_sessions_by_ids to stay under SQLite variable limit (H7)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: H10 — `parse_ws_frame` 区分 EOF 与协议错误，relay 回 Close(1002)

**Files:**
- Modify: `crates/proxy-core/src/ws.rs:477/505`（relay 的 `.ok()` 处理）+ `parse_ws_frame` 错误类型（确认区分）
- Test: `crates/proxy-core/src/ws.rs` `mod tests`（`write_and_parse_frame_small` 附近，:614）

**Bug:** `parse_ws_frame(...).await.ok()` 把协议错误（reserved opcode / 超长 payload / 控制帧分片）一律当 EOF 静默结束，RFC 6455 要求回 Close(1002)。

**Interfaces:** 无新公开 API；relay 内部区分错误。

- [ ] **Step 1: 写单测**（确认 `parse_ws_frame` 对 EOF 与协议错误返回可区分的 Err）

```rust
    #[tokio::test]
    async fn parse_ws_frame_eof_is_clean_close() {
        // Empty stream → EOF, not a protocol violation.
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        let result = parse_ws_frame(&mut cursor).await;
        assert!(result.is_err(), "EOF must surface as Err so relay can treat it as clean close");
        // Confirm the error variant the implementation uses for EOF (document it).
    }

    #[tokio::test]
    async fn parse_ws_frame_reserved_opcode_is_protocol_error() {
        // Reserved opcode (RSV bit set without extension) must be a protocol
        // error, distinguishable from EOF, so the relay can answer Close(1002).
        let mut cursor = std::io::test::TestStream::new(); // or Cursor with a crafted frame
        // Craft a frame with FIN=1, RSV1=1, opcode 0x01 → reserved bit set.
        let mut bytes = vec![0b1100_0001u8, 0x00];
        let mut cursor = std::io::Cursor::new(bytes);
        let result = parse_ws_frame(&mut cursor).await;
        assert!(result.is_err());
        // Assert the error is the protocol-error variant, not the EOF variant.
    }
```

> Worker：核对 `parse_ws_frame` 现有的错误变体（`ProxyError::*`），确认 EOF（UnexpectedEof）与协议错误（如 reserved opcode / oversized）落在**不同变体**。若已区分，测试锁定该不变量；若都归为同一变体，先让 `parse_ws_frame` 区分（这是 H10 的前置）。

- [ ] **Step 2: 运行确认状态**

Run: `cargo test -p aiproxy-proxy-core parse_ws_frame`
Expected: 若 `parse_ws_frame` 已区分 → 测试可能直接绿（锁定）；若未区分 → RED。

- [ ] **Step 3: 改 relay 区分 EOF vs 协议错误**

把 `ws.rs:477/505` 的 `.ok()` 改为保留 Err：EOF（UnexpectedEof）→ 标记 done 正常结束；其他协议错误 → 向对端写一个 Close(1002) 帧再结束。复用现有 `write_ws_frame` / close-code 构造。

```rust
// before: let frame = parse_ws_frame(stream).await.ok();
match parse_ws_frame(stream).await {
    Ok(frame) => { /* existing forward logic */ }
    Err(e) if is_clean_eof(&e) => { done = true; /* normal close */ }
    Err(_protocol_err) => {
        let _ = write_ws_frame(&mut other_stream, &close_frame(1002)).await;
        done = true;
    }
}
```

> `is_clean_eof` 判断 `io::ErrorKind::UnexpectedEof`（或 `parse_ws_frame` 已映射的 EOF 变体）。不要把超时也当协议错误。

- [ ] **Step 4: 运行确认通过 + 集成**

Run: `cargo test -p aiproxy-proxy-core` — Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(ws): answer Close(1002) on protocol error instead of silent drop (H10)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: H6 — 断点 await 加超时 + pending map 在失败/超时时清理

**Files:**
- Modify: `crates/proxy-core/src/breakpoints.rs:534-604`（request/response stage 的 `receiver.await`）+ pending map 清理
- Test: `crates/proxy-core/src/breakpoints.rs` `mod tests`（:709/:731 附近）

**Bug:** `receiver.await` 无超时；前端断连/emitter 失败时永久挂起。`Err(_)` 分支只打 warn 不清理 pending map（泄漏）。

**Interfaces:** 新增可配置断点超时（参考 `override_upstream_request_timeout_for_test` 模式，加 `breakpoint_wait_timeout()` + `_for_test` override）。

- [ ] **Step 1: 写测试**

```rust
    #[tokio::test]
    async fn breakpoint_wait_times_out_and_cleans_pending() {
        override_breakpoint_wait_timeout_for_test(std::time::Duration::from_millis(50));
        let manager = BreakpointManager::new();
        let session_id = "sess-timeout".to_string();
        let receiver = manager.register_pending(session_id.clone(), "rule-a".to_string());

        // No one resolves → must time out, not hang.
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            wait_for_breakpoint_resolution(&receiver), // 或实际封装的等待函数
        ).await;
        assert!(outcome.is_ok(), "must time out within test window, not hang forever");
        // Pending entry must be removed after timeout.
        assert!(manager.pending.lock().unwrap().get(&session_id).is_none());
    }

    #[tokio::test]
    async fn breakpoint_receiver_drop_cleans_pending() {
        let manager = BreakpointManager::new();
        let session_id = "sess-drop".to_string();
        let _receiver = manager.register_pending(session_id.clone(), "rule-a".to_string());
        drop(_receiver); // simulate dropped sender side
        // After the await-path observes the dropped sender, pending must be cleared.
        // (drive the await once or assert via the public cleanup path)
        assert_eventually_removed(&manager, &session_id);
    }
```

> Worker：核对 `BreakpointManager`、`register_pending`、pending map 字段可见性、实际等待封装（`receiver.await` 所在函数）。若 pending map 是私有，测试通过公共 API 触发并断言行为，或加 `#[cfg(test)]` 访问器。`override_breakpoint_wait_timeout_for_test` 仿照 `override_upstream_request_timeout_for_test` 实现。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p aiproxy-proxy-core breakpoint_wait_times_out`
Expected: FAIL（当前无超时 → 测试 2s 超时窗口内 receiver 永挂，或 pending 未清理）。

- [ ] **Step 3: 实现超时 + 清理**

在 `receiver.await` 外套 `tokio::time::timeout(breakpoint_wait_timeout(), receiver)`。超时或 `Err(_)`（sender dropped）时：从 pending map 移除该 session_id，按 Forward 放行（不阻塞请求），打 structured warn 日志。

```rust
match tokio::time::timeout(breakpoint_wait_timeout(), receiver).await {
    Ok(Ok(resolution)) => { /* existing handle resolution */ }
    Ok(Err(_gone)) | Err(_timeout) => {
        bp.pending.lock().remove(&session_id);
        tracing::warn!(event = "breakpoint_wait_failed", %session_id, "breakpoint wait ended without resolution; forwarding");
        Ok(None) // forward without modification
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p aiproxy-proxy-core` — Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(breakpoints): bound breakpoint wait with timeout and clean pending map (H6)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: M4 — CONNECT 盲隧道先连上游成功再发 200，失败发 502

**Files:**
- Modify: `crates/proxy-core/src/connect.rs:18-37`（`tunnel_blind_relay` 调换顺序）
- Test: `crates/proxy-core/src/tests.rs`（参考 `ws_upgrade_upstream_connect_failure_emits_502_not_499` :1679）

**Bug:** 先无条件发 `200 Connection Established` 再 `TcpStream::connect` 上游；上游不可达时客户端拿到「假隧道」后神秘断开，无 502。

- [ ] **Step 1: 写集成测试**

```rust
    #[tokio::test]
    async fn blind_tunnel_returns_502_when_upstream_unreachable() {
        let dead_port = allocate_unused_port(); // nothing listening
        let mut started = start_proxy_server(/* blind-tunnel config: interception off */).await.unwrap();
        let proxy_port = started.port();

        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        client.write_all(format!("CONNECT 127.0.0.1:{dead_port} HTTP/1.1\r\nHost: 127.0.0.1:{dead_port}\r\n\r\n").as_bytes()).await.unwrap();

        let head = read_http_response_head(&mut client).await.unwrap();
        assert!(head.starts_with("HTTP/1.1 502"), "expected 502 on upstream connect failure, got: {head}");
    }
```

> Worker：核对 `start_proxy_server` 如何配置「盲隧道（interception off）」、CONNECT 请求格式、`read_http_response_head` 签名。复用 :1679 测试的 setup 模式。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p aiproxy-proxy-core blind_tunnel_returns_502`
Expected: FAIL（当前先发 200，客户端收到 200 而非 502）。

- [ ] **Step 3: 调换顺序**

`connect.rs:18-37`：先 `TcpStream::connect` 上游；失败时用 `write_plain_text_response`（`http_io.rs:556`）写 502 再返回；成功后才写 `200 Connection Established`，然后 `copy_bidirectional`。

```rust
let mut upstream = match TcpStream::connect((&*connect_host, port)).await {
    Ok(s) => s,
    Err(e) => {
        tracing::warn!(event = "connect_tunnel_upstream_failed", %host, port, error = %e);
        write_plain_text_response(&mut client_stream, 502, "Bad Gateway", &format!("upstream connect failed: {e}")).await.ok();
        return Err(format!("failed to connect to upstream {host}:{port}: {e}"));
    }
};
client_stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.map_err(map_io_error)?;
// then copy_bidirectional as today
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p aiproxy-proxy-core` — Expected: PASS（含新测试 + 既有隧道测试）。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(connect): connect upstream before sending 200, emit 502 on failure (M4)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: H3 — `send_direct_request` / `direct_http_client` 加超时

**Files:**
- Modify: `crates/proxy-core/src/server.rs:22-38`（`direct_http_client` builder）+ `:590-657`（`send_direct_request`）
- Test: `crates/proxy-core/src/tests.rs`（参考 `plain_http_upstream_timeout_emits...` :1278）

**Bug:** reqwest client 无 `connect_timeout`/`timeout`；send/body 读取无 `tokio::time::timeout`；上游挂起时 Compose 命令永久阻塞。

- [ ] **Step 1: 写集成测试**（慢上游 → send_direct_request 在超时内失败/返回错误，不永挂）

```rust
    #[tokio::test]
    async fn direct_request_times_out_on_hanging_upstream() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024]; let _ = s.read(&mut buf).await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await; // hang
        });
        override_upstream_request_timeout_for_test(std::time::Duration::from_millis(200));

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            send_direct_request("GET".into(), format!("http://127.0.0.1:{port}/"), vec![], None),
        ).await;

        upstream.abort();
        // Must resolve within 3s (proving the inner timeout fired), and be an error.
        assert!(result.is_ok(), "send_direct_request must not hang");
        assert!(result.unwrap().is_err());
    }
```

> Worker：核对 `send_direct_request` 签名与是否 `pub`（测试可见性）；若私有，加 `pub(crate)` 或 `#[cfg(test)]` 入口。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p aiproxy-proxy-core direct_request_times_out`
Expected: FAIL/超时（当前无超时，3s 窗口内仍在 hang → `result.is_ok()` 为 false 或整体超时）。

- [ ] **Step 3: 加超时**

`direct_http_client` builder 加 `.connect_timeout(upstream_request_timeout())` 与 `.timeout(upstream_request_timeout())`（或更细粒度）。`send_direct_request` 内用 `tokio::time::timeout(upstream_request_timeout(), request_builder.send())`，body 读取同样包裹；超时返回结构化错误（Gateway Timeout 语义）。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p aiproxy-proxy-core` — Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(proxy): bound send_direct_request with connect/response timeouts (H3)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: H4 — CONNECT 盲隧道 connect + relay 加超时

**Files:**
- Modify: `crates/proxy-core/src/connect.rs:35-52`（`tunnel_blind_relay`，注意 Task 4 已改顺序）
- Test: `crates/proxy-core/src/tests.rs`（参考隧道测试 + 超时先例）

**Bug:** `TcpStream::connect` 无超时；`copy_bidirectional` 无空闲超时；持有 semaphore permit，慢目标可耗尽 1024 配额。

- [ ] **Step 1: 写集成测试**（挂起上游 → 隧道在超时内释放，client 侧收到关闭/错误，permit 归还）

```rust
    #[tokio::test]
    async fn blind_tunnel_idle_upstream_times_out_and_releases_permit() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(30)).await; // accept but never speak
        });
        override_tunnel_idle_timeout_for_test(std::time::Duration::from_millis(200));
        let mut started = start_proxy_server(/* blind tunnel */).await.unwrap();
        let proxy_port = started.port();

        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        client.write_all(format!("CONNECT 127.0.0.1:{upstream_port} HTTP/1.1\r\n\r\n").as_bytes()).await.unwrap();

        // The tunnel must end within the idle window (not hang for 30s).
        let ended = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let mut buf = [0u8; 64];
            let _ = client.read(&mut buf).await;
        }).await;
        upstream.abort();
        assert!(ended.is_ok(), "blind tunnel must time out, not hang");
    }
```

> Worker：新增 `tunnel_idle_timeout()` + `_for_test` override（仿 `upstream_request_timeout`）。connect 超时用单独较短值（如复用 connect timeout 常量）。

- [ ] **Step 2: 运行确认失败** — Expected: FAIL/超时（无 idle 超时 → 永挂）。

- [ ] **Step 3: 实现超时**

`TcpStream::connect` 套 `tokio::time::timeout(connect_timeout, ...)`；`copy_bidirectional` 外层套 idle deadline（每次读到数据重置，或整体 `tokio::time::timeout(tunnel_idle_timeout(), copy_bidirectional(...))`）。超时 → 关闭双方、返回、归还 permit（函数返回即 drop permit）。

- [ ] **Step 4: 运行确认通过** — `cargo test -p aiproxy-proxy-core` PASS。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(connect): bound blind-tunnel connect and idle relay with timeouts (H4)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: H9 — WebSocket relay 收到 Close 后 shutdown 对端 + 总超时

**Files:**
- Modify: `crates/proxy-core/src/ws.rs:484-558`（`relay_websocket_frames`，注意 Task 2 已改错误处理）
- Test: `crates/proxy-core/src/tests.rs`（参考 `send_ws_upgrade_via_proxy` :1606）

**Bug:** 一端发 Close 后只标记自己 done，未 shutdown 对端；退出条件需双端 Close，对不规范/半挂对端死循环、TCP 泄漏。

- [ ] **Step 1: 写集成测试**（上游发 Close 后不回 → relay 在总超时内终止，client 侧连接关闭，registry 转 Closed）

```rust
    #[tokio::test]
    async fn ws_relay_terminates_after_close_without_peer_closeback() {
        // Upstream upgrades, sends Close, then never closes TCP and never
        // echoes a Close back. Relay must still terminate within the WS relay
        // close-grace window, not hang.
        override_ws_close_grace_timeout_for_test(std::time::Duration::from_millis(300));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            // read + respond 101, send one Close frame, then hang (no FIN, no closeback).
            /* ... use existing ws upgrade helper patterns ... */
        });
        let mut started = start_proxy_server(/* mitm on */).await.unwrap();
        let (_resp, _session) = send_ws_upgrade_via_proxy(started.port(), upstream_port, &mut started).await.unwrap();
        // Assert the relay/session reaches a terminal state within the grace window.
        let closed = tokio::time::timeout(std::time::Duration::from_secs(2), wait_for_ws_registry_closed(&started)).await;
        upstream.abort();
        assert!(closed.is_ok(), "ws relay must terminate after Close even without peer closeback");
    }
```

> Worker：核对 WS registry 状态查询方式、`send_ws_upgrade_via_proxy` 返回、是否已有 `wait_for_*` helper；新增 `ws_close_grace_timeout()` + `_for_test`。

- [ ] **Step 2: 运行确认失败** — Expected: FAIL（无 grace 超时 → relay 永等对端 Closeback）。

- [ ] **Step 3: 实现**

收到/转发 Close 后：主动 shutdown 对端写入；给整个 relay 加一个 Close-grace 超时（收到首个 Close 后 `ws_close_grace_timeout()` 内强制退出）。或退出条件改为「任一端 done 即关闭双方」（更激进，需评估是否丢 in-flight 帧——保守起见用 grace 超时）。

- [ ] **Step 4: 运行确认通过** — `cargo test -p aiproxy-proxy-core` PASS。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(ws): terminate relay after Close via peer shutdown + close-grace timeout (H9)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: H5 — h1 conn driver 保留 JoinHandle，超时/失败后 abort

**Files:**
- Modify: `crates/proxy-core/src/upstream.rs:180-182`（h1 conn driver spawn）+ `upstream_pool.rs:206-208`（h2 pool spawn）
- Test: `crates/proxy-core/src/tests.rs`（无现成泄漏检测先例，需新建）

**Bug:** `tokio::spawn(async move { let _ = conn.await; })` 丢弃 JoinHandle；请求超时 drop future 时 driver 不被 abort，持续持有 socket 直到对端 FIN，缓慢耗尽 fd。

**这是 Phase 2 最难的 task**（无现成泄漏测试）。建议策略：
- 优先用「连接计数」可观测性验证：在测试用 runtime 下，发起一次会超时的 h1 请求，超时后断言底层连接被关闭（不再持有）。可用 `tokio::net::TcpListener` 上游 accept 后记录连接，请求超时后断言上游侧收到 FIN（`read` 返 0）。
- 若难以稳定测试，至少加结构化日志 + JoinHandle 保留 + abort，并以 code review + 既有超时测试佐证。

- [ ] **Step 1: 写测试**（上游 accept 后，h1 请求超时 → 上游侧连接被关闭，read 返 0）

```rust
    #[tokio::test]
    async fn h1_upstream_connection_closes_after_request_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let upstream = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let _ = accepted_tx.send(());
            let mut buf = [0u8; 1024]; let _ = s.read(&mut buf).await; // read request
            tokio::time::sleep(std::time::Duration::from_secs(30)).await; // hang → triggers proxy timeout
        });
        override_upstream_request_timeout_for_test(std::time::Duration::from_millis(200));
        let mut started = start_proxy_server(/* h1 path */).await.unwrap();
        // issue a request that will time out
        let _ = /* trigger request via proxy to 127.0.0.1:port */;
        accepted_rx.await.unwrap();

        // After the proxy times out, the upstream-side connection must be closed
        // (driver aborted), observable as the proxy no longer holding it. Assert
        // via connection-count metric or by re-establishing and confirming the
        // old driver task is gone. At minimum: a new request after timeout
        // succeeds (proving the leaked driver isn't wedging the pool).
        upstream.abort();
    }
```

> Worker：这个测试形态需要设计。如果稳定泄漏检测不可行，**报告 DONE_WITH_CONCERNS**：实现 JoinHandle 保留 + 超时 abort（用 `tokio::select!` 或保存 handle 在请求 scope），附 code-review 级证据（日志/既有超时测试），并说明测试局限。不要跳过实现。

- [ ] **Step 2: 运行确认状态** — 视测试设计。

- [ ] **Step 3: 实现 JoinHandle 保留 + abort**

h1 分支：把 conn driver 的 `JoinHandle` 保留到请求 scope（如 `forward_request` 返回前用 `tokio::select!` 在请求 future 与 conn driver 间，或在 drop guard 里 abort）。超时 drop 请求 future 时，guard abort driver。h2 pool（`upstream_pool.rs`）同理评估是否需改。

```rust
let conn_handle = tokio::spawn(async move { let _ = conn.await; });
// ... send_request ...
// on early return / timeout, abort the driver so the socket is released:
// use a guard whose Drop aborts conn_handle, or select! on the send future.
```

- [ ] **Step 4: 运行确认** — `cargo test -p aiproxy-proxy-core` PASS（或 DONE_WITH_CONCERNS + 说明）。

- [ ] **Step 5: 提交**

```bash
git commit -m "fix(upstream): abort h1 conn driver on request timeout to release socket (H5)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 2 收尾验证

- [ ] `cargo test -p aiproxy-db`
- [ ] `cargo test -p aiproxy-proxy-core`
- [ ] `cargo test --workspace`（确认无交叉破坏）
- [ ] 更新 `docs/BUG_AUDIT_2026-06-27.md`：H3/H4/H5/H6/H7/H9/H10/M4 标题加 `✅ 已修复（<commit>）`，状态行推进。
