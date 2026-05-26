# Insights 实时数据与 Session Store 统一

## Context

Insights 页面默认聚合数据库中所有 15,000 条历史 session，显示"固定"的统计数据。根本原因：

1. **历史 session 加载**：App 启动时 `init_from_db()` 从 SQLite 加载 15,000 条 session 到内存
2. **事件监听器位置错误**：`session-upsert` 监听器在 Sessions 页面组件内，页面卸载（切到 Insights）后无人接收新数据
3. **组件本地状态**：`containerState` 是 `useState`，页面卸载后丢失

用户期望：不保存历史数据，代理运行期间 Sessions 和 Insights 实时同步，切页面不丢数据。

## 方案

将 `SessionContainerState` 从 Sessions 页面的 `useState` 提升到 Zustand store，并在 AppShell 层注册全局 `session-upsert` 事件监听器。

### 数据流

```
代理抓包 → session-upsert 事件 → AppShell 全局监听器 → Zustand store
                                                              ↓
                                              Sessions 页面 ← store → Insights 页面
```

## 改动清单

### 1. `session-container.store.ts` — 重写

吸收 `SessionContainerState` 所有字段，将 `session-containers.helpers.ts` 的纯函数包装为 store actions，派生 `activeSessionIds`/`activeSessionSummaries`。

Store 结构：

```typescript
interface SessionContainerStore {
  // 原 SessionContainerState 字段
  activeContainerId: string;
  containers: SessionContainer[];
  hydrated: boolean;
  nextContainerNumber: number;
  sessionOwnerById: Record<string, string>;
  sessionSummaryById: Record<string, SessionSummary>;

  // 派生字段（替代原 sessionContainerFilterStore）
  activeSessionIds: string[];
  activeSessionSummaries: SessionSummary[];

  // Actions（包装 helpers 纯函数）
  init: (options?) => void;                          // createInitialSessionContainerState
  seedSessions: (sessions: SessionSummary[]) => void; // seedSessionContainers
  upsertSummary: (summary: SessionSummary) => void;  // upsertSessionContainerSummary
  removeSummary: (sessionId: string) => void;         // removeSessionContainerSummary
  addContainer: () => void;                            // createAdditionalSessionContainer
  closeContainer: (containerId: string) => void;      // closeSessionContainer
  selectContainer: (containerId: string) => void;     // setActiveSessionContainer
  updateActiveContainer: (updater) => void;            // updateActiveSessionContainer
  clearSessions: () => void;                           // createInitialSessionContainerState (reset)
  clearOtherSessions: (keepId: string) => void;       // clearOtherSessionsInActiveContainer
}
```

每个 action 内部直接调用现有 helper：

```typescript
upsertSummary: (summary) => set((state) => {
  const next = upsertSessionContainerSummary(state, summary);
  return { ...next, ...deriveActiveData(next) };
}),
```

`deriveActiveData` 从 container state 计算 `activeSessionIds` 和 `activeSessionSummaries`，替代原来 Sessions 页面的 useEffect 同步逻辑。

### 2. 新增 `use-session-events.ts` — 全局事件监听 hook

在 AppShell 层调用，100ms upsert buffer 保留，同时更新 React Query 缓存。

```typescript
export function useSessionEvents() {
  const store = useSessionContainerStore;
  const queryClient = useQueryClient();

  useEffect(() => {
    let upsertBuffer: SessionSummary[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flush() { /* 批量调用 store.upsertSummary + queryClient.setQueryData */ }

    const unlistenFns = [];
    // listen('session-upsert', ...)
    // listen('session-remove', ...)
    // listen('sessions-cleared', ...)
    // listen('sessions-removed', ...)
    return () => { /* cleanup */ };
  }, []);
}
```

### 3. `AppShell.tsx` — 调用全局 hook

在 AppShell 组件内加一行：

```typescript
useSessionEvents();
```

### 4. `sessions/index.tsx` — 去掉 useState 和页面级事件监听

- 删除 `const [containerState, setContainerState] = useState(...)`
- 所有 `containerState.xxx` 改为从 store 读取
- 所有 `setContainerState(prev => helper(prev, ...))` 改为 `store.xxx(...)`
- 删除页面级的 `session-upsert/remove/cleared` 事件监听 useEffect
- 保留 `seedSessions` 的 hydration 逻辑（从 `useSessions()` 缓存初始化 store）
- 保留 `session-scope-registry` 同步逻辑

### 5. `insights/index.tsx` — 已读 store，无需大改

保留 `enabled: activeSessionIds.length > 0` guard。

### 6. `bootstrap/mod.rs` — 已改（不加载历史 session）

保持当前改动：`init_from_db()` 不再调用 `load_recent_summaries`。

## 性能优化：Insights 双层数据源

代理活跃时 100ms buffer flush 会导致 `activeSessionIds` 每 100ms 变化一次。如果直接用做 React Query key，后端 SQL 聚合查询会以 ~10次/秒 的频率触发，浪费资源。

**解法：客户端 fallback 负责实时刷新，后端查询 debounced。**

```text
代理运行 → 100ms flush → store 更新
                         ├→ computeInsightsFromSummaries (客户端，每 100ms，实时展示)
                         └→ invokeGetInsights (debounced ~5s，提供精确 SQL 百分位)
```

Insights 页面改动：

```typescript
// 用 debounced 版本的 activeSessionIds 驱动后端查询
const debouncedSessionIds = useDebouncedValue(activeSessionIds, 5000);

const { data: backendData, isLoading } = useQuery({
  queryKey: ["insights", debouncedSessionIds, debouncedDomain, hostExact, excludedHosts],
  queryFn: () => invokeGetInsights(input),
  enabled: activeSessionIds.length > 0,
});

// 数据优先级不变：backendData > fallbackData
```

客户端 `computeInsightsFromSummaries` 对 `activeSessionSummaries` 的变化即时响应（无 debounce），保证 UI 实时刷新。后端查询低频更新，提供更精确的百分位计算结果。

## 不改动的文件

- `session-containers.helpers.ts` — 纯函数，store 直接调用
- `crates/db/src/insights.rs` — 后端查询逻辑不变
- `insights.rs` 的 `build_where` — 前端 `enabled` guard 已阻止空 ID 查询

## 验证

1. 启动桌面端 → Sessions 和 Insights 均无历史数据
2. 开启代理 → Sessions 实时显示新请求
3. 切到 Insights → 显示实时数据且持续刷新
4. 切回 Sessions → 数据完整，不丢失
5. 停止代理再启动 → 旧数据清除，新数据从头累积
6. `pnpm --filter @aiproxy/desktop test` 通过
