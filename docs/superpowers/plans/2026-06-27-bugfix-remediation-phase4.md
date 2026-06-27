# Bug 审计修复计划 — Phase 4（前端列表 / 状态机 / 中危）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 修复 BUG_AUDIT_2026-06-27.md Phase 4 共 4 个前端中危问题（M9/M10/M11/M12），消除列表 key 错位、选中态丢失、弹窗状态不同步、死代码静默失效。

**Architecture:** 每个修复用 TDD（vitest + @testing-library/react）。复用 Phase 1 建立的前端测试模式（`use-throttle-editor.test.tsx` 的 mock + renderHook/render 模式、QueryClientProvider wrapper）。

**Tech Stack:** React 19 + TypeScript + Vitest + @testing-library/react + TanStack Query。测试 `pnpm --filter @aiproxy/desktop test|typecheck|lint`。

## Global Constraints

（CLAUDE.md）代码注释英文；用户可见 UI 文案双语（同步 en.ts/zh-CN.ts，本批无新文案）；不留空 catch；错误带上下文；每 task 一次提交（英文 conventional commit + `Co-Authored-By: Claude <noreply@anthropic.com>`）；继续在 `fix/bug-audit-remediation` 分支累积。

## 侦察要点（implementer 执行时核对真实代码）

- `apps/desktop/src/features/compose/components/EditableKeyValueTable.tsx`、`apps/desktop/src/features/rules/components/RewriteRulesPanel.tsx`：编辑类表格用 `key={index}`。
- `apps/desktop/src/features/rules/components/MapRulesPanel.tsx`、`ScriptRulesPanel.tsx`：自动选择 effect 缺 `draft.id === selectedRuleId` 兜底（对比 `RewriteRulesPanel.tsx:332-348` 有兜底）。
- `apps/desktop/src/features/collections/components/SaveToCollectionDialog.tsx:40`：`name` 仅由 `sessionName` 初始化一次。
- `apps/desktop/src/services/events/index.ts:16-18`：`subscribeToProxyStatus` 空实现，测试 `SessionInspectorMessagesPane.stress.test.tsx:45` 在 mock 它。

---

## Task 1: M12 — 处理 `subscribeToProxyStatus` 空实现

**Files:**
- Modify: `apps/desktop/src/services/events/index.ts:16-18`（删除或实现）
- Modify: 任何 mock/调用方（`SessionInspectorMessagesPane.stress.test.tsx` 等）
- Test: 视方案

**Bug:** `subscribeToProxyStatus` 直接 `return () => undefined`，从不监听；任何调用方 callback 永不触发（静默失效）。当前无真实调用方，但被测试 mock。

**设计决策：** 先确认有无真实调用方（grep `subscribeToProxyStatus`）。
- 若无真实调用方：删除该函数 + 移除测试里的 mock（死代码清理）。
- 若有/或后端有 `proxy-status` 事件：实现真正的 `listen("proxy-status", cb)`。

- [ ] **Step 1: 调查** — grep `subscribeToProxyStatus` 全仓 + 确认后端是否 emit `proxy-status` 事件（grep `proxy-status` / `emit.*proxy` in src-tauri）。
- [ ] **Step 2: 写测试/确认行为** — 若删除：更新 stress 测试不再 mock 它；若实现：写一个 listen 测试。
- [ ] **Step 3: 实现删除或真正实现**。
- [ ] **Step 4: typecheck + lint + 相关 test 通过**。
- [ ] **Step 5: 提交** `fix(events): remove dead subscribeToProxyStatus stub (M12)` 或 `fix(events): implement subscribeToProxyStatus (M12)`。

---

## Task 2: M11 — SaveToCollection 弹窗 name 随会话切换更新

**Files:**
- Modify: `apps/desktop/src/features/collections/components/SaveToCollectionDialog.tsx:40`
- Test: Create or extend `SaveToCollectionDialog.test.tsx`

**Bug:** `name` 状态仅由 `sessionName` 初始化一次（`useState(sessionName)`）；弹窗常驻挂载（`open` 控制显隐）。给会话 A 打开→取消→给 B 打开，输入框仍是 A 的名字，保存时把 B 存成 A 的名字。

**修复方向：** 用 `useEffect` 在 `sessionName` 变化（或 `open` 由 false→true）时同步 `setName(sessionName)`。

- [ ] **Step 1: 写失败测试** — render 弹窗 with sessionName="A"，取消/关闭；rerender with sessionName="B" 重新打开；断言输入框值为 "B"（当前为 "A"）。Mock 依赖（query/mutation）。组件可能依赖 Dialog/MUI，参考 Phase 1 Task 4 的 MUI-Dialog-jsdom 限制处理。
- [ ] **Step 2: 运行确认 RED**（当前 name 不更新）。
- [ ] **Step 3: 加 effect 同步** — `useEffect(() => setName(sessionName ?? ""), [sessionName, open])`（或按实际 prop）。
- [ ] **Step 4: typecheck + lint + test 通过**。
- [ ] **Step 5: 提交** `fix(collections): sync SaveToCollection name when session changes (M11)`。

---

## Task 3: M10 — Map/Script 规则新建后选中态兜底

**Files:**
- Modify: `apps/desktop/src/features/rules/components/MapRulesPanel.tsx:64-75`
- Modify: `apps/desktop/src/features/rules/components/ScriptRulesPanel.tsx:92-103`
- Test: 扩展或新建面板测试

**Bug:** 自动选择 effect（`if (!rules.some(r => r.id === selectedRuleId)) setSelectedRuleId(undefined)`）缺 `|| draft.id === selectedRuleId` 兜底。点"创建规则"后新 draft 不在 rules 中 → effect 立刻清除选中态。`RewriteRulesPanel.tsx:332-348` 已有此兜底。

**修复方向：** 仿 RewriteRulesPanel，把条件改为 `if (!rules.some(...) && draft?.id !== selectedRuleId) setSelectedRuleId(undefined)`（或等价），让新建草稿的选中态保留。

- [ ] **Step 1: 写失败测试**（至少一个面板）— render MapRulesPanel，mock rules query，点"创建规则"，断言新建 draft 的 id 被选中（当前被清除）。
- [ ] **Step 2: 运行确认 RED**。
- [ ] **Step 3: 加兜底** — 两个面板都加 `draft?.id !== selectedRuleId` 兜底。
- [ ] **Step 4: typecheck + lint + test 通过**。
- [ ] **Step 5: 提交** `fix(rules): keep newly-created Map/Script rule selected (M10)`。

---

## Task 4: M9 — 编辑类表格用稳定 id 作 key，修复删行错位

**Files:**
- Modify: `apps/desktop/src/features/compose/components/EditableKeyValueTable.tsx:89-91`（headers/formdata/urlencoded/query）
- Modify: `apps/desktop/src/features/rules/components/RewriteRulesPanel.tsx:1119-1126`（body-rewrite）
- Test: 扩展表格测试

**Bug:** 行用 `key={index}`。删中间行后 index 重排，React 按 index 复用 DOM/input → 删错行、焦点跳走、值串行。

**修复方向:** 给每条 entry 加稳定 id（新建/初始化时 `crypto.randomUUID()`），用该 id 作 key。entry 类型加 `id: string` 字段；提交/保存时若后端不需要 id 则在出口剥离（只取 key/value）。

**注意：** entry 列表是本地编辑态。加 id 是本地改动。需确认 entry 的数据流（初始化入口 + 提交出口），保证 id 不污染后端契约（API_SPEC / shared-types）。若 entry 已有 id 字段则直接用。

- [ ] **Step 1: 写失败测试**（至少 EditableKeyValueTable）— 渲染 3 行 [A,B,C]，删除中间 B，断言剩下 [A,C] 且 A/C 的输入值正确（当前因 key=index 会错位）。用 fireEvent 删除 + 断言剩余行内容。
- [ ] **Step 2: 运行确认 RED**。
- [ ] **Step 3: 加稳定 id + 用 id 作 key** — entry 初始化分配 id；map 时 `key={entry.id}`；提交出口剥离 id（若需要）。
- [ ] **Step 4: typecheck + lint + test 通过**；确认后端契约未污染（提交 payload 不含 id，或后端忽略）。
- [ ] **Step 5: 提交** `fix(ui): use stable ids for editable table rows to fix delete misalignment (M9)`。

---

## Phase 4 收尾验证

- [ ] `pnpm --filter @aiproxy/desktop test`
- [ ] `pnpm --filter @aiproxy/desktop typecheck && pnpm --filter @aiproxy/desktop lint`
- [ ] 更新 `docs/BUG_AUDIT_2026-06-27.md`：M9/M10/M11/M12 标题加 `✅ 已修复（<commit>）`，状态行推进。
