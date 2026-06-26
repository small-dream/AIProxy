# Bug 审计修复计划 — Phase 1（安全 + 前端核心功能失效）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 BUG_AUDIT_2026-06-27.md 第一批（S1/S2/H1/H2/H8）共 5 个高危/安全问题，恢复节流规则编辑、环境变量编辑等核心功能并收紧安全边界。

**Architecture:** 每个修复用 TDD：先写失败测试（行为级），再改最小实现。前端 React 副作用 bug 采用「提取纯判定函数 + 薄 effect」策略，让逻辑可单测、副作用可控。Rust 侧新增权限/校验在现有 `#[cfg(test)] mod tests` 内补测。

**Tech Stack:** Rust 2021 / rusqlite / rustls；React 19 + TypeScript + Vitest + @testing-library/react + TanStack Query。

## Global Constraints

（摘自 CLAUDE.md，所有 task 隐含遵守）
- 与用户沟通用中文；代码注释用英文。
- 跨平台：Windows / macOS / Linux 三平台都要处理或给 fallback；平台特定代码用 `#[cfg(target_os=...)]`。
- 用户可见文案禁止硬编码，必须同步 `i18n/messages/en.ts` 与 `zh-CN.ts`（本批无新增 UI 文案）。
- 不留空 catch；错误需带上下文。
- 命令：`pnpm --filter @aiproxy/desktop test|lint|typecheck`；`cargo test -p <crate>`。
- 提交粒度：每个 task 一次提交，message 用英文 conventional commits，结尾空行加 `Co-Authored-By: Claude <noreply@anthropic.com>`。

## 总体路线图（37 问题分 6 Phase）

本文件详述 **Phase 1**。后续 Phase 完成验证后各自再出 bite-sized 计划。

| Phase | 范围 | 条目 | 验证 |
|---|---|---|---|
| **1（本文件）** | 安全 + 前端核心功能失效 | S1, S2, H1, H2, H8 | Rust test + vitest + typecheck |
| 2 | Rust 网络层超时/泄漏/协议 | H3, H4, H5, H6, H7, H9, H10, M4 | cargo test --workspace |
| 3 | rule-engine + db 一致性 | M1, M2, M3, M5, M6, M7 | cargo test |
| 4 | 前端列表/状态机 | M9, M10, M11, M12 | vitest + typecheck |
| 5 | 低危 | L1, L2, L3, L5, L6, L7, L8, L9, L10, L11, L12 | 相关 test + lint |
| 6 | 待实测（需目标平台） | N1(Windows), N2(Linux) | 仅做低风险防御性改动 + 标注需实测；M8 单位语义并入 |

注：L4 已撤销（误报）；N1/N2 在 macOS 无法安全验证，Phase 6 只做「把 param 移到首行」之类零风险防御改动并显式标注「需 Windows/Linux 实测」，不臆断修复。

---

## Task 1: S1 — 收紧根 CA 私钥文件权限至 0600

**Files:**
- Modify: `crates/tls-manager/src/storage.rs:139-159`（`save_root_cert`；目录创建改 `DirBuilder`）
- Modify: `crates/tls-manager/src/storage.rs:202-265`（`mod tests` 新增测试）
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces:** 无新公开 API；`save_root_cert` 签名不变。

- [ ] **Step 1: 写失败测试（追加到 `mod tests`）**

```rust
    #[cfg(unix)]
    #[test]
    fn root_key_file_has_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        let mode = std::fs::metadata(storage.root_key_path())
            .expect("root key file exists")
            .permissions()
            .mode();
        // Group and other must have no permissions on the private key.
        assert_eq!(
            mode & 0o077,
            0,
            "root key must not be accessible by group/other (mode={mode:o})"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cert_dir_created_with_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let storage = CertStorage::new_in_temp_dir();
        let root_ca = RootCaPair::generate().unwrap();
        storage
            .save_root_cert(root_ca.cert_pem(), root_ca.key_pem())
            .unwrap();
        let dir_mode = std::fs::metadata(storage.cert_dir())
            .expect("cert dir exists")
            .permissions()
            .mode();
        assert_eq!(
            dir_mode & 0o077,
            0,
            "cert dir must not be accessible by group/other (mode={dir_mode:o})"
        );
    }
```

> 若 `root_key_path()` / `cert_dir()` 不是 public accessor，Step 3 会顺带补 accessor（见下）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p aiproxy-tls-manager root_key_file_has_restricted_permissions cert_dir_created_with_restricted_permissions`
Expected: FAIL（当前 `std::fs::write` 受 umask 影响，`mode & 0o077` 非零）。

- [ ] **Step 3: 改 `save_root_cert` 收紧权限**

把 `storage.rs:139-153` 的目录创建与 key 写入改为：

```rust
        // Create cert dir with 0700 on unix to keep the private key private.
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder
                .create(&self.cert_dir)
                .map_err(|e| TlsManagerError::StorageError(format!("failed to create cert dir: {e}")))?;
        }
        #[cfg(not(unix))]
        {
            std::fs::create_dir_all(&self.cert_dir).map_err(|e| {
                TlsManagerError::StorageError(format!("failed to create cert dir: {e}"))
            })?;
        }

        std::fs::write(&self.root_cert_path, cert_pem).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to write root cert: {e}"))
        })?;

        std::fs::write(&self.root_cert_install_path, cert_pem).map_err(|e| {
            TlsManagerError::StorageError(format!("failed to write installable root cert: {e}"))
        })?;

        std::fs::write(&self.root_key_path, key_pem)
            .map_err(|e| TlsManagerError::StorageError(format!("failed to write root key: {e}")))?;

        // Restrict the private key to the current user (0600 on unix).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.root_key_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| {
                    TlsManagerError::StorageError(format!("failed to restrict root key perms: {e}"))
                })?;
        }
```

> 若 `root_key_path` / `cert_dir` 字段为私有且测试需要，新增 `pub fn root_key_path(&self) -> &Path { &self.root_key_path }` 与 `pub fn cert_dir(&self) -> &Path { &self.cert_dir }`（若已存在则跳过）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p aiproxy-tls-manager`
Expected: PASS（含新测试 + 既有测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add crates/tls-manager/src/storage.rs
git commit -m "fix(tls): restrict root CA private key permissions to 0600 (S1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: S2 — `save_text_file` 校验纯 basename，防路径穿越

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/files.rs:18-34`（新增 `validate_export_basename` + 在 `save_text_file` 调用）
- Test: 同文件新增 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `fn validate_export_basename(name: &str) -> Result<&str, String>`（纯函数，供 `save_text_file` 与测试使用）

- [ ] **Step 1: 写失败测试（新增 test 模块到 `files.rs` 末尾）**

```rust
#[cfg(test)]
mod tests {
    use super::validate_export_basename;

    #[test]
    fn accepts_plain_basename() {
        assert_eq!(validate_export_basename("export.har").unwrap(), "export.har");
        assert_eq!(validate_export_basename("session (1).json").unwrap(), "session (1).json");
    }

    #[test]
    fn rejects_empty_and_dot_segments() {
        assert!(validate_export_basename("").is_err());
        assert!(validate_export_basename(".").is_err());
        assert!(validate_export_basename("..").is_err());
        assert!(validate_export_basename(" ").is_err());
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_export_basename("../foo.txt").is_err());
        assert!(validate_export_basename("a/../b.txt").is_err());
        assert!(validate_export_basename("sub/dir/foo.txt").is_err());
        assert!(validate_export_basename("a\\b.txt").is_err());
        assert!(validate_export_basename("\\\\host\\share\\f").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(validate_export_basename("/etc/passwd").is_err());
        assert!(validate_export_basename("C:\\Users\\x").is_err());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p aiproxy-desktop validate_export_basename`（若 crate 名不同，用 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml validate_export_basename`）
Expected: FAIL（函数未定义）。

- [ ] **Step 3: 实现 `validate_export_basename` 并在 `save_text_file` 调用**

在 `files.rs` 顶部 imports 后、`save_text_file` 前新增：

```rust
/// Validate that `name` is a plain file basename safe to join under the
/// Downloads directory. Rejects path separators, `..`/`.` segments, and
/// absolute paths so a hostile/broken caller cannot escape Downloads.
/// Returns the validated name for convenience.
fn validate_export_basename(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("file name must not be empty".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("file name must not be a dot segment".to_string());
    }
    // Reject anything that Path would interpret as a separator or traversal.
    // We check the raw string (not just std::path::Component) so behavior is
    // identical on every platform: a backslash is rejected on unix too.
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("file name must not contain path separators".to_string());
    }
    let path = std::path::Path::new(trimmed);
    if path.is_absolute() {
        return Err("file name must not be an absolute path".to_string());
    }
    if path.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
        )
    }) {
        return Err("file name must be a plain file name".to_string());
    }
    Ok(trimmed)
}
```

把 `save_text_file`（:19-22）改为先校验：

```rust
pub fn save_text_file(input: SaveTextFileInput, app: tauri::AppHandle) -> Result<String, String> {
    let safe_name = validate_export_basename(&input.file_name)?;
    let downloads_dir = dirs::download_dir()
        .ok_or_else(|| "Unable to locate the Downloads directory.".to_string())?;
    let target_path = next_available_export_path(&downloads_dir, safe_name);
    // ...（其余不变）
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml validate_export_basename`
Expected: PASS（4 个测试全过）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src-tauri/src/commands/files.rs
git commit -m "fix(commands): validate export basename in save_text_file to prevent path traversal (S2)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: H1 + H2 — 节流草稿按 selectedId 同步，避免引用刷新覆盖 + 修复复制规则

**Files:**
- Modify: `apps/desktop/src/features/throttling/use-throttle-editor.ts:179-197`（profile/rule 草稿同步 effect 改为按 id 变化）
- Modify: `apps/desktop/src/features/throttling/use-throttle-editor.ts`（新增 `duplicateRule` 动作；`selectRule` 辅助）
- Modify: `apps/desktop/src/features/throttling/components/RuleEditor.tsx:154-156`（复制按钮调用 `duplicateRule`）
- Test: Create: `apps/desktop/src/features/throttling/use-throttle-editor.test.tsx`

**Interfaces:**
- Produces: hook 额外返回 `duplicateRule: (rule: ThrottleRule) => void`

**核心思路**：用 `useRef` 记录上一次同步过的 `selectedRuleId`/`selectedProfileId`，仅在 id 变化时 `setXxxDraft`，使 `rules`/`profiles` 引用刷新（TanStack Query refetch）不再覆盖正在编辑的草稿。

- [ ] **Step 1: 写失败测试**

Create `apps/desktop/src/features/throttling/use-throttle-editor.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { useThrottleEditor } from "./use-throttle-editor";

// Mock the query/mutation hooks so we control data identity.
const rulesState = { current: [{ id: "r1", name: "R1", profileId: "p1", urlPattern: "*", enabled: true, priority: 100, methods: [], stage: "both", note: "", workspaceId: "default" }] };
const profilesState = { current: [{ id: "p1", name: "P1", workspaceId: "default", latencyMs: 0, uploadKbps: 1, downloadKbps: 1, packetLossRatio: 0, enabled: false, preset: false, note: "" }] };

vi.mock("./use-throttle-profiles", () => ({
  useThrottleProfiles: () => ({ data: profilesState.current, isError: false }),
  useThrottleRules: () => ({ data: rulesState.current, isError: false }),
  useThrottleRuntimeStats: () => ({ data: undefined }),
  useSaveThrottleProfile: () => ({ mutate: vi.fn() }),
  useSaveThrottleRule: () => ({ mutate: vi.fn() }),
  useDeleteThrottleRule: () => ({ mutate: vi.fn() }),
  useSetActiveThrottleProfile: () => ({ mutate: vi.fn() }),
}));

function createWrapper() {
  const queryClient = new QueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  rulesState.current = [{ id: "r1", name: "R1", profileId: "p1", urlPattern: "*", enabled: true, priority: 100, methods: [], stage: "both", note: "", workspaceId: "default" }];
});

describe("useThrottleEditor draft sync", () => {
  it("does not overwrite an edited rule draft when rules refetch with a new array identity (H1)", () => {
    const { result } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });

    // Select r1, then edit its name.
    act(() => result.current.selectRule?.(rulesState.current[0]));
    act(() => result.current.updateRuleDraft?.({ ...result.current.ruleDraft!, name: "EDITED" }));
    expect(result.current.ruleDraft?.name).toBe("EDITED");

    // Simulate TanStack Query refetch: brand-new array/object identity, same id.
    act(() => {
      rulesState.current = [{ ...rulesState.current[0], name: "R1" }];
    });

    // Re-render (new identity flows in). Draft must stay edited.
    expect(result.current.ruleDraft?.name).toBe("EDITED");
  });

  it("duplicateRule selects the new rule id so the copy survives (H2)", () => {
    const { result } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });
    act(() => result.current.selectRule?.(rulesState.current[0]));
    const before = result.current.ruleDraft!.id;
    act(() => result.current.duplicateRule?.(result.current.ruleDraft!));
    expect(result.current.selectedRuleId).not.toBe(before);
    expect(result.current.ruleDraft?.id).not.toBe(before);
  });
});
```

> 注：测试假设 hook 已暴露 `selectRule` / `updateRuleDraft` / `duplicateRule`。若当前 `selectRule` 不存在，Step 3 一并补齐（见 Interfaces）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aiproxy/desktop test use-throttle-editor`
Expected: FAIL（编辑后被覆盖 / `duplicateRule` 未定义）。

- [ ] **Step 3: 改 effect 按 id 同步 + 新增 `duplicateRule`/`selectRule`/`updateRuleDraft`**

在 `useThrottleEditor` 内（`useState` 区域附近）新增 ref：

```ts
  const lastSyncedRuleIdRef = useRef<string | undefined>(undefined);
  const lastSyncedProfileIdRef = useRef<string | undefined>(undefined);
```

把 profile 草稿 effect（原 :179-185）替换为「仅 id 变化时同步」：

```ts
  useEffect(() => {
    if (mode !== "profiles") return;
    if (lastSyncedProfileIdRef.current === selectedProfileId) return;
    lastSyncedProfileIdRef.current = selectedProfileId;
    if (selectedProfile) {
      setProfileDraft(selectedProfile);
      setValidationAttempted(false);
    }
  }, [mode, selectedProfileId, selectedProfile]);
```

把 rule 草稿 effect（原 :187-197）替换为：

```ts
  useEffect(() => {
    // Only sync from server value when the selection actually changes —
    // NOT on every rules[] refetch (new identity). This protects in-flight
    // edits from being clobbered (H1).
    if (lastSyncedRuleIdRef.current === selectedRuleId) return;
    lastSyncedRuleIdRef.current = selectedRuleId;
    if (selectedRule) {
      setRuleDraft(selectedRule);
    } else if (rules[0]) {
      setSelectedRuleId(rules[0].id);
    }
  }, [selectedRuleId, selectedRule, rules]);
```

> 去掉原 effect 依赖里的 `ruleDraft` / `profileDraft`。注意：选择新规则后用户编辑不被覆盖；显式 `selectRule(id)` 会先把 ref 设为新 id 再 set draft。

新增/补齐动作（放在 Actions 区，紧邻 `selectProfile`）：

```ts
  function selectRule(rule: ThrottleRule) {
    setMode("rules");
    setSelectedRuleId(rule.id);
    setRuleDraft(rule);
    setValidationAttempted(false);
  }

  function updateRuleDraft(next: ThrottleRule) {
    setRuleDraft(next);
  }

  function duplicateRule(rule: ThrottleRule) {
    const copy: ThrottleRule = {
      ...rule,
      id: crypto.randomUUID(),
      name: `${rule.name} copy`,
    };
    setMode("rules");
    setSelectedRuleId(copy.id);
    setRuleDraft(copy);
    setValidationAttempted(false);
  }
```

并在 hook 返回对象里加入 `selectRule`、`updateRuleDraft`、`duplicateRule`。

- [ ] **Step 4: 改 `RuleEditor.tsx` 复制按钮**

把 `RuleEditor.tsx:154-156` 的复制 `onChange` 改为调用 `duplicateRule`（从 props/hook 取）：

```tsx
  // before: onChange({ id: crypto.randomUUID(), name: `${ruleDraft.name} copy` })
  onDuplicate={() => duplicateRule(ruleDraft)}
```

（具体取 `duplicateRule` 的方式：若 `RuleEditor` 已通过 `useThrottleEditor` 拿到则直接用；否则从父组件透传。按现有 props 注入模式处理。）

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aiproxy/desktop test use-throttle-editor`
Expected: PASS。

- [ ] **Step 6: typecheck + lint**

Run: `pnpm --filter @aiproxy/desktop typecheck && pnpm --filter @aiproxy/desktop lint`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/src/features/throttling/
git commit -m "fix(throttling): sync rule/profile draft only on id change; fix duplicate rule (H1/H2)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: H8 — 切换环境时 flush 上一环境未保存的变量编辑

**Files:**
- Modify: `apps/desktop/src/features/environments/components/EnvironmentManagerDialog.tsx:66-123`（切换 `selectedEnvId` 时 flush/clear pending debounce timer）
- Test: Create: `apps/desktop/src/features/environments/EnvironmentManagerDialog.test.tsx`

**核心思路**：在 `selectedEnvId` 变化的 effect 里，变化前先 flush（或清除）`envSaveTimeoutRef` / `globalSaveTimeoutRef`，避免旧环境的 pending timer 被新环境编辑 `clearTimeout` 后丢失。优先 flush（立即保存旧环境）以保数据。

- [ ] **Step 1: 写失败测试**

Create `apps/desktop/src/features/environments/EnvironmentManagerDialog.test.tsx`（骨架，mock 依赖 hooks；hook 名以实际 import 为准，执行时核对）：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setEnvVarsMock = vi.fn();
const envVarsByEnv: Record<string, unknown[]> = { envA: [], envB: [] };

vi.mock("@/services/commands/environments", () => ({
  useEnvironmentVariables: (envId?: string) => ({ data: envId ? envVarsByEnv[envId] : undefined }),
  useSetEnvironmentVariables: () => ({ mutate: setEnvVarsMock }),
  // ...按实际 import 补齐其余 hook（global vars / list / mutations）
}));

function renderDialog(props: { open: boolean; selectedEnvId: string }) {
  // 按组件实际 props 渲染；若 selectedEnvId 来自内部状态，用 wrapper 控制
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}><EnvironmentManagerDialog {...props} /></QueryClientProvider>,
  );
}

describe("EnvironmentManagerDialog env switch (H8)", () => {
  beforeEach(() => { setEnvVarsMock.mockClear(); });

  it("flushes pending edits to the previous env when switching (does not drop them)", () => {
    vi.useFakeTimers();
    const { rerender } = renderDialog({ open: true, selectedEnvId: "envA" });
    // edit a variable in envA (triggers 500ms debounced save)
    fireEvent.change(screen.getByLabelText(/key/i), { target: { value: "X" } });
    // switch to envB before the 500ms timer fires
    act(() => {
      rerender(<Wrap selectedEnvId="envB" />);
    });
    // flushing on switch must have saved envA's edit
    expect(setEnvVarsMock).toHaveBeenCalledWith(expect.objectContaining({ environmentId: "envA" }));
    vi.useRealTimers();
  });
});
```

> 说明：组件 prop 形态、依赖 hook 名、label 文案以实际代码为准。执行此 task 的 worker 须先读 `EnvironmentManagerDialog.tsx` 顶部 import 与 props，对齐 mock 与渲染方式。测试目的是锁定行为：**切换环境触发对旧环境的 flush**。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aiproxy/desktop test EnvironmentManagerDialog`
Expected: FAIL（切换时未 flush，`setEnvVarsMock` 未被调用）。

- [ ] **Step 3: 在 `selectedEnvId` 变化时 flush**

在 `EnvironmentManagerDialog.tsx` 现有 `envVarsQuery.data` effect（:66-78）之前，新增一个「环境切换 flush」effect。需把当前 pending 的变量快照捕获——最稳妥是：在 ref 里维护「最近一次入参的 variables + envId」，切换时立即用该快照 mutate：

```ts
  // Track the latest pending (envId, variables) so an environment switch
  // can flush them immediately instead of being cleared by the new env's edit.
  const pendingEnvSaveRef = useRef<{ envId: string; variables: VariableRow[] } | null>(null);

  const debouncedSaveEnvVars = useCallback(
    (variables: VariableRow[]) => {
      if (envSaveTimeoutRef.current) clearTimeout(envSaveTimeoutRef.current);
      if (selectedEnvId) pendingEnvSaveRef.current = { envId: selectedEnvId, variables };
      envSaveTimeoutRef.current = setTimeout(() => {
        if (selectedEnvId) {
          setEnvVars.mutate({ environmentId: selectedEnvId, variables: variables.map(...) });
          pendingEnvSaveRef.current = null;
        }
      }, 500);
    },
    [selectedEnvId, setEnvVars],
  );

  // Flush pending edits to the previous environment on switch (H8).
  const prevEnvIdRef = useRef<string | undefined>(selectedEnvId);
  useEffect(() => {
    if (prevEnvIdRef.current !== selectedEnvId) {
      const pending = pendingEnvSaveRef.current;
      if (pending && envSaveTimeoutRef.current) {
        clearTimeout(envSaveTimeoutRef.current);
        envSaveTimeoutRef.current = null;
        setEnvVars.mutate({
          environmentId: pending.envId,
          variables: pending.variables.map((v, i) => ({ id: v.id, key: v.key, value: v.value, enabled: v.enabled, sortOrder: i })),
        });
        pendingEnvSaveRef.current = null;
      }
      prevEnvIdRef.current = selectedEnvId;
    }
  }, [selectedEnvId, setEnvVars]);
```

> global vars 同理：新增 `pendingGlobalSaveRef` + 对应 flush 逻辑（若 global vars 也随 env 切换丢失）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aiproxy/desktop test EnvironmentManagerDialog`
Expected: PASS。

- [ ] **Step 5: typecheck + lint**

Run: `pnpm --filter @aiproxy/desktop typecheck && pnpm --filter @aiproxy/desktop lint`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/features/environments/
git commit -m "fix(environments): flush pending variable edits when switching environment (H8)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 1 收尾验证

- [ ] `cargo test -p aiproxy-tls-manager`
- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- [ ] `pnpm --filter @aiproxy/desktop test`
- [ ] `pnpm --filter @aiproxy/desktop typecheck && pnpm --filter @aiproxy/desktop lint`

全部通过后，更新 `docs/BUG_AUDIT_2026-06-27.md`：在 S1/S2/H1/H2/H8 条目标题加 `✅ 已修复（<commit>）`，并把文档状态行推进到反映 Phase 1 完成的版本。随后进入 Phase 2 计划。
