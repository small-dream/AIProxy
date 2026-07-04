# ADR-004 Panic 策略与系统代理崩溃还原

## 状态

Accepted

## 背景

AIProxy 在用户启用「系统代理」后会接管操作系统的 HTTP/HTTPS 代理设置（Windows 注册表 `ProxyEnable`/`ProxyServer`、macOS `networksetup`、Linux `gsettings`）。应用退出或崩溃时必须把这些设置还原为接管前的快照，否则用户整机 HTTP 流量会指向一个已经死掉的 AIProxy 端口（流量黑洞，需手工修注册表/网络配置）。

第四轮代码评审（`docs/CODE_REVIEW_2026-07-04.md` A8）发现：

- release profile 设置 `panic = "abort"`（`Cargo.toml`）；
- 任何线程 panic → 进程立即 abort，无 unwinding；
- 系统代理还原逻辑挂在 `RunEvent::Exit`（`main.rs`）与 `Drop` guard 上，依赖 unwinding 才能运行；
- 因此 panic 后还原逻辑**根本不运行**，系统代理永久指向死端口；
- `dev_logger.rs` 装的 panic hook 在 `panic = "abort"` 下执行后仍 abort，不能用于运行还原逻辑（不可作强保证）；
- 既有 `system_proxy_recovery.rs` 的「持久化 pre-apply 快照 + 下次启动还原」机制确实存在，但 `persist_pending_snapshot` 用非原子 `fs::write`（L8），崩溃/掉电期间可留半写文件，使下次启动还原也失败。

评审结论：仅修 L8 原子写不足以闭合 A8——原子写只解决快照文件损坏，不解决 abort 后还原逻辑不可运行。

## 决策

**采用方案 A：移除 release `panic = "abort"`，恢复默认 unwinding。**

理由：

1. **崩溃时即时还原**。Unwinding 让 `Drop` guard 与 `RunEvent::Exit` 的 `restore_system_proxy` 在 panic 后仍能运行，系统代理可被即时还原，而非等到下次启动。这是端用户工具的信任底线。
2. **二进制体积收益可忽略**。`strip = "symbols"` 已移除符号；unwinding 相对 abort 的体积增量在桌面应用场景可忽略（KB 级）。
3. **与既有防御代码一致**。仓库内 `bootstrap/mod.rs` 大量 `.expect("...should not be poisoned")`、`repository.rs` 的 `.unwrap_or_else(|e| e.into_inner())` 都是按 unwinding 语义写的；`panic = "abort"` 下这些是死代码或掩盖逻辑。
4. **panic hook 仍保留**。`dev_logger.rs` 的 panic hook 继续用于日志记录（unwinding 下也能正常工作）。

配套实现：

- 移除 `Cargo.toml` `[profile.release]` 的 `panic = "abort"`（保留 `lto`/`codegen-units`/`strip`）。
- **L8 原子写**：`system_proxy_recovery.rs::persist_pending_snapshot` 改用 `write_atomic`（temp 文件 + `fs::rename`，POSIX 原子，Windows 用 `MoveFileExW` 带 `MOVEFILE_REPLACE_EXISTING`）。这是 unwinding 之外的二保险——即使进程被 `SIGKILL`/任务管理器强杀（unwinding 也救不了），下次启动仍能读到完整快照还原。
- **落盘顺序**：`enable_system_proxy_impl`（`proxy.rs`）保持「persist snapshot → apply system proxy」顺序（已核实当前是此顺序），确保 panic 发生在 apply 期间时快照已落盘。

## 后续审计事项（M16 协同）

取消 `panic = "abort"` 后，unwinding 期间 `Drop` 会运行。需审计：

- shutdown 路径的 `.expect("...should not be poisoned")`（`bootstrap/mod.rs` ~12 处）——这些在 unwinding 期间若触发二次 panic 会中止 unwinding。M16 计划把它们改 `.unwrap_or_else(|e| e.into_inner())`（对齐 `repository.rs` 既有模式）。
- 其他 `unwrap`/`expect` 在 unwinding 下的二次 panic 风险——在 M16 批次统一审计。

## 备选方案（未采纳）

**方案 B：保留 `panic = "abort"`，明确「下次启动恢复」产品语义。** 不采纳理由：崩溃后系统代理会**短暂**指向死端口（直到用户下次启动 AIProxy），对依赖网络的用户是不可接受的体验；且 panic=abort 下 panic hook 内的还原是 best-effort，不能作强保证。

## 验证

- 单元：构造 snapshot 写入，模拟 kill 进程后重启，`restore_pending_snapshot_on_startup` 能读未损坏文件并还原（原子写保证）。
- 集成：debug 构造故意 panic 注入 apply 后路径，验证 unwinding 触发 `Drop`/`Exit` 还原。
- 顺序：断言 persist 发生在 apply 之前。
