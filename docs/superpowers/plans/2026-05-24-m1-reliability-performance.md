# M1：可靠性与性能产品化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让现有 P0 功能从"能用"变成"敢长期打开用"——优化前端渲染性能、稳定大 body 与导出、加速 Rust 热路径、建立质量基线。

**Architecture:** 6 个阶段，Phase 1-4 在 Phase 0 完成后可并行。前端用 `@tanstack/react-virtual` 替换手写虚拟滚动，用 `useDebouncedValue` hook 统一防抖。Rust 端迁移至 `tracing` 异步日志、TLS 证书 LRU 淘汰、Session 持久化批量写入。

**Tech Stack:** `@tanstack/react-virtual` v3, Rust `tracing` + `tracing-appender` + `tracing-subscriber`, `lru` crate, Vitest, criterion

**Design Spec:** `docs/superpowers/specs/2026-05-24-m1-reliability-performance-design.md`

---

## Phase 0：共享基础设施

### Task 0.1：安装前端依赖

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: 安装 @tanstack/react-virtual**

Run: `pnpm --filter @aiproxy/desktop add @tanstack/react-virtual`

Expected: dependency added, `pnpm-lock.yaml` updated

- [ ] **Step 2: 验证安装**

Run: `cd /Users/jake/AI/AIProxy && pnpm install`

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "chore: add @tanstack/react-virtual dependency"
```

---

### Task 0.2：创建 useDebouncedValue hook

**Files:**
- Create: `apps/desktop/src/hooks/use-debounced-value.ts`
- Create: `apps/desktop/src/hooks/use-debounced-value.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/hooks/use-debounced-value.test.ts`:

```typescript
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "./use-debounced-value";

describe("useDebouncedValue", () => {
  it("returns initial value immediately", () => {
    const { result } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: "hello" },
    });
    expect(result.current).toBe("hello");
  });

  it("delays updating debounced value", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 150), {
      initialProps: { value: "a" },
    });
    expect(result.current).toBe("a");

    rerender({ value: "ab" });
    expect(result.current).toBe("a");

    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("a");

    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current).toBe("ab");

    vi.useRealTimers();
  });

  it("resets timer on rapid changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 150), {
      initialProps: { value: "a" },
    });

    rerender({ value: "ab" });
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ value: "abc" });
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("a");

    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current).toBe("abc");

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aiproxy/desktop test -- --run src/hooks/use-debounced-value.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 hook**

`apps/desktop/src/hooks/use-debounced-value.ts`:

```typescript
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number = 150): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debouncedValue;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aiproxy/desktop test -- --run src/hooks/use-debounced-value.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/hooks/use-debounced-value.ts apps/desktop/src/hooks/use-debounced-value.test.ts
git commit -m "feat: add useDebouncedValue hook"
```

---

### Task 0.3：添加 Rust 依赖

**Files:**
- Modify: `crates/proxy-core/Cargo.toml`
- Modify: `crates/tls-manager/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.toml`

- [ ] **Step 1: 添加依赖**

在 `crates/proxy-core/Cargo.toml` 的 `[dependencies]` 中添加：
```toml
tracing = "0.1"
```

在 `crates/tls-manager/Cargo.toml` 的 `[dependencies]` 中添加：
```toml
tracing = "0.1"
lru = "0.12"
```

在 `apps/desktop/src-tauri/Cargo.toml` 的 `[dependencies]` 中添加：
```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["fmt", "env-filter", "json"] }
tracing-appender = "0.2"
```

- [ ] **Step 2: 验证编译**

Run: `cargo check --workspace`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add crates/proxy-core/Cargo.toml crates/tls-manager/Cargo.toml apps/desktop/src-tauri/Cargo.toml Cargo.lock
git commit -m "chore: add tracing, lru, tracing-appender dependencies"
```

---

## Phase 1：前端事件管线与防抖

### Task 1.1：修复 session 事件双重订阅

**Files:**
- Modify: `apps/desktop/src/pages/sessions/index.tsx`
- Modify: `apps/desktop/src/features/sessions/use-session-events.ts`

- [ ] **Step 1: 在 flushUpsertBuffer 中添加 React Query 缓存更新**

在 `apps/desktop/src/pages/sessions/index.tsx` 中：

1. 在文件顶部 imports 中添加：
```typescript
import { upsertSessionSummary, removeSessionSummary, removeSessionSummaries } from "@/features/sessions/session-cache.helpers";
import { SESSION_DETAIL_QUERY_KEY } from "@/features/sessions/use-session-detail";
import { SESSIONS_QUERY_KEY } from "@/features/sessions/use-sessions";
```

（注意：检查这些 import 是否已存在，避免重复。`SESSIONS_QUERY_KEY` 来自 `use-sessions.ts`。）

2. 在 `flushUpsertBuffer` 函数中，在 `setContainerState` 调用之后添加 React Query 缓存更新：

```typescript
function flushUpsertBuffer() {
  if (upsertBuffer.length === 0) return;
  const batch = upsertBuffer;
  upsertBuffer = [];
  flushTimer = null;

  setContainerState((currentState) => {
    let next = currentState;
    for (const summary of batch) {
      next = upsertSessionContainerSummary(next, summary);
    }
    return next;
  });

  // 同步更新 React Query 缓存
  queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) => {
    let updated = currentSessions;
    for (const summary of batch) {
      updated = upsertSessionSummary(updated, summary);
    }
    return updated;
  });

  for (const summary of batch) {
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: [SESSION_DETAIL_QUERY_KEY, summary.id],
    });
  }
}
```

3. 确保 `queryClient` 在该 effect 的闭包中可用（它通过 `useQueryClient()` 获取，已在组件顶部声明）。检查 effect 的依赖数组，若 `queryClient` 不在其中则添加。

- [ ] **Step 2: 移除 useSessionEvents() 调用**

在 `apps/desktop/src/pages/sessions/index.tsx` 中，删除第 151 行的 `useSessionEvents();` 调用及其 import。

- [ ] **Step 3: 同样在 remove/cleared/removed 处理中添加 React Query 缓存更新**

在同一个 effect 中的 `onSessionRemove` 回调中添加：
```typescript
queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
  removeSessionSummary(currentSessions, sessionId),
);
queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, sessionId] });
```

在 `onSessionsCleared` 回调中添加：
```typescript
queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, []);
queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY] });
```

在 `onSessionsRemoved` 回调中添加：
```typescript
queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
  removeSessionSummaries(currentSessions, ids),
);
for (const id of ids) {
  queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, id] });
}
```

- [ ] **Step 4: 清空 use-session-events.ts**

将 `apps/desktop/src/features/sessions/use-session-events.ts` 的内容替换为空 hook（保留导出以防其他地方引用）：

```typescript
/**
 * @deprecated Session events are now handled directly in SessionsPage.
 * This hook is kept as a no-op for backward compatibility.
 */
export function useSessionEvents() {
  // No-op: session event handling consolidated into SessionsPage
}
```

- [ ] **Step 5: 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 无错误

Run: `pnpm --filter @aiproxy/desktop test`
Expected: 现有测试通过

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/pages/sessions/index.tsx apps/desktop/src/features/sessions/use-session-events.ts
git commit -m "perf: consolidate session event subscriptions into SessionsPage batch buffer"
```

---

### Task 1.2：域名过滤器防抖

**Files:**
- Modify: `apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx`

- [ ] **Step 1: 添加本地状态和防抖**

在 `SessionExplorerPane` 组件中（解构 props 之后），添加：

```typescript
import { useDebouncedValue } from "@/hooks/use-debounced-value";
```

在组件内部，`expandedHostSet` 之前添加：

```typescript
const [localFilterValue, setLocalFilterValue] = useState(domainFilterValue);
const debouncedFilterValue = useDebouncedValue(localFilterValue, 150);

useEffect(() => {
  onDomainFilterChange(debouncedFilterValue);
}, [debouncedFilterValue, onDomainFilterChange]);
```

- [ ] **Step 2: 更新 InputBase**

将 `InputBase` 的 `onChange` 从：
```typescript
onChange={(event) => onDomainFilterChange(event.target.value)}
```
改为：
```typescript
onChange={(event) => setLocalFilterValue(event.target.value)}
```

将 `value` 从 `domainFilterValue` 改为 `localFilterValue`。

- [ ] **Step 3: 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx
git commit -m "perf: debounce domain filter input in SessionExplorer"
```

---

### Task 1.3：WS 消息搜索防抖

**Files:**
- Modify: `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx`

- [ ] **Step 1: 添加防抖**

在文件顶部添加 import：
```typescript
import { useDebouncedValue } from "@/hooks/use-debounced-value";
```

在组件内部，在 `const [search, setSearch] = useState("");` 之后添加：

```typescript
const debouncedSearch = useDebouncedValue(search, 150);
```

将 `filtered` 的 `useMemo` 中引用 `search` 的地方改为 `debouncedSearch`：

```typescript
const filtered = useMemo(() => {
  return messages.filter((msg) => {
    if (directionFilter !== "all" && msg.direction !== directionFilter) return false;
    if (opcodeFilter === "text" && msg.opcode !== "text" && msg.opcode !== "continuation") return false;
    if (opcodeFilter === "binary" && msg.opcode !== "binary") return false;
    if (opcodeFilter === "control" && !CONTROL_OPCODES.has(msg.opcode as WsOpcode)) return false;
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      const text = msg.payloadText?.toLowerCase() ?? "";
      if (!text.includes(q) && !msg.opcode.includes(q)) return false;
    }
    return true;
  });
}, [messages, directionFilter, opcodeFilter, debouncedSearch]);
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx
git commit -m "perf: debounce WS message search input"
```

---

### Task 1.4：限制导入 session 存储上限

**Files:**
- Modify: `apps/desktop/src/features/sessions/imported-sessions.store.ts`

- [ ] **Step 1: 添加上限和淘汰逻辑**

```typescript
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

const MAX_IMPORTED_SESSION_DETAILS = 100;
const importedSessionDetails = new Map<string, SessionDetail>();

export function clearImportedSessions() {
  importedSessionDetails.clear();
}

export function getImportedSessionDetail(sessionId: string) {
  return importedSessionDetails.get(sessionId);
}

export function hasImportedSession(sessionId: string) {
  return importedSessionDetails.has(sessionId);
}

export function keepOnlyImportedSession(sessionId: string) {
  for (const importedSessionId of importedSessionDetails.keys()) {
    if (importedSessionId !== sessionId) {
      importedSessionDetails.delete(importedSessionId);
    }
  }
}

export function listImportedSessionSummaries(): SessionSummary[] {
  return Array.from(importedSessionDetails.values(), (detail) => detail.summary);
}

export function upsertImportedSessions(details: SessionDetail[]) {
  for (const detail of details) {
    importedSessionDetails.set(detail.id, detail);
  }
  while (importedSessionDetails.size > MAX_IMPORTED_SESSION_DETAILS) {
    const oldestKey = importedSessionDetails.keys().next().value;
    if (oldestKey !== undefined) importedSessionDetails.delete(oldestKey);
  }
}
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/sessions/imported-sessions.store.ts
git commit -m "perf: cap imported sessions store at 100 entries"
```

---

## Phase 2：虚拟滚动迁移

### Task 2.1：SessionExplorer 虚拟滚动迁移

**Files:**
- Modify: `apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx`

- [ ] **Step 1: 添加 import**

在文件顶部添加：
```typescript
import { useVirtualizer } from "@tanstack/react-virtual";
```

- [ ] **Step 2: 替换虚拟滚动逻辑**

移除以下状态和计算：
- `const [scrollTop, setScrollTop] = useState(0);`
- `const [viewportHeight, setViewportHeight] = useState(0);`
- `ResizeObserver` effect
- `virtualRows` useMemo

保留 `visibleRows` useMemo 不变。

在 `visibleRows` 之后添加：

```typescript
const virtualizer = useVirtualizer({
  count: visibleRows.length,
  getScrollElement: () => scrollContainerRef.current,
  estimateSize: () => SESSION_EXPLORER_ROW_HEIGHT,
  overscan: SESSION_EXPLORER_OVERSCAN,
});
```

- [ ] **Step 3: 更新渲染**

将滚动容器的渲染部分从手写绝对定位改为 `virtualizer` API。将原来的 `totalHeight` + `start` 偏移渲染替换为：

```tsx
<Box
  ref={scrollContainerRef}
  onContextMenu={handleContextMenu}
  sx={{ flex: "1 1 0", overflow: "auto", position: "relative" }}
>
  <Box sx={{ height: virtualizer.getTotalSize(), position: "relative" }}>
    {virtualizer.getVirtualItems().map((virtualItem) => {
      const row = visibleRows[virtualItem.index];
      if (!row) return null;

      return (
        <Box
          key={virtualItem.key}
          style={{
            position: "absolute",
            top: virtualItem.start,
            left: 0,
            width: "100%",
            height: virtualItem.size,
          }}
        >
          {/* 渲染 HostRow 或 SessionTreeFlatNode/SessionLeafNode，与原来相同的 row.kind 判断 */}
        </Box>
      );
    })}
  </Box>
</Box>
```

具体渲染逻辑：将原代码中 `virtualRows.items.map(...)` 的内部渲染逻辑搬到 `virtualizer.getVirtualItems().map(...)` 中，把原来的 `(row, idx)` 改为通过 `visibleRows[virtualItem.index]` 获取 row 数据。原有的 `HostRow` 和 `SessionLeafNode` 组件及 `memo()` 保持不变。

- [ ] **Step 4: 移除 onScroll handler**

移除滚动容器上的 `onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}`。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 无错误

Run: `pnpm --filter @aiproxy/desktop test`
Expected: 现有测试通过

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx
git commit -m "perf: migrate SessionExplorer to @tanstack/react-virtual"
```

---

### Task 2.2：WebSocket Messages 虚拟滚动迁移

**Files:**
- Modify: `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx`

- [ ] **Step 1: 添加 import**

在文件顶部添加：
```typescript
import { useVirtualizer } from "@tanstack/react-virtual";
```

- [ ] **Step 2: 替换虚拟滚动逻辑**

移除以下状态和计算：
- `const [listScrollTop, setListScrollTop] = useState(0);`
- `const [listViewportHeight, setListViewportHeight] = useState(0);`
- `ResizeObserver` effect for `listViewportHeight`
- `virtualWindow` useMemo

在 `filtered` useMemo 之后添加：

```typescript
const listVirtualizer = useVirtualizer({
  count: filtered.length,
  getScrollElement: () => listContainerRef.current,
  estimateSize: () => MESSAGE_ROW_HEIGHT,
  overscan: MESSAGE_ROW_OVERSCAN,
});
```

- [ ] **Step 3: 更新渲染**

将消息列表的渲染从手写绝对定位改为 `listVirtualizer` API，模式与 Task 2.1 相同。用 `listVirtualizer.getTotalSize()` 和 `listVirtualizer.getVirtualItems()` 替换原来的 `virtualWindow.totalHeight` 和 `virtualWindow.items`。

每行的 `top` 用 `virtualItem.start`，`height` 用 `virtualItem.size`。

- [ ] **Step 4: 移除 onScroll handler**

移除列表容器上的 `onScroll={(event) => setListScrollTop(event.currentTarget.scrollTop)}`。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx
git commit -m "perf: migrate WS messages to @tanstack/react-virtual"
```

---

## Phase 3：导出与 body 稳定性

### Task 3.1：统一导出批量加载

**Files:**
- Modify: `apps/desktop/src/features/sessions/session-export.helpers.ts`
- Modify: `apps/desktop/src/pages/sessions/index.tsx`
- Modify: `apps/desktop/src/features/sessions/components/SessionExportDialog.tsx`

- [ ] **Step 1: 在 session-export.helpers.ts 中添加共享批量加载函数**

在文件末尾添加：

```typescript
import type { QueryClient } from "@tanstack/react-query";
import { ensureSessionDetailContent } from "./session-detail-content";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";

export const EXPORT_BATCH_SIZE = 10;

export const DEFAULT_EXPORT_CONTENT_OPTIONS = {
  includeRawRequest: true,
  includeRawResponse: true,
  includeRequestBodyText: true,
  includeResponseBodyText: true,
  includeRequestBodyBase64: true,
  includeResponseBodyBase64: true,
} as const;

export async function loadSessionDetailsBatched(
  queryClient: QueryClient,
  sessions: SessionSummary[],
  batchSize: number = EXPORT_BATCH_SIZE,
): Promise<SessionDetail[]> {
  if (sessions.length === 0) return [];

  const details: SessionDetail[] = [];
  for (let i = 0; i < sessions.length; i += batchSize) {
    const batch = sessions.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((session) =>
        ensureSessionDetailContent(queryClient, session.id, DEFAULT_EXPORT_CONTENT_OPTIONS),
      ),
    );
    details.push(...batchResults);
  }
  return details;
}
```

注意：需要在文件顶部添加 `import type { SessionSummary } from "@aiproxy/shared-types";`（如果还没有的话）。

- [ ] **Step 2: 更新 exportSessionsAsHar 使用批量加载**

在 `apps/desktop/src/pages/sessions/index.tsx` 中：

1. 添加 import：`import { loadSessionDetailsBatched } from "@/features/sessions/session-export.helpers";`
2. 将 `exportSessionsAsHar` 函数改为：

```typescript
async function exportSessionsAsHar(
  queryClient: QueryClient,
  sessions: SessionSummary[],
  filename: string,
) {
  if (sessions.length === 0) return;

  const details = await loadSessionDetailsBatched(queryClient, sessions);

  await downloadTextFile(
    filename,
    JSON.stringify(buildHarArchive(details), null, 2),
    "application/json",
    { revealInFolder: true },
  );
}
```

- [ ] **Step 3: 更新 SessionExportDialog 使用共享函数**

在 `SessionExportDialog.tsx` 中：

1. 添加 import：`import { loadSessionDetailsBatched, DEFAULT_EXPORT_CONTENT_OPTIONS, EXPORT_BATCH_SIZE } from "../session-export.helpers";`
2. 将 `loadDetailsForScope` 函数简化：

对 `scope === "selected"` 的分支，保留单条 `ensureSessionDetailContent` 调用（用 `DEFAULT_EXPORT_CONTENT_OPTIONS` 替换内联对象）。

对批量分支，将内联的 `BATCH_SIZE` + 循环替换为：
```typescript
return loadSessionDetailsBatched(queryClient, summaries);
```

- [ ] **Step 4: 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/sessions/session-export.helpers.ts apps/desktop/src/pages/sessions/index.tsx apps/desktop/src/features/sessions/components/SessionExportDialog.tsx
git commit -m "perf: unify session detail batch loading for export"
```

---

### Task 3.2：body 截断 UI 提示

**Files:**
- Modify: `apps/desktop/src/features/sessions/components/SessionInspectorResponsePane.tsx`
- Modify: `apps/desktop/src/features/sessions/components/SessionInspectorRequestPane.tsx`
- Modify: `apps/desktop/src/i18n/messages/en.ts`
- Modify: `apps/desktop/src/i18n/messages/zh-CN.ts`

- [ ] **Step 1: 添加 i18n 键**

在 `en.ts` 的 session inspector 相关部分添加：
```typescript
sessionInspector: {
  // ... existing keys ...
  bodyTruncatedWarning: "Body was truncated at 20MB. Full content was not captured.",
}
```

在 `zh-CN.ts` 的对应位置添加：
```typescript
sessionInspector: {
  // ... existing keys ...
  bodyTruncatedWarning: "Body 已在 20MB 处截断，完整内容未被捕获。",
}
```

- [ ] **Step 2: 在 Response pane 添加截断提示**

在 `SessionInspectorResponsePane.tsx` 中，在 body 内容渲染区域之前，添加：

```tsx
{detail.responseBody?.truncated && (
  <Alert severity="warning" sx={{ mx: 1, mt: 1 }}>
    {t("sessionInspector.bodyTruncatedWarning")}
  </Alert>
)}
```

需要 import `Alert` from `@mui/material/Alert`。

- [ ] **Step 3: 在 Request pane 添加截断提示**

在 `SessionInspectorRequestPane.tsx` 中添加相同逻辑（检查 `detail.requestBody?.truncated`）。

- [ ] **Step 4: 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/sessions/components/SessionInspectorResponsePane.tsx apps/desktop/src/features/sessions/components/SessionInspectorRequestPane.tsx apps/desktop/src/i18n/messages/en.ts apps/desktop/src/i18n/messages/zh-CN.ts
git commit -m "feat: show body truncation warning in inspector panes"
```

---

## Phase 4：Rust 热路径优化

### Task 4.1：build_session_detail body 解压去重

**Files:**
- Modify: `crates/proxy-core/src/http_io.rs`
- Modify: `crates/proxy-core/src/server.rs`

- [ ] **Step 1: 添加 build_body_reference_from_decoded**

在 `crates/proxy-core/src/http_io.rs` 中，在现有 `build_body_reference` 函数之后添加：

```rust
pub(crate) fn build_body_reference_from_decoded(
    decoded_body: Vec<u8>,
    content_type_header: Option<&HeaderValue>,
    size_bytes: usize,
    truncated: bool,
) -> Option<ProxyBodyReference> {
    if decoded_body.is_empty() && size_bytes == 0 {
        return None;
    }

    let mime_type = content_type_header
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());

    let render_as_text = should_render_body_as_text(mime_type.as_deref(), &decoded_body);

    Some(ProxyBodyReference::from_decoded_bytes(
        decoded_body, mime_type, size_bytes, truncated, render_as_text,
    ))
}
```

- [ ] **Step 2: 在断点路径缓存 detail**

在 `crates/proxy-core/src/server.rs` 中，识别断点流程中多次调用 `build_session_detail` 的代码路径（约第 529、678、734、761 行等）。对于同一请求的后续调用，复用首次构建的 `ProxySessionDetail`：

具体做法：在断点拦截的闭包或代码块中，将首次 `build_session_detail` 的结果存入一个局部变量（如 `let mut cached_detail: Option<ProxySessionDetail> = None;`），后续需要 detail 时优先使用缓存。

这是一个代码层面的优化，需要根据 `server.rs` 中具体的断点流程结构调整。核心原则：同一请求的 `build_session_detail` 只调用一次。

- [ ] **Step 3: 验证编译和测试**

Run: `cargo test --workspace -p aiproxy-proxy-core`
Expected: 现有测试通过

- [ ] **Step 4: Commit**

```bash
git add crates/proxy-core/src/http_io.rs crates/proxy-core/src/server.rs
git commit -m "perf: deduplicate body decompression in build_session_detail"
```

---

### Task 4.2：日志迁移至 tracing

**Files:**
- Modify: `crates/proxy-core/src/logging.rs`
- Modify: `crates/proxy-core/src/lib.rs`
- Modify: `crates/tls-manager/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/dev_logger.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 4.2a: 替换 proxy-core/src/logging.rs**

将 `crates/proxy-core/src/logging.rs` 内容替换为：

```rust
use super::*;

pub(crate) fn emit_log(level: &str, event: &str, fields: &[(&str, String)]) {
    let fields_vec: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    match level {
        "ERROR" => tracing::error!(event, fields = ?fields_vec),
        "WARN" => tracing::warn!(event, fields = ?fields_vec),
        "INFO" => tracing::info!(event, fields = ?fields_vec),
        _ => tracing::debug!(event, fields = ?fields_vec),
    }
}
```

移除 `WRITE_LOCK`、`append_to_log_file`、`resolve_log_file_path`、`quote_value` 等函数。保留 `resolve_log_file_path` 和 `discover_workspace_root_from_current_exe` 如果其他代码仍需要它们（检查引用）。

注意：`proxy-core/src/lib.rs` 中的 `static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();` 也需要移除。

- [ ] **Step 4.2b: 替换 tls-manager 中的日志**

在 `crates/tls-manager/src/lib.rs` 中，找到本地的 `emit_log` 函数（与 proxy-core 类似的自定义实现），替换为 `tracing` 宏调用，模式与 Step 4.2a 相同。

- [ ] **Step 4.2c: 替换 dev_logger.rs**

将 `apps/desktop/src-tauri/src/dev_logger.rs` 的 `emit_log` 函数替换为：

```rust
pub fn emit_log(level: &str, component: &str, event: &str, fields: &[(&str, String)]) {
    let fields_vec: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    match level {
        "ERROR" => tracing::error!(component, event, fields = ?fields_vec),
        "WARN" => tracing::warn!(component, event, fields = ?fields_vec),
        "INFO" => tracing::info!(component, event, fields = ?fields_vec),
        _ => tracing::debug!(component, event, fields = ?fields_vec),
    }
}
```

保留 `initialize()` 函数，但将其改为初始化 `tracing_subscriber`：

```rust
use std::sync::OnceLock;
use tracing_subscriber::EnvFilter;

static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

pub fn initialize() -> Result<PathBuf, String> {
    let log_file_path = resolve_log_file_path();

    if let Some(parent) = log_file_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let file_appender = tracing_appender::rolling::never(
        log_file_path.parent().unwrap_or_else(|| std::path::Path::new(".")),
        log_file_path.file_name().unwrap_or_else(|| std::ffi::OsStr::new("aiproxy-desktop-dev.log")),
    );
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _ = GUARD.set(guard);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(non_blocking.and(std::io::stderr))
        .with_ansi(false)
        .init();

    install_panic_hook();

    Ok(log_file_path)
}
```

保留 `resolve_log_file_path`、`discover_workspace_root_from_current_exe`、`install_panic_hook` 函数。在 `install_panic_hook` 中，将手动文件写入替换为 `tracing::error!`。

- [ ] **Step 4.2d: 验证**

Run: `cargo check --workspace`
Expected: 编译成功

Run: `cargo test --workspace`
Expected: 现有测试通过

- [ ] **Step 4.2e: Commit**

```bash
git add crates/proxy-core/src/logging.rs crates/proxy-core/src/lib.rs crates/tls-manager/src/lib.rs apps/desktop/src-tauri/src/dev_logger.rs apps/desktop/src-tauri/src/main.rs
git commit -m "perf: migrate logging to tracing with buffered async writes"
```

---

### Task 4.3：TLS 证书缓存 LRU 淘汰

**Files:**
- Modify: `crates/tls-manager/Cargo.toml`（已在 Task 0.3 添加 `lru`）
- Modify: `crates/tls-manager/src/storage.rs`
- Modify: `crates/tls-manager/src/storage.rs`（测试部分）

- [ ] **Step 1: 替换 HashMap 为 LruCache**

在 `crates/tls-manager/src/storage.rs` 中：

1. 添加 import：
```rust
use std::num::NonZeroUsize;
use lru::LruCache;
```

2. 将 `host_cache` 字段类型从：
```rust
pub(crate) host_cache: Arc<Mutex<HashMap<String, Arc<rustls::sign::CertifiedKey>>>>,
```
改为：
```rust
pub(crate) host_cache: Arc<Mutex<LruCache<String, Arc<rustls::sign::CertifiedKey>>>>,
```

3. 在 `CertStorage::resolve()` 和 `CertStorage::new_in_temp_dir()` 中，将初始化改为：
```rust
host_cache: Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(512).unwrap()))),
```

4. 在 `get_or_create_host_certified_key` 中：
   - `cache.get(hostname)` 保持不变（LruCache 的 get 会自动 promote）
   - `cache.put(hostname.to_string(), ...)` 保持不变（`lru` crate 使用 `put` 而非 `insert`）
   - `clear_host_cache` 改为 `cache.clear()`

5. 在 `Clone` impl 中，`host_cache: Arc::clone(&self.host_cache)` 保持不变。

- [ ] **Step 2: 更新现有测试**

将现有测试中创建 `CertStorage` 的地方（如果直接构造了 `HashMap`），更新为 `LruCache::new(NonZeroUsize::new(512).unwrap())`。

- [ ] **Step 3: 添加 LRU 淘汰测试**

在 `crates/tls-manager/src/storage.rs` 的 `#[cfg(test)]` 模块中添加：

```rust
#[test]
fn lru_cache_evicts_oldest_entries() {
    let storage = CertStorage::new_in_temp_dir();
    let cap = 512;

    // Fill cache to capacity
    for i in 0..cap {
        let hostname = format!("host{}.example.com", i);
        let _ = storage.host_cache.lock().unwrap().put(hostname, Arc::new(create_test_certified_key()));
    }
    assert_eq!(storage.host_cache.lock().unwrap().len(), cap);

    // Insert one more — should evict the oldest
    let extra = "extra.example.com";
    let _ = storage.host_cache.lock().unwrap().put(extra.to_string(), Arc::new(create_test_certified_key()));
    assert_eq!(storage.host_cache.lock().unwrap().len(), cap);

    // Oldest should be gone
    assert!(storage.host_cache.lock().unwrap().get(&"host0.example.com".to_string()).is_none());
    // Newest should be present
    assert!(storage.host_cache.lock().unwrap().get(&extra.to_string()).is_some());
}
```

注意：`create_test_certified_key()` 需要根据现有测试辅助函数调整。如果不存在，可以用 `sign_host_certificate` 生成一个。

- [ ] **Step 4: 验证**

Run: `cargo test --workspace -p aiproxy-tls-manager`
Expected: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add crates/tls-manager/src/storage.rs
git commit -m "perf: replace unbounded HashMap with LruCache for TLS certs"
```

---

### Task 4.4：Session 持久化批量化

**Files:**
- Modify: `apps/desktop/src-tauri/src/bootstrap/mod.rs`
- Modify: `apps/desktop/src-tauri/src/commands/proxy.rs`

- [ ] **Step 1: 提取共享的 persist_session_to_db 内部方法**

在 `apps/desktop/src-tauri/src/bootstrap/mod.rs` 的 `AppState` impl 中，将现有 `upsert_session` 方法体中的 DB 持久化逻辑（从 `let conn = self.db.lock()...` 到 `drop(conn)`）提取为一个私有方法 `persist_session_to_db`。同样将缓存更新和事件发送逻辑提取为 `update_session_cache_and_emit`。

然后让现有 `upsert_session` 调用这两个方法（行为不变）：

```rust
pub fn upsert_session(&self, session: ProxySessionDetail) {
    self.persist_session_to_db(&session);
    self.update_session_cache_and_emit(&session);
}

fn persist_session_to_db(&self, session: &ProxySessionDetail) {
    let conn = self.db.lock().expect("db mutex");
    // 现有的 summary + detail + trace INSERT 逻辑
    // ...
}

fn update_session_cache_and_emit(&self, session: &ProxySessionDetail) {
    // 现有的 in-memory cache 更新 + evict + Tauri event emit 逻辑
    // ...
}
```

- [ ] **Step 1b: 添加 upsert_session_batch**

在同一个 impl 中添加：

```rust
const SESSION_BATCH_SIZE: usize = 50;

pub fn upsert_session_batch(&self, sessions: &[ProxySessionDetail]) {
    // 批量 DB 持久化：获取锁一次
    let conn = self.db.lock().expect("db mutex");
    for session in sessions {
        let _ = aiproxy_db::sessions::upsert_session(
            &conn,
            &proxy_summary_to_row(session),
            &proxy_detail_to_row(session),
        );
        // 现有的 trace INSERT 逻辑（从 persist_session_to_db 中复用）
    }
    drop(conn);

    // 逐条更新缓存和发送事件
    for session in sessions {
        self.update_session_cache_and_emit(session);
    }
}
```

注意：`persist_session_to_db` 中可能涉及 body spill-to-disk 操作。在批量版本中，body spill 也需要在 DB 锁之前完成（因为 body 文件写入不需要 DB 锁）。如果 body spill 在 DB 锁内，则需要先循环 spill 所有 body，再获取 DB 锁批量写入。

- [ ] **Step 2: 修改 collector 循环批量处理**

在 `apps/desktop/src-tauri/src/commands/proxy.rs` 中，将 session 接收循环从：

```rust
session = session_receiver.recv() => {
    match session {
        Some(session) => state_for_collector.upsert_session(session),
        None => break,
    }
}
```

改为：

```rust
session = session_receiver.recv() => {
    match session {
        Some(first) => {
            let mut batch = vec![first];
            while batch.len() < 50 {
                match session_receiver.try_recv() {
                    Ok(session) => batch.push(session),
                    Err(_) => break,
                }
            }
            state_for_collector.upsert_session_batch(&batch);
        }
        None => break,
    }
}
```

- [ ] **Step 3: 验证**

Run: `cargo check --workspace`
Expected: 编译成功

Run: `cargo test --workspace`
Expected: 现有测试通过

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/bootstrap/mod.rs apps/desktop/src-tauri/src/commands/proxy.rs
git commit -m "perf: batch session persistence up to 50 per transaction"
```

---

## Phase 5：质量基线

### Task 5.1：创建压测 fixture 生成脚本

**Files:**
- Create: `scripts/generate-stress-fixtures.ts`
- Create: `fixtures/stress/`（目录）

- [ ] **Step 1: 编写 fixture 生成脚本**

`scripts/generate-stress-fixtures.ts`：

```typescript
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { SessionSummary, WsMessage } from "@aiproxy/shared-types";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "stress");

function randomHost(i: number): string {
  const hosts = [
    "api.example.com", "cdn.example.com", "auth.example.com",
    "ws.example.com", "graphql.example.com", "rest.example.com",
    "static.example.com", "upload.example.com", "download.example.com",
    "gateway.example.com", "api.staging.example.com", "api.prod.example.com",
    "metrics.example.com", "admin.example.com", "webhook.example.com",
    "oauth.example.com", "sso.example.com", "cdn2.example.com",
    "media.example.com", "search.example.com", "api.v2.example.com",
    "notifications.example.com", "billing.example.com", "users.example.com",
    "orders.example.com", "products.example.com", "inventory.example.com",
    "shipping.example.com", "payments.example.com", "analytics.example.com",
    "logging.example.com", "config.example.com", "features.example.com",
    "experiments.example.com", "abtesting.example.com", "seo.example.com",
    "sitemap.example.com", "feeds.example.com", "proxy.example.com",
    "cache.example.com", "queue.example.com", "scheduler.example.com",
    "jobs.example.com", "tasks.example.com", "events.example.com",
    "audit.example.com", "compliance.example.com", "legal.example.com",
    "support.example.com", "docs.example.com",
  ];
  return hosts[i % hosts.length];
}

function randomPath(i: number): string {
  const paths = [
    "/api/v1/users", "/api/v1/orders", "/api/v1/products",
    "/api/v1/auth/login", "/api/v1/auth/token", "/api/v1/search",
    "/api/v2/graphql", "/api/v1/health", "/api/v1/metrics",
    "/api/v1/webhooks", "/static/js/app.js", "/static/css/main.css",
    "/api/v1/payments/charge", "/api/v1/shipping/track",
  ];
  return paths[i % paths.length];
}

function randomMethod(i: number): string {
  const methods = ["GET", "GET", "GET", "POST", "PUT", "DELETE", "PATCH"];
  return methods[i % methods.length];
}

function randomStatus(i: number): number {
  const statuses = [200, 200, 200, 200, 201, 204, 301, 400, 404, 500];
  return statuses[i % statuses.length];
}

function generateSessionSummaries(count: number): SessionSummary[] {
  const summaries: SessionSummary[] = [];
  for (let i = 0; i < count; i++) {
    const host = randomHost(i);
    const path = randomPath(i);
    summaries.push({
      id: `session-${String(i).padStart(6, "0")}`,
      method: randomMethod(i),
      host,
      path,
      url: `https://${host}${path}`,
      scheme: "https",
      httpVersion: "1.1",
      transportProtocol: "tcp",
      applicationProtocol: "http/1.1",
      statusCode: randomStatus(i),
      durationMs: Math.floor(Math.random() * 2000),
      sizeBytes: Math.floor(Math.random() * 500_000),
      responseMimeType: i % 3 === 0 ? "application/json" : "text/html",
      startedAt: new Date(Date.now() - (count - i) * 1000).toISOString(),
    } as SessionSummary);
  }
  return summaries;
}

function generateWsMessages(count: number): WsMessage[] {
  const messages: WsMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `ws-msg-${String(i).padStart(6, "0")}`,
      sessionId: "session-ws-test",
      direction: i % 2 === 0 ? "clientToServer" : "serverToClient",
      timestamp: new Date(Date.now() + i * 100).toISOString(),
      opcode: i % 10 === 0 ? "ping" : "text",
      payloadText: `Message ${i}: ${JSON.stringify({ data: "x".repeat(100), seq: i })}`,
      payloadSize: 100 + i,
      fin: true,
    } as WsMessage);
  }
  return messages;
}

mkdirSync(FIXTURES_DIR, { recursive: true });

const summaries = generateSessionSummaries(10_000);
writeFileSync(join(FIXTURES_DIR, "10k-sessions.json"), JSON.stringify(summaries));

const wsMessages = generateWsMessages(1_000);
writeFileSync(join(FIXTURES_DIR, "1k-ws-messages.json"), JSON.stringify(wsMessages));

// 50MB text body
const chunk = "A".repeat(1024); // 1KB
const largeBody = chunk.repeat(50 * 1024); // 50MB
writeFileSync(join(FIXTURES_DIR, "50mb-body.txt"), largeBody);

// 50MB gzip variant
import { gzipSync } from "zlib";
writeFileSync(join(FIXTURES_DIR, "50mb-body.txt.gz"), gzipSync(Buffer.from(largeBody)));

console.log("Stress fixtures generated in", FIXTURES_DIR);
```

注意：此脚本使用 TypeScript，需要用 `tsx` 或 `ts-node` 运行。检查项目是否有 `tsx` 可用（`pnpm dlx tsx scripts/generate-stress-fixtures.ts`）。

- [ ] **Step 2: 生成 fixture 文件**

Run: `cd /Users/jake/AI/AIProxy && pnpm dlx tsx scripts/generate-stress-fixtures.ts`
Expected: `fixtures/stress/` 下生成 4 个文件

- [ ] **Step 3: 添加 fixture 到 .gitignore（大文件）**

在 `.gitignore` 中添加：
```
fixtures/stress/50mb-body.txt
fixtures/stress/50mb-body.txt.gz
```

（JSON fixture 文件可以提交，50MB body 文件太大不适合 git。）

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-stress-fixtures.ts fixtures/stress/10k-sessions.json fixtures/stress/1k-ws-messages.json fixtures/stress/50mb-body.txt.gz .gitignore
git commit -m "test: add stress test fixture generator and data files"
```

---

### Task 5.2：前端压测

**Files:**
- Create: `apps/desktop/src/features/sessions/session-explorer.helpers.stress.test.ts`
- Create: `apps/desktop/src/features/sessions/components/SessionExplorerPane.stress.test.tsx`

- [ ] **Step 1: 编写 buildSessionHostGroups 性能测试**

`apps/desktop/src/features/sessions/session-explorer.helpers.stress.test.ts`：

```typescript
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildSessionHostGroups } from "./session-explorer.helpers";
import type { SessionSummary } from "@aiproxy/shared-types";

const fixturesDir = join(import.meta.dirname, "../../../../../../fixtures/stress");
const sessions: SessionSummary[] = JSON.parse(
  readFileSync(join(fixturesDir, "10k-sessions.json"), "utf-8"),
);

describe("buildSessionHostGroups stress", () => {
  it("builds tree for 10k sessions in under 100ms", () => {
    const start = performance.now();
    const groups = buildSessionHostGroups(sessions, undefined);
    const elapsed = performance.now() - start;

    expect(groups.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});
```

- [ ] **Step 2: 运行验证**

Run: `pnpm --filter @aiproxy/desktop test -- --run src/features/sessions/session-explorer.helpers.stress.test.ts`
Expected: PASS，耗时 < 100ms

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/sessions/session-explorer.helpers.stress.test.ts
git commit -m "test: add buildSessionHostGroups stress test with 10k sessions"
```

---

### Task 5.3：WS 消息面板压测

**Files:**
- Create: `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.stress.test.tsx`

- [ ] **Step 1: 编写 WS 消息虚拟滚动压测**

`apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.stress.test.tsx`：

```typescript
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WsMessage } from "@aiproxy/shared-types";

// 加载 1k WS 消息 fixture
const fixturesDir = join(import.meta.dirname, "../../../../../../fixtures/stress");
const wsMessages: WsMessage[] = JSON.parse(
  readFileSync(join(fixturesDir, "1k-ws-messages.json"), "utf-8"),
);

// Mock Tauri 命令
vi.mock("@/services/commands", () => ({
  listWsMessages: vi.fn().mockResolvedValue(wsMessages),
  getWsConnectionStatus: vi.fn().mockResolvedValue("active"),
  injectWsMessage: vi.fn(),
}));

vi.mock("@/services/events", () => ({
  onWsMessage: vi.fn().mockResolvedValue(vi.fn()),
  onWsConnectionStatus: vi.fn().mockResolvedValue(vi.fn()),
}));

describe("SessionInspectorMessagesPane stress", () => {
  it("renders 1k messages with virtualization", async () => {
    render(
      <SessionInspectorMessagesPane
        sessionId="session-ws-test"
        onComposeMessage={vi.fn()}
      />,
    );

    // 等待消息加载
    const rows = await screen.findAllByRole("row");
    // 虚拟化后 DOM 中应远少于 1000 行
    expect(rows.length).toBeLessThan(100);
  });
});
```

注意：需要根据 `SessionInspectorMessagesPane` 的实际 props 和 DOM 结构调整选择器和 mock。上面的代码是骨架，实现时需要查看组件实际的 prop 类型和渲染结构。

- [ ] **Step 2: 运行验证**

Run: `pnpm --filter @aiproxy/desktop test -- --run src/features/sessions/components/SessionInspectorMessagesPane.stress.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.stress.test.tsx
git commit -m "test: add WS messages panel stress test with 1k messages"
```

---

### Task 5.4：Rust body 解压基准测试

**Files:**
- Modify: `crates/proxy-core/Cargo.toml`（添加 criterion dev-dependency）
- Create: `crates/proxy-core/benches/body_decompress.rs`

- [ ] **Step 1: 添加 criterion 依赖**

在 `crates/proxy-core/Cargo.toml` 中添加：

```toml
[dev-dependencies]
criterion = { version = "0.5", features = ["html_reports"] }

[[bench]]
name = "body_decompress"
harness = false
```

- [ ] **Step 2: 编写基准测试**

`crates/proxy-core/benches/body_decompress.rs`：

```rust
use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use aiproxy_proxy_core::http_io::decode_body_bytes;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;

fn generate_gzip_body(size: usize) -> Vec<u8> {
    let raw = "A".repeat(size);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw.as_bytes()).unwrap();
    encoder.finish().unwrap()
}

fn bench_decode_body_bytes(c: &mut Criterion) {
    let compressed = generate_gzip_body(1024 * 1024); // 1MB

    c.bench_function("decode_1mb_gzip_body", |b| {
        b.iter(|| {
            decode_body_bytes(black_box(&compressed), Some("gzip"))
        });
    });
}

criterion_group!(benches, bench_decode_body_bytes);
criterion_main!(benches);
```

注意：`decode_body_bytes` 可能不是 pub 的。如果是 `pub(crate)`，需要在 `http_io.rs` 中添加 `pub` 导出或在 benchmark 中通过公开的 wrapper 调用。此外 `flate2` 需要在 dev-dependencies 中添加。

如果 `decode_body_bytes` 不可公开，备选方案：创建一个公开的 wrapper 函数 `pub fn bench_decode_body(bytes: &[u8], encoding: Option<&str>) -> Option<Vec<u8>>`，仅在 `#[cfg(test)]` 或 feature gate 下暴露。

- [ ] **Step 3: 运行基准测试**

Run: `cd /Users/jake/AI/AIProxy && cargo bench -p aiproxy-proxy-core --bench body_decompress`
Expected: 基准测试运行并输出结果

- [ ] **Step 4: Commit**

```bash
git add crates/proxy-core/Cargo.toml crates/proxy-core/benches/body_decompress.rs
git commit -m "test: add body decompression benchmark"
```

---

### Task 5.5：发布检查脚本

**Files:**
- Create: `scripts/release-checklist.sh`

- [ ] **Step 1: 编写发布检查脚本**

`scripts/release-checklist.sh`：

```bash
#!/bin/bash
set -euo pipefail

echo "=== AIProxy Release Checklist ==="
echo ""

echo "[1/5] Typecheck..."
pnpm typecheck
echo "✓ Typecheck passed"
echo ""

echo "[2/5] Lint..."
pnpm lint
echo "✓ Lint passed"
echo ""

echo "[3/5] Frontend Tests..."
pnpm test
echo "✓ Frontend tests passed"
echo ""

echo "[4/5] Rust Tests..."
cargo test --workspace
echo "✓ Rust tests passed"
echo ""

echo "[5/5] Rust Clippy..."
cargo clippy --workspace -- -D warnings
echo "✓ Clippy passed"
echo ""

echo "=== All checks passed ==="
```

- [ ] **Step 2: 添加执行权限**

Run: `chmod +x scripts/release-checklist.sh`

- [ ] **Step 3: 验证脚本可执行**

Run: `cd /Users/jake/AI/AIProxy && bash scripts/release-checklist.sh`
Expected: 所有步骤通过

- [ ] **Step 4: Commit**

```bash
git add scripts/release-checklist.sh
git commit -m "chore: add release checklist script"
```

---

## 最终验证

完成所有 Phase 后，执行以下验证：

- [ ] 运行 `pnpm typecheck` — 通过
- [ ] 运行 `pnpm lint` — 通过
- [ ] 运行 `pnpm test` — 通过
- [ ] 运行 `cargo test --workspace` — 通过
- [ ] 启动桌面端 `pnpm desktop:run`，手动验证：
  - Session 列表在高流量下滚动流畅
  - 搜索输入不卡顿
  - WebSocket 消息面板滚动正常
  - 导出多个 session 时 UI 不冻结
