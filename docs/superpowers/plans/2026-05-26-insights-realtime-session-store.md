# Insights 实时数据与 Session Store 统一 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SessionContainerState 从 Sessions 页面的 useState 提升到 Zustand store，在 AppShell 层注册全局事件监听器，实现 Sessions 和 Insights 页面实时同步、切页面不丢数据。

**Architecture:** Zustand store 吸收 SessionContainerState 所有字段，现有 helpers 纯函数不变，store actions 直接调用它们。全局事件监听 hook 在 AppShell 调用，100ms buffer flush 同步更新 store 和 React Query 缓存。Insights 后端查询用 debounced sessionIds 避免高频 SQL。

**Tech Stack:** Zustand, React Query, Tauri events, TypeScript

**Spec:** `docs/superpowers/specs/2026-05-26-insights-realtime-session-store-design.md`

---

### Task 1: 重写 Zustand store — 吸收 SessionContainerState

**Files:**
- Modify: `apps/desktop/src/features/sessions/session-container.store.ts`

- [ ] **Step 1: 重写 store，吸收所有字段和 actions**

```typescript
import { create } from "zustand";
import type { SessionSummary } from "@aiproxy/shared-types";
import {
  type SessionContainer,
  type SessionContainerState,
  clearActiveSessionContainer,
  clearOtherSessionsInActiveContainer,
  closeSessionContainer,
  createAdditionalSessionContainer,
  createInitialSessionContainerState,
  getSessionContainerById,
  removeSessionContainerSummary,
  seedSessionContainers,
  setActiveSessionContainer,
  updateActiveSessionContainer,
  upsertSessionContainerSummary,
} from "./session-containers.helpers";

function deriveActiveData(state: SessionContainerState) {
  const activeContainer = getSessionContainerById(state, state.activeContainerId);
  const sessionIds = activeContainer?.sessionIds ?? [];
  return {
    activeSessionIds: sessionIds,
    activeSessionSummaries: sessionIds
      .map((id) => state.sessionSummaryById[id])
      .filter((s): s is SessionSummary => Boolean(s)),
  };
}

export type SessionContainerStore = SessionContainerState & {
  activeSessionIds: string[];
  activeSessionSummaries: SessionSummary[];

  init: (options?: Parameters<typeof createInitialSessionContainerState>[0]) => void;
  seedSessions: (sessions: SessionSummary[]) => void;
  upsertSummary: (summary: SessionSummary) => void;
  removeSummary: (sessionId: string) => void;
  addContainer: () => void;
  closeContainer: (containerId: string) => void;
  selectContainer: (containerId: string) => void;
  updateActiveContainer: (updater: (c: SessionContainer) => SessionContainer) => void;
  clearSessions: (options?: Parameters<typeof createInitialSessionContainerState>[0]) => void;
  clearOtherSessions: (keepSessionId: string) => void;
  clearActiveContainerSessions: () => void;
};

const initialState = createInitialSessionContainerState();

export const useSessionContainerStore = create<SessionContainerStore>((set) => ({
  ...initialState,
  ...deriveActiveData(initialState),

  init: (options) => set((state) => {
    if (state.hydrated) return state;
    const next = createInitialSessionContainerState(options);
    return { ...next, ...deriveActiveData(next) };
  }),

  seedSessions: (sessions) => set((state) => {
    const next = seedSessionContainers(state, sessions);
    return { ...next, ...deriveActiveData(next) };
  }),

  upsertSummary: (summary) => set((state) => {
    const next = upsertSessionContainerSummary(state, summary);
    return { ...next, ...deriveActiveData(next) };
  }),

  removeSummary: (sessionId) => set((state) => {
    const next = removeSessionContainerSummary(state, sessionId);
    return { ...next, ...deriveActiveData(next) };
  }),

  addContainer: () => set((state) => {
    const next = createAdditionalSessionContainer(state);
    return { ...next, ...deriveActiveData(next) };
  }),

  closeContainer: (containerId) => set((state) => {
    const next = closeSessionContainer(state, containerId);
    return { ...next, ...deriveActiveData(next) };
  }),

  selectContainer: (containerId) => set((state) => {
    const next = setActiveSessionContainer(state, containerId);
    return { ...next, ...deriveActiveData(next) };
  }),

  updateActiveContainer: (updater) => set((state) => {
    const next = updateActiveSessionContainer(state, updater);
    return { ...next, ...deriveActiveData(next) };
  }),

  clearSessions: (options) => set(() => {
    const next = createInitialSessionContainerState(options);
    return { ...next, ...deriveActiveData(next) };
  }),

  clearOtherSessions: (keepSessionId) => set((state) => {
    const next = clearOtherSessionsInActiveContainer(state, keepSessionId);
    return { ...next, ...deriveActiveData(next) };
  }),

  clearActiveContainerSessions: () => set((state) => {
    const next = clearActiveSessionContainer(state);
    return { ...next, ...deriveActiveData(next) };
  }),
}));
```

- [ ] **Step 2: 运行 typecheck 验证 store 编译通过**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/sessions/session-container.store.ts
git commit -m "refactor(sessions): absorb SessionContainerState into Zustand store"
```

---

### Task 2: 创建全局 session 事件监听 hook

**Files:**
- Create: `apps/desktop/src/features/sessions/use-session-events.ts`

- [ ] **Step 1: 创建 hook 文件**

```typescript
import type { SessionSummary } from "@aiproxy/shared-types";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useSessionContainerStore } from "./session-container.store";
import { upsertSessionSummary, removeSessionSummary, removeSessionSummaries } from "./session-query-helpers";
import { SESSIONS_QUERY_KEY, SESSION_DETAIL_QUERY_KEY } from "./use-sessions";
import {
  onSessionUpsert,
  onSessionRemove,
  onSessionsCleared,
  onSessionsRemoved,
} from "@/services/events";
import { removeStorageValue, readStorageValue } from "@/services/storage";
import {
  INSPECTOR_SPLIT_RATIO_STORAGE_KEY,
  REQUEST_COLLAPSED_STORAGE_KEY,
  SELECTED_SESSION_ID_STORAGE_KEY,
} from "./session-storage-keys";

const FLUSH_INTERVAL_MS = 100;

export function useSessionEvents() {
  const store = useSessionContainerStore;
  const queryClient = useQueryClient();
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];
    let upsertBuffer: SessionSummary[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flushUpsertBuffer() {
      if (upsertBuffer.length === 0) return;
      const batch = upsertBuffer;
      upsertBuffer = [];
      flushTimer = null;

      const s = storeRef.current.getState();
      let next = s as ReturnType<typeof s>;
      for (const summary of batch) {
        next = storeRef.current.getState();
        storeRef.current.getState().upsertSummary(summary);
      }

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

    onSessionUpsert((summary) => {
      if (cancelled) return;
      upsertBuffer.push(summary);
      if (!flushTimer) {
        flushTimer = setTimeout(flushUpsertBuffer, FLUSH_INTERVAL_MS);
      }
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    onSessionRemove((sessionId) => {
      if (cancelled) return;
      storeRef.current.getState().removeSummary(sessionId);
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        removeSessionSummary(currentSessions, sessionId),
      );
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, sessionId] });
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    onSessionsCleared(() => {
      if (cancelled) return;
      upsertBuffer = [];
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      removeStorageValue(SELECTED_SESSION_ID_STORAGE_KEY);

      const s = storeRef.current.getState();
      storeRef.current.getState().clearSessions({
        inspectorSplitRatio:
          s.containers.find((c) => c.id === s.activeContainerId)?.inspectorSplitRatio,
        requestCollapsed:
          s.containers.find((c) => c.id === s.activeContainerId)?.requestCollapsed
          ?? readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
        requestTab:
          s.containers.find((c) => c.id === s.activeContainerId)?.requestTab ?? "headers",
        responseTab:
          s.containers.find((c) => c.id === s.activeContainerId)?.responseTab ?? "overview",
      });
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, []);
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY] });
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    onSessionsRemoved((ids) => {
      if (cancelled) return;
      for (const id of ids) {
        storeRef.current.getState().removeSummary(id);
      }
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        removeSessionSummaries(currentSessions, ids),
      );
      for (const id of ids) {
        queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, id] });
      }
    }).then((fn) => {
      if (!cancelled) unlistenFns.push(fn);
      else fn();
    });

    return () => {
      cancelled = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushUpsertBuffer();
      }
      for (const fn of unlistenFns) {
        fn();
      }
    };
  }, [queryClient]);
}
```

注意：需要检查 `upsertSessionSummary`、`removeSessionSummary`、`removeSessionSummaries`、`SESSIONS_QUERY_KEY`、`SESSION_DETAIL_QUERY_KEY` 的实际导出位置，确保 import 路径正确。这些函数在 Sessions 页面中使用，可能需要从现有代码中提取到共享位置。

- [ ] **Step 2: 确认 import 路径正确，运行 typecheck**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS（如果 import 路径有问题，根据实际文件位置调整）

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/sessions/use-session-events.ts
git commit -m "feat(sessions): add global session event listener hook"
```

---

### Task 3: AppShell 接入全局事件监听

**Files:**
- Modify: `apps/desktop/src/components/layout/AppShell.tsx`

- [ ] **Step 1: 在 AppShell 组件顶部添加 hook 调用**

在 AppShell 函数体中 `useBreakpointEvents()` 之后添加：

```typescript
useSessionEvents();
```

添加 import：

```typescript
import { useSessionEvents } from "@/features/sessions/use-session-events";
```

- [ ] **Step 2: 运行 typecheck 验证**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/layout/AppShell.tsx
git commit -m "feat: register global session event listener in AppShell"
```

---

### Task 4: Sessions 页面改用 Zustand store

**Files:**
- Modify: `apps/desktop/src/pages/sessions/index.tsx`

这是最大的改动。逐块替换：

- [ ] **Step 1: 替换 containerState 初始化**

将：
```typescript
const [containerState, setContainerState] = useState(() => {
  const storedSessionId = readStorageValue(SELECTED_SESSION_ID_STORAGE_KEY);
  return createInitialSessionContainerState({
    expandedHosts: readStoredHosts(EXPANDED_HOSTS_STORAGE_KEY),
    inspectorSplitRatio: defaultInspectorSplitRatio,
    requestCollapsed: readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
    requestTab: "query",
    responseTab: "overview",
    ...(storedSessionId ? { selectedSessionId: storedSessionId } : {}),
  });
});
```

替换为：
```typescript
const {
  activeContainerId,
  containers,
  hydrated,
  sessionSummaryById,
  seedSessions,
  upsertSummary,
  removeSummary,
  clearSessions: clearStoreSessions,
  addContainer,
  closeContainer,
  selectContainer,
  updateActiveContainer: updateContainer,
  clearOtherSessions,
  clearActiveContainerSessions,
  activeSessionIds,
  activeSessionSummaries,
} = useSessionContainerStore();
```

注意：store 的 init 需要在组件首次挂载时调用（带 localStorage 参数），可以用 useEffect 或在 store 创建时完成。推荐在组件顶部添加：

```typescript
useEffect(() => {
  if (hydrated) return;
  const storedSessionId = readStorageValue(SELECTED_SESSION_ID_STORAGE_KEY);
  useSessionContainerStore.getState().init({
    expandedHosts: readStoredHosts(EXPANDED_HOSTS_STORAGE_KEY),
    inspectorSplitRatio: defaultInspectorSplitRatio,
    requestCollapsed: readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
    requestTab: "query",
    responseTab: "overview",
    ...(storedSessionId ? { selectedSessionId: storedSessionId } : {}),
  });
}, [defaultInspectorSplitRatio, hydrated]);
```

- [ ] **Step 2: 删除 Zustand filter store 的写入逻辑**

删除以下代码（store 的 deriveActiveData 已自动处理）：
```typescript
const setActiveSessionIds = useSessionContainerFilterStore((s) => s.setActiveSessionIds);
const setActiveSessionSummaries = useSessionContainerFilterStore((s) => s.setActiveSessionSummaries);

useEffect(() => {
  const activeContainer = getSessionContainerById(containerState, containerState.activeContainerId);
  const sessionIds = activeContainer?.sessionIds ?? [];
  setActiveSessionIds(sessionIds);
  setActiveSessionSummaries(
    sessionIds
      .map((sessionId) => containerState.sessionSummaryById[sessionId])
      .filter((session): session is SessionSummary => Boolean(session)),
  );
}, [containerState, setActiveSessionIds, setActiveSessionSummaries]);
```

- [ ] **Step 3: 替换 seed hydration useEffect**

将：
```typescript
useEffect(() => {
  if (areSessionsLoading) return;
  setContainerState((currentState) =>
    currentState.hydrated ? currentState : seedSessionContainers(currentState, runtimeSessions),
  );
}, [areSessionsLoading, runtimeSessions]);
```

替换为：
```typescript
useEffect(() => {
  if (areSessionsLoading) return;
  if (!useSessionContainerStore.getState().hydrated) {
    seedSessions(runtimeSessions);
  }
}, [areSessionsLoading, runtimeSessions, seedSessions]);
```

- [ ] **Step 4: 删除整个页面级事件监听 useEffect**

删除从 `useEffect(() => { let cancelled = false;` 开始到对应的 `}, [defaultInspectorSplitRatio, queryClient]);` 结束的整个 useEffect 块（约 lines 265-397）。此逻辑已移到 `useSessionEvents`。

- [ ] **Step 5: 替换所有 setContainerState 调用**

全局搜索 `setContainerState` 并替换：
- `setContainerState(prev => updateActiveSessionContainer(prev, updater))` → `updateContainer(updater)`
- `setContainerState(prev => upsertSessionContainerSummary(prev, summary))` → `upsertSummary(summary)`
- `setContainerState(prev => removeSessionContainerSummary(prev, id))` → `removeSummary(id)`
- `setContainerState(prev => seedSessionContainers(prev, sessions))` → `seedSessions(sessions)`
- `setContainerState(prev => createAdditionalSessionContainer(prev))` → `addContainer()`
- `setContainerState(prev => closeSessionContainer(prev, id))` → `closeContainer(id)`
- `setContainerState(prev => setActiveSessionContainer(prev, id))` → `selectContainer(id)`
- `setContainerState(prev => clearOtherSessionsInActiveContainer(prev, id))` → `clearOtherSessions(id)`
- `setContainerState(prev => createInitialSessionContainerState(...))` → `clearStoreSessions(...)`

- [ ] **Step 6: 替换 containerState 的所有读取**

全局搜索 `containerState.` 并替换：
- `containerState.activeContainerId` → `activeContainerId`
- `containerState.containers` → `containers`
- `containerState.sessionSummaryById` → `sessionSummaryById`
- `containerState.sessionSummaryById[sessionId]` → `sessionSummaryById[sessionId]`
- `containerState.hydrated` → `hydrated`

- [ ] **Step 7: 更新 activeContainer 和 activeSessions 的计算**

将：
```typescript
const activeContainer =
  getSessionContainerById(containerState, containerState.activeContainerId) ??
  containerState.containers[0];

const activeSessions = useMemo(
  () =>
    (activeContainer?.sessionIds ?? [])
      .map((sessionId) => containerState.sessionSummaryById[sessionId])
      .filter((session): session is SessionSummary => Boolean(session)),
  [activeContainer?.sessionIds, containerState.sessionSummaryById],
);
```

替换为：
```typescript
const activeContainer =
  containers.find((c) => c.id === activeContainerId) ?? containers[0];

const activeSessions = activeSessionSummaries;
```

- [ ] **Step 8: 更新 session-scope-registry 同步**

将：
```typescript
syncSessionCompareScopes(
  containerState.containers.map((container) => ({
```

替换为：
```typescript
syncSessionCompareScopes(
  containers.map((container) => ({
```

- [ ] **Step 9: 更新 handleClearActiveContainer**

将：
```typescript
setContainerState((currentState) =>
  createInitialSessionContainerState({
    inspectorSplitRatio:
      getSessionContainerById(currentState, currentState.activeContainerId)?.inspectorSplitRatio
      ?? defaultInspectorSplitRatio,
    ...
  }),
);
```

替换为：
```typescript
clearStoreSessions({
  inspectorSplitRatio: activeContainer?.inspectorSplitRatio ?? defaultInspectorSplitRatio,
  requestCollapsed: activeContainer?.requestCollapsed ?? readStorageValue(REQUEST_COLLAPSED_STORAGE_KEY) === "true",
  requestTab: activeContainer?.requestTab ?? "headers",
  responseTab: activeContainer?.responseTab ?? "overview",
});
```

- [ ] **Step 10: 清理无用 import**

删除不再需要的 import：
- `useState`（如果 sessions 页面不再使用任何 useState，但实际还有 explorerWidth 等其他 useState，所以保留）
- `createInitialSessionContainerState`、`seedSessionContainers`、`upsertSessionContainerSummary` 等 helpers（已移到 store 内部）
- `useSessionContainerFilterStore`（已被 useSessionContainerStore 替代）

添加需要的 import：
```typescript
import { useSessionContainerStore } from "@/features/sessions/session-container.store";
```

- [ ] **Step 11: 运行 typecheck 并修复错误**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS（可能需要几轮修复遗漏的 containerState 引用）

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src/pages/sessions/index.tsx
git commit -m "refactor(sessions): replace useState with Zustand store for container state"
```

---

### Task 5: Insights 页面接入新 store + debounced 后端查询

**Files:**
- Modify: `apps/desktop/src/pages/insights/index.tsx`

- [ ] **Step 1: 替换 store import**

将：
```typescript
const activeSessionIds = useSessionContainerFilterStore((s) => s.activeSessionIds);
const activeSessionSummaries = useSessionContainerFilterStore((s) => s.activeSessionSummaries);
```

替换为：
```typescript
const activeSessionIds = useSessionContainerStore((s) => s.activeSessionIds);
const activeSessionSummaries = useSessionContainerStore((s) => s.activeSessionSummaries);
```

- [ ] **Step 2: 添加 debounced sessionIds 驱动后端查询**

在 Insights 页面中添加 debounce hook：

```typescript
const debouncedSessionIds = useDebouncedValue(activeSessionIds, 5000);
```

修改后端查询的 queryKey 使用 debouncedSessionIds：

```typescript
const { data: backendData, isLoading } = useQuery({
  queryKey: ["insights", debouncedSessionIds, debouncedDomain, hostExact, excludedHosts],
  queryFn: () => invokeGetInsights(input),
  enabled: activeSessionIds.length > 0,
});
```

注意：如果项目中没有现成的 `useDebouncedValue` hook，需要创建一个简单实现：

```typescript
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
```

- [ ] **Step 3: 运行 typecheck**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/pages/insights/index.tsx
git commit -m "feat(insights): use Zustand store with debounced backend query"
```

---

### Task 6: 确认 bootstrap 不加载历史 session

**Files:**
- Read: `apps/desktop/src-tauri/src/bootstrap/mod.rs`

- [ ] **Step 1: 确认 init_from_db 中的 session 加载已移除**

检查 `init_from_db()` 函数中不再包含 `load_recent_summaries` 调用。此改动应已在之前的实施中完成。

如果仍有 `load_recent_summaries` 调用，删除它。

- [ ] **Step 2: Commit（如有改动）**

```bash
git add apps/desktop/src-tauri/src/bootstrap/mod.rs
git commit -m "chore(backend): remove historical session loading on startup"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 运行完整测试套件**

Run: `pnpm --filter @aiproxy/desktop test`
Expected: ALL PASS

- [ ] **Step 2: 运行 typecheck**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS

- [ ] **Step 3: 启动桌面端验证**

Run: `pnpm --filter @aiproxy/desktop dev`

验证清单：
1. App 启动后 Sessions 页面无历史数据
2. 开启代理 → Sessions 实时显示新请求
3. 切到 Insights → 显示实时数据且持续刷新
4. 切回 Sessions → 数据完整，不丢失
5. 停止代理再启动 → 旧数据清除，新数据从头累积
6. 后端 SQL 查询不会高频触发（5s debounce 生效）

- [ ] **Step 4: Final commit（如有遗漏修复）**

```bash
git add -A
git commit -m "fix: address review findings from e2e verification"
```
