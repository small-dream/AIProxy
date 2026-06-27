# Bug 审计修复计划 — Phase 5（低危）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 修复 BUG_AUDIT_2026-06-27.md Phase 5 共 11 个低危问题（L1-L3, L5-L12），按逻辑分组成 6 个 task。

**Architecture:** 低危多为小改动；同类的合并为一个 task（一个 reviewer gate 覆盖几个相关修复）。每个修复尽量带测试。

**Tech Stack:** Rust + React。`cargo test -p <crate>` / `pnpm --filter @aiproxy/desktop test|typecheck|lint`。

## Global Constraints

代码注释英文；跨平台；不留空 catch；错误带上下文；用户可见文案双语（无新文案）；每 task 一次提交；继续在 `fix/bug-audit-remediation` 分支。

---

## Task 1: 前端输入 UX 三连（L8 + L9 + L11）

**Files:**
- `apps/desktop/src/features/throttling/components/ProfileEditor.tsx:191-198`（L8：`Number(value) || 0` 清空塌成 0）
- `apps/desktop/src/features/breakpoints/components/BreakpointInterceptPanel.tsx:1192-1205`（L9：`Number(mockStatusCode) || 200` 静默吞空值）
- `apps/desktop/src/features/proxy-status/proxy-status.helpers.ts:24,30,37`（L11：`replace("{{port}}", ...)` 只替首个 → `replaceAll`）

**修复：**
- L8：节流数值 TextField 清空时保留空串本地态，blur 时再 clamp/回填，不用 `|| 0`。
- L9：状态码输入空/NaN 时设 `resolveError` 并阻止提交，而非静默回退 200。
- L11：占位符 `replace` → `replaceAll`（或正则 `/\{\{port\}\}/g`）。

- [ ] **Step 1: 写测试**（L11 纯函数最易测：多 `{{port}}` 输入 → 全替换；L8/L9 视组件可测性，至少 L11 + 行为断言）
- [ ] **Step 2: RED**
- [ ] **Step 3: 三处修复**
- [ ] **Step 4: typecheck + lint + test GREEN**
- [ ] **Step 5: 提交** `fix(ui): throttling/breakpoint input UX + replaceAll port placeholder (L8/L9/L11)`

---

## Task 2: 前端空 catch（L10）

**Files:**
- `apps/desktop/src/features/rules/components/ScriptRulesPanel.tsx:143-155`（文件导入 `catch {}` 完全静默）
- 同类：`use-session-context-actions.ts:314,437`（若有相同模式）

**修复：** catch 中 setSnackbar 提示或 dev-logger 上报（违反 CLAUDE.md「不留空 catch」）。

- [ ] 写测试（导入失败 → snackbar/log 出现）/ 修复 / 验证 / 提交 `fix(rules): surface script import errors instead of silent catch (L10)`

---

## Task 3: Rust 解码 / 单位 / 统计（L1 + L2 + L3）

**Files:**
- `crates/proxy-core/src/rules/rewrite.rs:519-543`（L1：response body rewrite 后未删 content-length）
- `crates/proxy-core/src/http_io.rs:471-476`（L2：deflate 用 ZlibDecoder，不兼容 raw deflate）
- `crates/proxy-core/src/rules/managers.rs:250-261`（L3：response stage 不计 matched_requests）

**修复：**
- **L1：先确认下游**——读 `build_hyper_response`（http_proxy.rs）是否重算 content-length（`Full<Bytes>` body hyper 按实际长度发）。若重算则 content-length 残留无害（仅展示元数据不一致，前序审计 L20 已记）；若不重算则删 content-length。**仅在确认下游不重算时才改**，否则跳过（标注"下游重算，残留无害"）。
- **L2：deflate 解码失败回退 raw deflate**（`flate2::Decompress::new(true)` 或先 zlib 后 raw）。
- **L3：response stage 也计 matched_requests**（至少 per 命中一次）。

- [ ] 写测试（L2：raw deflate bytes → 正确解码；L3：response stage 命中 → matched_requests+1；L1 视下游确认）
- [ ] RED / 修复 / 验证 / 提交 `fix(proxy): deflate raw fallback + response-stage matched count + content-length (L1/L2/L3)`

---

## Task 4: Rust DNS 校验（L6）

**Files:**
- `apps/desktop/src-tauri/src/commands/rules.rs:703-733`（`save_dns_mapping` 未校验 `target_ip`）

**修复：** 命令层加 `target_ip.parse::<std::net::IpAddr>()` 校验，非法返回结构化错误（对比 `save_map_rule` 有 `validate_map_rule`）。

- [ ] 写测试（非法 IP → Err）/ 修复 / 验证 / 提交 `fix(rules): validate dns mapping target_ip (L6)`

---

## Task 5: Rust 系统代理 + cleanup（L5 + L12）

**Files:**
- `apps/desktop/src-tauri/src/system_proxy/macos.rs:245-254`（L5：`setproxybypassdomains` 空值传字面量 `"Empty"`）
- `apps/desktop/src-tauri/src/main.rs:261-266`（L12：cleanup 在 `ExitRequested` 跑重 IO）

**修复：**
- **L5：** 查 `networksetup -setproxybypassdomains` 清空 bypass 的正确方式（空串/省略/`""`），不用 `"Empty"` 字面量。
- **L12：** cleanup（`shutdown_proxy_runtime` + `restore_system_proxy`）移到 `RunEvent::Exit`（真正退出前），`ExitRequested` 仅轻量预处理，避免 GUI 卡死。

- [ ] 写测试（视可测性；L12 难单测，靠代码 + 逻辑）/ 修复 / 验证 / 提交 `fix(system): correct macos bypass clear + move cleanup to Exit (L5/L12)`

---

## Task 6: Rust db 路径跨平台（L7）

**Files:**
- `crates/db/src/body_store.rs:86-98`（`checked_resolve_body_path` Unix 上不识别 Windows 风格路径穿越）

**修复：** `checked_resolve_body_path` 额外拒绝含 `\` 的 `relative_path`，跨平台一致（Windows 上 `Path::components` 已处理 `\`，Unix 上需显式拒）。

- [ ] 写测试（含 `\` 的 relative_path → 拒绝）/ 修复 / 验证 / 提交 `fix(db): reject backslash in body path resolution for cross-platform safety (L7)`

---

## Phase 5 收尾验证

- [ ] `cargo test --workspace`（确认无交叉；pre-existing proptest 失败预期）
- [ ] `pnpm --filter @aiproxy/desktop test && typecheck && lint`
- [ ] 更新 `docs/BUG_AUDIT_2026-06-27.md`：L1-L3/L5-L12 标题加 `✅ 已修复（<commit>）`（L1 若下游重算则标注"残留无害，未改"），状态行推进。
