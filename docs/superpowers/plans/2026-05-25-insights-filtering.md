# Insights Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session tab and domain filtering to the Insights page so it aggregates data only from the active session container's requests, with an optional host keyword filter.

**Architecture:** Backend filtering — pass `sessionIds` + `hostKeyword` to the Rust `compute_insights` function which adds SQL WHERE clauses. A lightweight zustand store bridges the active container's session IDs from the Sessions page to the Insights page.

**Tech Stack:** Rust (rusqlite), Tauri commands, TypeScript, React, Zustand, MUI, TanStack Query, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared-types/src/sessions.ts` | Modify | Add `GetInsightsInput` type and validator |
| `crates/db/src/insights.rs` | Modify | Add `InsightsFilter` struct, modify `compute_insights` to accept filter and build WHERE clauses |
| `apps/desktop/src-tauri/src/commands/sessions.rs` | Modify | `get_insights` accepts input struct |
| `apps/desktop/src/services/commands/sessions.ts` | Modify | `invokeGetInsights` accepts and passes input |
| `apps/desktop/src/features/sessions/session-container.store.ts` | Create | Zustand store holding active container sessionIds |
| `apps/desktop/src/pages/sessions/index.tsx` | Modify | Sync active container sessionIds to store |
| `apps/desktop/src/pages/insights/index.tsx` | Modify | Add domain filter UI, use store sessionIds, pass filter to query |
| `apps/desktop/src/i18n/messages/en.ts` | Modify | Add filter label strings |
| `apps/desktop/src/i18n/messages/zh-CN.ts` | Modify | Add filter label strings |

---

### Task 1: Add `GetInsightsInput` shared type

**Files:**
- Modify: `packages/shared-types/src/sessions.ts`

- [ ] **Step 1: Add the type and validator**

In `packages/shared-types/src/sessions.ts`, after the `SlowRequest` type (line 153) and before `isSessionSummary` (line 155), add:

```ts
export type GetInsightsInput = {
  sessionIds: string[];
  hostKeyword?: string;
};
```

Then add a runtime validator after `parseInsightsResult` (line 765):

```ts
export function isGetInsightsInput(value: unknown): value is GetInsightsInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<GetInsightsInput>;

  return (
    Array.isArray(candidate.sessionIds) &&
    candidate.sessionIds.every((id) => typeof id === "string") &&
    (candidate.hostKeyword === undefined || typeof candidate.hostKeyword === "string")
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `pnpm --filter @aiproxy/shared-types typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared-types/src/sessions.ts
git commit -m "feat(shared-types): add GetInsightsInput type for insights filtering"
```

---

### Task 2: Rust backend — add filter struct and modify `compute_insights`

**Files:**
- Modify: `crates/db/src/insights.rs`

- [ ] **Step 1: Write the complete rewritten file**

The changes to `crates/db/src/insights.rs` are:

1. Add `InsightsFilter` struct (after `SlowRequest`, before aggregation section)
2. Add `build_where` helper function using `Vec<rusqlite::types::Value>` for params
3. Change `compute_insights` signature to accept `&InsightsFilter`
4. Update every SQL query to use the dynamic WHERE clause
5. Update `compute_host_p95` to accept filter
6. Update existing tests to pass `&InsightsFilter::default()`
7. Add new filter tests

Add these structs after the `SlowRequest` definition (after line 58):

```rust
#[derive(Debug, Clone, Default)]
pub struct InsightsFilter {
    pub session_ids: Vec<String>,
    pub host_keyword: Option<String>,
}

fn build_where(filter: &InsightsFilter) -> (String, Vec<rusqlite::types::Value>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    let mut param_idx = 1;

    if !filter.session_ids.is_empty() {
        let placeholders: Vec<String> = filter
            .session_ids
            .iter()
            .map(|_| {
                let p = format!("?{param_idx}");
                param_idx += 1;
                p
            })
            .collect();
        conditions.push(format!("id IN ({})", placeholders.join(", ")));
        for id in &filter.session_ids {
            params.push(rusqlite::types::Value::Text(id.clone()));
        }
    }

    if let Some(ref keyword) = filter.host_keyword {
        let kw = keyword.to_lowercase();
        conditions.push(format!("LOWER(host) LIKE ?{param_idx}"));
        param_idx += 1;
        params.push(rusqlite::types::Value::Text(format!("%{kw}%")));
    }

    if conditions.is_empty() {
        (String::new(), params)
    } else {
        (format!(" WHERE {}", conditions.join(" AND ")), params)
    }
}
```

Replace the entire `compute_insights` function (lines 67-253) with:

```rust
pub fn compute_insights(conn: &Connection, filter: &InsightsFilter) -> Result<InsightsResult, String> {
    let (where_clause, where_params) = build_where(filter);
    let params = || -> Vec<rusqlite::types::Value> { where_params.clone() };

    // --- Overview stats ---
    let query = format!(
        "SELECT COUNT(*),
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END),
                AVG(duration_ms),
                SUM(size_bytes)
         FROM session_summaries{where_clause}"
    );
    let (total_requests, total_errors, avg_duration_ms, total_bytes) = conn
        .query_row(&query, rusqlite::params_from_iter(params()), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<f64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|e| format!("insights overview query: {e}"))?;

    let total_errors = total_errors.unwrap_or(0);
    let avg_duration_ms = avg_duration_ms.unwrap_or(0.0);
    let total_bytes = total_bytes.unwrap_or(0);
    let error_rate = if total_requests > 0 {
        total_errors as f64 / total_requests as f64
    } else {
        0.0
    };

    // --- Percentiles (compute in Rust by sorting durations) ---
    let p50_duration_ms;
    let p95_duration_ms;
    let p99_duration_ms;

    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT duration_ms FROM session_summaries{where_clause} ORDER BY duration_ms"
            ))
            .map_err(|e| format!("insights percentile prepare: {e}"))?;

        let durations: Vec<i64> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| row.get::<_, i64>(0))
            .map_err(|e| format!("insights percentile query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        p50_duration_ms = percentile(&durations, 50);
        p95_duration_ms = percentile(&durations, 95);
        p99_duration_ms = percentile(&durations, 99);
    }

    // --- By host (top 50) ---
    let by_host = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT host,
                        COUNT(*) AS request_count,
                        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
                        AVG(duration_ms) AS avg_duration_ms,
                        SUM(size_bytes) AS total_bytes
                 FROM session_summaries{where_clause}
                 GROUP BY host
                 ORDER BY request_count DESC
                 LIMIT 50"
            ))
            .map_err(|e| format!("insights by_host prepare: {e}"))?;

        let host_rows: Vec<HostInsightRaw> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(HostInsightRaw {
                    host: row.get("host")?,
                    request_count: row.get("request_count")?,
                    error_count: row.get::<_, Option<i64>>("error_count")?.unwrap_or(0),
                    avg_duration_ms: row.get::<_, Option<f64>>("avg_duration_ms")?.unwrap_or(0.0),
                    total_bytes: row.get::<_, Option<i64>>("total_bytes")?.unwrap_or(0),
                })
            })
            .map_err(|e| format!("insights by_host query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        let mut result = Vec::with_capacity(host_rows.len());
        for hr in &host_rows {
            let p95 = compute_host_p95(conn, &hr.host, filter);
            result.push(HostInsight {
                host: hr.host.clone(),
                request_count: hr.request_count,
                error_count: hr.error_count,
                avg_duration_ms: hr.avg_duration_ms,
                p95_duration_ms: p95,
                total_bytes: hr.total_bytes,
            });
        }
        result
    };

    // --- By status code ---
    let by_status_code: Vec<StatusCodeDistribution> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT status_code, COUNT(*) AS count
                 FROM session_summaries{where_clause}
                 GROUP BY status_code
                 ORDER BY count DESC"
            ))
            .map_err(|e| format!("insights by_status_code prepare: {e}"))?;

        let rows: Vec<StatusCodeDistribution> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(StatusCodeDistribution {
                    status_code: row.get("status_code")?,
                    count: row.get("count")?,
                })
            })
            .map_err(|e| format!("insights by_status_code query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    // --- By method ---
    let by_method: Vec<MethodDistribution> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT method, COUNT(*) AS count
                 FROM session_summaries{where_clause}
                 GROUP BY method
                 ORDER BY count DESC"
            ))
            .map_err(|e| format!("insights by_method prepare: {e}"))?;

        let rows: Vec<MethodDistribution> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(MethodDistribution {
                    method: row.get("method")?,
                    count: row.get("count")?,
                })
            })
            .map_err(|e| format!("insights by_method query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    // --- Slow requests (top 20) ---
    let slow_requests: Vec<SlowRequest> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, url, method, status_code, duration_ms
                 FROM session_summaries{where_clause}
                 ORDER BY duration_ms DESC
                 LIMIT 20"
            ))
            .map_err(|e| format!("insights slow_requests prepare: {e}"))?;

        let rows: Vec<SlowRequest> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(SlowRequest {
                    session_id: row.get("id")?,
                    url: row.get("url")?,
                    method: row.get("method")?,
                    status_code: row.get("status_code")?,
                    duration_ms: row.get("duration_ms")?,
                })
            })
            .map_err(|e| format!("insights slow_requests query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    Ok(InsightsResult {
        total_requests,
        total_errors,
        error_rate,
        avg_duration_ms,
        p50_duration_ms,
        p95_duration_ms,
        p99_duration_ms,
        total_bytes,
        by_host,
        by_status_code,
        by_method,
        slow_requests,
    })
}
```

Replace the `compute_host_p95` function with:

```rust
fn compute_host_p95(
    conn: &Connection,
    host: &str,
    filter: &InsightsFilter,
) -> f64 {
    let (where_clause, mut where_params) = build_where(filter);
    let host_param_idx = where_params.len() + 1;
    let query = format!(
        "SELECT duration_ms FROM session_summaries{where_clause}{}LOWER(host) = ?{host_param_idx} ORDER BY duration_ms",
        if where_clause.is_empty() { " WHERE " } else { " AND " }
    );
    where_params.push(rusqlite::types::Value::Text(host.to_lowercase()));

    let mut stmt = match conn.prepare(&query) {
        Ok(s) => s,
        Err(_) => return 0.0,
    };

    let result = stmt.query_map(rusqlite::params_from_iter(where_params), |row| row.get::<_, i64>(0));
    let durations: Vec<i64> = match result {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return 0.0,
    };

    percentile(&durations, 95)
}
```

- [ ] **Step 2: Update existing tests**

Update all existing test calls from `compute_insights(&conn)` to `compute_insights(&conn, &InsightsFilter::default())`. This applies to `empty_table_returns_zeros`, `aggregates_basic_stats`, and `percentile_nearest_rank`. Also update the import to include `InsightsFilter`.

- [ ] **Step 3: Add new filter tests**

Add these tests after `percentile_nearest_rank`:

```rust
#[test]
fn filter_by_session_ids() {
    let conn = test_conn();
    insert_session(&conn, "s1", "api.example.com", "GET", 200, 100, 500);
    insert_session(&conn, "s2", "api.example.com", "POST", 500, 200, 1000);
    insert_session(&conn, "s3", "cdn.example.com", "GET", 200, 50, 200);

    let filter = InsightsFilter {
        session_ids: vec!["s1".into(), "s3".into()],
        host_keyword: None,
    };
    let result = compute_insights(&conn, &filter).unwrap();

    assert_eq!(result.total_requests, 2);
    assert_eq!(result.total_errors, 0);
    assert_eq!(result.total_bytes, 700);
    assert_eq!(result.by_host.len(), 2);
}

#[test]
fn filter_by_host_keyword() {
    let conn = test_conn();
    insert_session(&conn, "s1", "api.example.com", "GET", 200, 100, 500);
    insert_session(&conn, "s2", "api.example.com", "POST", 500, 200, 1000);
    insert_session(&conn, "s3", "cdn.example.com", "GET", 200, 50, 200);

    let filter = InsightsFilter {
        session_ids: vec![],
        host_keyword: Some("API".into()),
    };
    let result = compute_insights(&conn, &filter).unwrap();

    assert_eq!(result.total_requests, 2);
    assert_eq!(result.total_errors, 1);
}

#[test]
fn filter_by_both() {
    let conn = test_conn();
    insert_session(&conn, "s1", "api.example.com", "GET", 200, 100, 500);
    insert_session(&conn, "s2", "api.example.com", "POST", 500, 200, 1000);
    insert_session(&conn, "s3", "cdn.example.com", "GET", 200, 50, 200);

    let filter = InsightsFilter {
        session_ids: vec!["s1".into(), "s2".into()],
        host_keyword: Some("cdn".into()),
    };
    let result = compute_insights(&conn, &filter).unwrap();

    assert_eq!(result.total_requests, 0);
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/jake/AI/AIProxy && cargo test -p aiproxy-db -- insights`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add crates/db/src/insights.rs
git commit -m "feat(db): add InsightsFilter to compute_insights with session ID and host filtering"
```

---

### Task 3: Update Tauri command to accept filter input

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/sessions.rs`

- [ ] **Step 1: Add the input struct and update `get_insights`**

In `apps/desktop/src-tauri/src/commands/sessions.rs`, add a serde-deserializable input struct before the `get_insights` function (before line 462):

```rust
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetInsightsInput {
    pub session_ids: Vec<String>,
    pub host_keyword: Option<String>,
}
```

Then replace the `get_insights` function (lines 462-471) with:

```rust
#[tauri::command]
pub async fn get_insights(
    state: State<'_, Arc<AppState>>,
    input: GetInsightsInput,
) -> Result<aiproxy_db::insights::InsightsResult, String> {
    let state = Arc::clone(state.inner());
    let filter = aiproxy_db::insights::InsightsFilter {
        session_ids: input.session_ids,
        host_keyword: input.host_keyword,
    };
    run_blocking_command("get_insights", move || {
        let conn = state.read_db_connection();
        let conn_guard = conn.lock().expect("db mutex should not be poisoned");
        aiproxy_db::insights::compute_insights(&conn_guard, &filter)
    })
    .await
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/jake/AI/AIProxy/apps/desktop/src-tauri && cargo check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/sessions.rs
git commit -m "feat(tauri): update get_insights command to accept filter input"
```

---

### Task 4: Update frontend service layer

**Files:**
- Modify: `apps/desktop/src/services/commands/sessions.ts`

- [ ] **Step 1: Update `invokeGetInsights` to accept input**

In `apps/desktop/src/services/commands/sessions.ts`, add `GetInsightsInput` to the existing shared-types import (find the line importing `InsightsResult` and add `GetInsightsInput`).

Then replace the `invokeGetInsights` function (lines 267-289) with:

```ts
export async function invokeGetInsights(input: GetInsightsInput): Promise<InsightsResult> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Insights requires the Tauri desktop runtime.",
    };
  }

  try {
    logDevDebug("ui.commands", "get_insights_requested", {
      sessionCount: input.sessionIds.length,
      hostKeyword: input.hostKeyword,
    });
    const payload = await invoke<unknown>("get_insights", { input });
    const result = parseInsightsResult(payload);

    logDevDebug("ui.commands", "get_insights_succeeded", {
      totalRequests: result.totalRequests,
    });

    return result;
  } catch (error) {
    reportCommandFailure("get_insights", error);
    throw coerceAppError(error);
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/services/commands/sessions.ts
git commit -m "feat(services): update invokeGetInsights to pass filter input"
```

---

### Task 5: Create zustand store for active container sessionIds

**Files:**
- Create: `apps/desktop/src/features/sessions/session-container.store.ts`

- [ ] **Step 1: Create the store**

Create `apps/desktop/src/features/sessions/session-container.store.ts`:

```ts
import { create } from "zustand";

export type SessionContainerFilterState = {
  activeSessionIds: string[];
  setActiveSessionIds: (ids: string[]) => void;
};

export const useSessionContainerFilterStore = create<SessionContainerFilterState>((set) => ({
  activeSessionIds: [],
  setActiveSessionIds: (ids) => set({ activeSessionIds: ids }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/features/sessions/session-container.store.ts
git commit -m "feat(sessions): add zustand store for active container session IDs"
```

---

### Task 6: Sync active container sessionIds from Sessions page

**Files:**
- Modify: `apps/desktop/src/pages/sessions/index.tsx`

- [ ] **Step 1: Import the store and add sync effect**

In `apps/desktop/src/pages/sessions/index.tsx`, add the import alongside the other `session-containers.helpers` imports:

```ts
import { useSessionContainerFilterStore } from "@/features/sessions/session-container.store";
```

Then, inside the `SessionsPage` component, after the `containerState` `useState` block (around line 116), add:

```ts
const setActiveSessionIds = useSessionContainerFilterStore((s) => s.setActiveSessionIds);

useEffect(() => {
  const activeContainer = getSessionContainerById(containerState, containerState.activeContainerId);
  setActiveSessionIds(activeContainer?.sessionIds ?? []);
}, [containerState, setActiveSessionIds]);
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/pages/sessions/index.tsx
git commit -m "feat(sessions): sync active container session IDs to shared store"
```

---

### Task 7: Add i18n strings for domain filter

**Files:**
- Modify: `apps/desktop/src/i18n/messages/en.ts`
- Modify: `apps/desktop/src/i18n/messages/zh-CN.ts`

- [ ] **Step 1: Add English strings**

In `apps/desktop/src/i18n/messages/en.ts`, in the `insightsPage` section, after the `states` block, add:

```ts
filter: {
  domainPlaceholder: "Filter by domain...",
},
```

- [ ] **Step 2: Add Chinese strings**

In `apps/desktop/src/i18n/messages/zh-CN.ts`, in the `insightsPage` section, after the `states` block, add:

```ts
filter: {
  domainPlaceholder: "按域名过滤...",
},
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/i18n/messages/en.ts apps/desktop/src/i18n/messages/zh-CN.ts
git commit -m "feat(i18n): add insights domain filter strings"
```

---

### Task 8: Update Insights page with filter UI and wired query

**Files:**
- Modify: `apps/desktop/src/pages/insights/index.tsx`

- [ ] **Step 1: Add imports**

Add these imports at the top of `apps/desktop/src/pages/insights/index.tsx`:

```ts
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { InputBase, inputBaseClasses } from "@mui/material";
```

Add `useMemo` to the existing React import line (it's not there currently).

Add:

```ts
import { useSessionContainerFilterStore } from "@/features/sessions/session-container.store";
```

- [ ] **Step 2: Add domain filter state and debounced value**

Inside the `InsightsPage` component, before the `useQuery` call (around line 199), add:

```ts
const activeSessionIds = useSessionContainerFilterStore((s) => s.activeSessionIds);
const [domainFilter, setDomainFilter] = useState("");
const [debouncedDomain, setDebouncedDomain] = useState("");
const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const handleDomainChange = useCallback((value: string) => {
  setDomainFilter(value);
  if (debounceTimerRef.current) {
    clearTimeout(debounceTimerRef.current);
  }
  debounceTimerRef.current = setTimeout(() => {
    setDebouncedDomain(value);
  }, 300);
}, []);

useEffect(() => {
  return () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
  };
}, []);
```

- [ ] **Step 3: Update the useQuery call**

Replace the existing `useQuery` (lines 199-202):

```ts
const { data, isLoading } = useQuery({
  queryKey: ["insights"],
  queryFn: () => invokeGetInsights(),
});
```

with:

```ts
const input = useMemo(() => ({
  sessionIds: activeSessionIds,
  hostKeyword: debouncedDomain || undefined,
}), [activeSessionIds, debouncedDomain]);

const { data, isLoading } = useQuery({
  queryKey: ["insights", activeSessionIds, debouncedDomain],
  queryFn: () => invokeGetInsights(input),
  enabled: activeSessionIds.length > 0,
});
```

- [ ] **Step 4: Add domain filter input UI**

Right after the `<Stack spacing={0.375}>` that wraps the main content (line 291), before the `<Paper>` element, add:

```tsx
<Stack direction="row" sx={{ mb: 0.5 }}>
  <InputBase
    startAdornment={
      <SearchRoundedIcon sx={{ color: "text.secondary", fontSize: 18, mr: 0.75 }} />
    }
    placeholder={t("insightsPage.filter.domainPlaceholder")}
    value={domainFilter}
    onChange={(e) => handleDomainChange(e.target.value)}
    sx={(theme) => ({
      bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.94 : 0.98),
      border: "1px solid",
      borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
      borderRadius: 1,
      px: 1.25,
      py: 0.5,
      fontSize: 13,
      flex: 1,
      maxWidth: 320,
      [`& .${inputBaseClasses.input}`]: {
        p: 0,
      },
    })}
  />
</Stack>
```

- [ ] **Step 5: Handle empty session IDs case**

Replace the `isLoading` check (lines 260-274) with a combined loading/no-sessions check:

```tsx
if (isLoading || activeSessionIds.length === 0) {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={1.5}
      sx={{ height: "100%", minHeight: 240 }}
    >
      <CircularProgress size={24} />
      <Typography color="text.secondary" sx={{ fontSize: 13 }}>
        {t("insightsPage.states.loading")}
      </Typography>
    </Stack>
  );
}
```

- [ ] **Step 6: Verify it compiles**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/pages/insights/index.tsx
git commit -m "feat(insights): add session tab and domain filtering to Insights page"
```

---

### Task 9: Add frontend tests

**Files:**
- Create: `apps/desktop/src/features/sessions/session-container.store.test.ts`

- [ ] **Step 1: Write test for filter store**

Create `apps/desktop/src/features/sessions/session-container.store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useSessionContainerFilterStore } from "./session-container.store";

describe("SessionContainerFilterStore", () => {
  beforeEach(() => {
    useSessionContainerFilterStore.setState({ activeSessionIds: [] });
  });

  it("starts with empty session IDs", () => {
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual([]);
  });

  it("sets active session IDs", () => {
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s1", "s2"]);
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual(["s1", "s2"]);
  });

  it("replaces active session IDs", () => {
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s1"]);
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s3", "s4"]);
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual(["s3", "s4"]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @aiproxy/desktop test -- --run session-container.store`
Expected: All 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/sessions/session-container.store.test.ts
git commit -m "test(sessions): add tests for session container filter store"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run full lint**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Run Rust tests**

Run: `cargo test -p aiproxy-db`
Expected: PASS
