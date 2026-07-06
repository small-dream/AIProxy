# ADR-005 Mutex Poison 处理策略

## 状态

Accepted

## 背景

ADR-004 把 panic 策略从 `panic = "abort"` 改回默认 unwinding,使 `Drop` guard 与 `RunEvent::Exit` 的系统代理还原逻辑能在 panic 后运行。但 unwinding 一旦恢复,`std::sync::Mutex` 的 poison 就变成**可达**状态:任何线程在持锁期间 panic,该锁即被标记为 poisoned,后续 `.lock()` 返回 `Err(PoisonError<MutexGuard>)`。

第四轮代码评审(`docs/CODE_REVIEW_2026-07-04.md` A4)发现项目存在**多套并存的 poison 处理策略**,且边界不清:

- `bootstrap/mod.rs`(`AppState` 字段):`unwrap_or_else(|e| e.into_inner())` — 静默恢复(fail-open)
- `bootstrap/repository.rs`(DB 连接):`unwrap_or_else(|e| e.into_inner())` — 静默恢复(fail-open)
- `commands/*.rs`(IPC handler 的 DB 访问):`map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))` — fail-closed,返回结构化错误给前端
- `bootstrap/cache.rs`(13 处)、`workspace.rs`(6 处):`.expect("...should not be poisoned")` — 中毒即 panic

矛盾点:

1. **同一把 `Arc<Mutex<rusqlite::Connection>>` 有两套策略** — `Repository` 内部与 WS collector 用 fail-open 静默恢复,而 IPC 命令用 fail-closed 返回错误。在 A8 unwinding 下,一次 panic 后 session 持久化路径会继续复用可能撕裂的 Connection,而用户写操作却拒绝它,行为不一致(评审 High 发现)。
2. **`cache.rs` / `workspace.rs` 的 expect 会在 unwinding 期间二次 panic** — ADR-004 §后续审计事项明确点名要迁移这批 expect,M16 批次迁移了 `bootstrap/mod.rs` 但**遗漏了同目录的 `cache.rs` 与 `workspace.rs`**。
3. **静默恢复完全无诊断信号** — fail-open 路径的 `unwrap_or_else(|e| e.into_inner())` 既不 panic 也不打日志,后续排查「为什么缓存/工作区状态不一致?」无任何 trace(评审 Medium 发现)。

## 决策

采用**按锁的语义分层的统一策略**,所有 poison 处理经集中化 helper 模块(`apps/desktop/src-tauri/src/bootstrap/lock_recovery.rs`)进行:

### 策略 A:DB 连接锁写路径 = fail-closed(全部)

**所有写用户数据的 DB 路径,无论是否有 `Result` 通道,poison 时一律 fail-closed。** 中毒的 `rusqlite::Connection` 可能语句缓存/事务状态撕裂,通过它继续写入会损坏用户数据。分两种表现:

- **IPC 命令路径**(`commands/*.rs` 40 处,经 `AppState::lock_db_for_ipc()` 或自由函数 `lock_recovery::lock_db_for_ipc(&arc)`):poison 时返回结构化 IPC 错误 `{"code":"DB_POISONED","message":"database is unavailable due to a prior panic; please restart the app"}`,前端可提示重启。
- **后台/启动写路径**(`repository.rs` 的 `clear_all_sessions`/`delete_sessions_by_ids`/`upsert_session_rows`/`persist_session_full`/`persist_session_batch_full`/`delete_sessions_impl`、`main.rs` 启动 seed、`commands/proxy.rs` WS collector — 共 8 处,经 `Repository::lock_best_effort(category)` 或 `lock_recovery::lock_db_best_effort(&arc, cat)`):poison 时返回 `Err(())` 并打 `tracing::error!`(事件 `db_poison_skipped_write`),调用方**跳过本次写入/删除**,数据留待重启后重新持久化或清理。

> 为何后台写路径也 fail-closed 而非 fail-open? 早期版本曾把后台路径统一到 fail-open(理由是"fire-and-forget,恢复即可"),但评审指出:这些路径(session 异步持久化、WS 消息入库、session 删除)**都在写/删用户数据**,通过撕裂的 Connection 写入正是 fail-closed 要防的数据完整性风险。代价是 poison 后这些后台写入丢失直到重启——但 session 持久化是追加式(upsert)、WS 消息是可丢失的采集数据、删除可重试,**丢失一次写入远好于写入损坏数据**。

### 策略 A':DB 连接锁读路径 — IPC 读 fail-closed,内部读 fail-open

读撕裂的 Connection 最多返回垃圾行,无数据完整性风险。但**一致性**要求:凡 IPC 可达的读路径,与其他 IPC DB 命令一样 fail-closed(返回 `DB_POISONED`),避免「同一把锁上部分 IPC 命令拒绝、部分静默复用」的割裂。

- **IPC 可达读路径**(`get_session_detail`/`get_session_detail_content`/`save_session_to_collection` 经 `AppState::read_session_detail` → `Repository::load_session_detail_for_ipc`/`load_session_summary_for_ipc`):**fail-closed**,poison 时返回 `DB_POISONED`。`read_session_detail` 因此返回 `Result<Option<ProxySessionDetail>, String>`,IPC 命令用 `?` 透传 poison 错误,`None` 仍走既有「session not found」分支。
- **内部/启动读路径**(`bootstrap/mod.rs` 的 `init_from_db` 启动加载、`repository.rs` 的 `load_session_detail_row`/`load_session_summary_row` 两个 `#[allow(dead_code)]` raw-Result 访问器):**fail-open + log**,经 `Repository::lock_or_recover(category)` 或 `lock_recovery::lock_db_or_recover(&arc, cat)`。这些不经 IPC,无一致性约束。

> 关键约束:`lock_or_recover` 仅供**内部/非 IPC 读路径**使用。`Repository::lock_or_recover` 与 `lock_recovery::lock_db_or_recover` 的文档明确标注 "read-only, non-IPC",写路径必须用 `lock_best_effort` / `lock_db_best_effort`,IPC 读必须用 `lock_for_ipc`。

### 策略 B:可重建的 in-memory 状态 = fail-open + log

- `bootstrap/cache.rs`(13 处 `SessionCache` summaries/details LRU)、`workspace.rs`(6 处 `WorkspaceManager`):poison 时经 `recover_guard(poison, category)` 恢复 guard 并打日志。理由:这些状态可从 DB 重建(下一次刷新即正确),且 unwinding 期间不能 panic(否则中止 unwinding,系统代理还原 Drop guard 不运行 — ADR-004 的核心安全目标)。
- `bootstrap/mod.rs` 的其他 `AppState` 字段(runtime/status/system_proxy_snapshot/tls_manager/...):已是 `unwrap_or_else(|e| e.into_inner())` 静默恢复,**保持不变**(它们是协调态,与 ADR-004 §后续审计已完成的迁移一致)。这些字段不在本次统一范围内,因为它们彼此策略一致(全 fail-open),不构成 A4 的「两套策略」矛盾。

### 集中化实现

所有 poison 处理经 `bootstrap/lock_recovery.rs`:

- `recover_guard(poison, category)` — fail-open 恢复 + 结构化 `tracing::error!`(事件 `mutex_poison_recovered`,带 `mutex_category` 字段定位具体锁)。供 in-memory 锁用。
- `lock_db_for_ipc(&Arc<Mutex<Connection>>)` — DB 路径 fail-closed(IPC 写 **与 IPC 读**),返回 `DB_POISONED` IPC 错误。
- `lock_db_best_effort(&Arc<Mutex<Connection>>, category)` — DB 写路径 fail-closed(后台),返回 `Result<Guard, ()>`,poison 时打 `db_poison_skipped_write` 日志,调用方跳过写入。**不调用 `into_inner()`**,丢弃 guard 使中毒 Connection 不被复用。
- `lock_db_or_recover(&Arc<Mutex<Connection>>, category)` — DB **内部/非 IPC 读路径** fail-open + log。
- `Repository::lock_for_ipc()` / `lock_best_effort(category)` / `lock_or_recover(category)` — Repository 上的便捷代理(分别对应 IPC 读+写、后台写、内部读)。
- `AppState::lock_db_for_ipc()` — IPC 命令文件的便捷代理(模式 1:`app_state.lock_db_for_ipc()?`)。

`category` 字符串(如 `"session_cache.summaries"`、`"workspace_list"`、`"session_persist_full"`、`"ws_collector"`、`"startup_load"`、`"session_delete_impl"`)在日志中标识具体锁/路径,满足评审 Medium「diagnosable」要求。

### 新增错误码

`commands/common.rs` 新增 `ERR_DB_POISONED = "DB_POISONED"`,前端 `coerceAppError` 无需改动(已能消费任意 code 字符串)。前端可针对此 code 加「建议重启」提示(留作 follow-up,本次只做后端)。

## 范围边界

**本 ADR 范围**:desktop app(`apps/desktop/src-tauri`)的 DB 连接锁 + in-memory 缓存锁。

**不在范围**:`crates/proxy-core`、`crates/rule-engine`、`crates/tls-manager` 内部的 ~59 处 `unwrap_or_else(|e| e.into_inner())`。理由:

1. 这些是项目既有惯例(全 fail-open,彼此一致,不构成「两套策略」矛盾);
2. 它们都是 proxy-core 内部的 in-memory 规则管理器 / WS registry / TLS 缓存,语义上属于「可重建的 in-memory 状态」,与策略 B 同类;
3. 跨 crate 复用 `recover_guard` 需要把 helper 下沉到 `sys-util` crate,改造范围大且收益边际(这 59 处静默恢复本就符合本 ADR 的策略 B 语义,只是无日志)。

如未来需要为这些 crate 加日志诊断,可另起一个把 `recover_guard` 下沉到 `sys-util` 的迁移(独立工作项)。

## 验证

- `cargo test -p aiproxy-desktop`:测试通过(含新增 lock_recovery 单测:recover_guard 正常恢复、真实 panic 后恢复、lock_db_for_ipc fail-closed 返回 DB_POISONED、lock_db_for_ipc 未中毒时成功、lock_db_best_effort poison 时返回 Err 并跳过、lock_db_best_effort 未中毒时成功)。
- 全树 grep 确认:`.expect(".*poisoned")` 在 `apps/`/`crates/` 下 0 匹配;`"db mutex poisoned"` 旧文案在 `commands/` 下 0 匹配;`db.lock().unwrap_or_else(|e| e.into_inner())`(DB 连接锁的静默恢复)在 `apps/desktop/src-tauri/src` 下 0 匹配。

## 修订历史

- **v2**(评审 High/Medium follow-up):修正策略——DB 写路径统一 fail-closed(后台写路径经 `lock_db_best_effort` 跳过写入,而非 fail-open 恢复后继续写)。原 v1 错误地把 session 持久化/删除/WS 入库等写路径归为"fire-and-forget 可恢复",忽视它们都在写用户数据,通过撕裂 Connection 写入正是 fail-closed 要防的风险。同时补齐 v1 遗漏的 3 处静默 `db.lock().unwrap_or_else`(Medium)。
- **v3**(评审第二轮 High follow-up):修正策略——IPC 可达的 **读**路径(`get_session_detail`/`get_session_detail_content`/`save_session_to_collection` 经 `read_session_detail`)也 fail-closed。v2 误把它们归为"内部读 fail-open",但实际上 `load_session_detail_or_log`/`load_session_summary_or_log` 唯一调用方就是 IPC 驱动的 `read_session_detail`,并无独立内部读路径。新增 `load_session_detail_for_ipc`/`load_session_summary_for_ipc`(fail-closed),`read_session_detail` 改返回 `Result<Option<...>, String>`,删除孤立的 `_or_log` 方法。仅 `init_from_db`(启动)与两个 dead-code raw 访问器保留 fail-open。

## 后续审计事项

- 若 `mutex_poison_recovered` / `db_poison_skipped_write` 日志噪音过大,考虑加 rate-limit(每 mutex 每 N 秒打一次)。当前评估:poison 是罕见事件(需先 panic 持锁),不必预防性去重。
- 前端可针对 `DB_POISONED` code 加显式「数据库不可用,请重启应用」提示(follow-up)。
- 若 reviewer 后续要求把 proxy-core/rule-engine/tls-manager 的 59 处静默 into_inner 也纳入日志,把 `recover_guard` 下沉到 `sys-util` crate 后统一迁移。

## 关联

- 派生自 ADR-004(unwinding 使 poison 可达)。
- 闭合评审 `docs/CODE_REVIEW_2026-07-04.md` A4。
- 实现:`apps/desktop/src-tauri/src/bootstrap/lock_recovery.rs` + 跨多文件的调用点迁移(IPC 写 40、后台写 8、DB 读 5、in-memory 19)。
