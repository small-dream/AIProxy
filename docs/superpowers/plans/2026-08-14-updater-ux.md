# Software-Update UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn software-update discovery from "user must go look" into "update finds the user, non-intrusively" — a red-dot badge on the Settings nav, a changelog-bearing UpdateDialog, auto-check on startup, all backed by a shared store.

**Architecture:** Extend `useAppShellStore` with ephemeral update state (`availableUpdate` / `isChecking` / `isInstalling` / `updateProgress` / `isUpdateDialogOpen`). AppShell runs a silent `checkForAppUpdate()` on mount → fills the store. ActivityBar shows a red dot on Settings when `availableUpdate` is set; clicking it opens `UpdateDialog` (version + changelog + Update now / Later + progress). Menu "Check for Updates..." opens the same dialog. `UpdatesSection` subscribes to the store. `release.yml` writes git-commit changelog into `latest.json` `notes`.

**Tech Stack:** React 19, TypeScript, Zustand, MUI (Dialog/Badge/Box), Vitest + Testing Library, Tauri updater plugin, GitHub Actions.

## Global Constraints

- i18n 双语:新增 key 必须同时加 `en.ts` 和 `zh-CN.ts`
- 不动 Rust / `packages/shared-types` / Tauri 命令 / updater 后端 / 签名链路 / pubkey
- 不加自动轮询(仅启动检查一次)、不做后台预下载、不持久化 dismiss
- 每个前端 task 提交前跑四件套:`format:check` + `typecheck` + `lint` + 相关 `test`
- 提交信息 conventional commits,结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`
- `@tauri-apps/plugin-updater` 的 `check`/`downloadAndInstall` 在非 Tauri(浏览器/jest)抛错,测试须 mock `@/services/updater/app-updater`

## File Structure

- **Modify** `apps/desktop/src/app/store/app-shell.store.ts` — add update state slice
- **Create** `apps/desktop/src/features/updater/UpdateDialog.tsx` — the dialog component
- **Create** `apps/desktop/src/features/updater/update-status.ts` — a `checkForUpdateAndStore()` helper that wraps `checkForAppUpdate` + store writes (shared by startup effect, menu, UpdatesSection)
- **Modify** `apps/desktop/src/components/layout/AppShell.tsx` — startup effect + render `<UpdateDialog/>`
- **Modify** `apps/desktop/src/components/layout/AppShellActivityBar.tsx` — Settings red-dot + click-to-open-dialog
- **Modify** `apps/desktop/src/components/layout/hooks/use-menu-actions.ts` — `check_for_updates` opens dialog
- **Modify** `apps/desktop/src/pages/settings/index.tsx` — `UpdatesSection` subscribes to store
- **Modify** `apps/desktop/src/i18n/messages/{en,zh-CN}.ts` — new dialog keys
- **Modify** `.github/workflows/release.yml` — changelog into `latest.json` notes
- **Tests** `apps/desktop/src/app/store/app-shell.store.test.ts` (new), `apps/desktop/src/features/updater/UpdateDialog.test.tsx` (new), update `apps/desktop/src/pages/settings/updates-section.test.tsx`

---

## Task 1: Extend `useAppShellStore` with update state

**Files:**
- Modify: `apps/desktop/src/app/store/app-shell.store.ts`
- Create: `apps/desktop/src/app/store/app-shell.store.test.ts`

**Interfaces:**
- Produces: `useAppShellStore` fields `availableUpdate: AppUpdateInfo | null`, `isChecking`, `isInstalling`, `updateProgress: AppUpdateProgress | null`, `isUpdateDialogOpen`, and setters `setAvailableUpdate` / `setUpdateChecking` / `setUpdateInstalling` / `setUpdateProgress` / `setUpdateDialogOpen`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/app/store/app-shell.store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { useAppShellStore } from "@/app/store/app-shell.store";

describe("useAppShellStore update slice", () => {
  beforeEach(() => {
    useAppShellStore.setState({
      availableUpdate: null,
      isChecking: false,
      isInstalling: false,
      updateProgress: null,
      isUpdateDialogOpen: false,
    });
  });

  it("sets and clears availableUpdate", () => {
    const { setAvailableUpdate } = useAppShellStore.getState();
    setAvailableUpdate({ version: "9.9.9", currentVersion: "0.1.6" });
    expect(useAppShellStore.getState().availableUpdate?.version).toBe("9.9.9");
    setAvailableUpdate(null);
    expect(useAppShellStore.getState().availableUpdate).toBeNull();
  });

  it("toggles isChecking and isUpdateDialogOpen", () => {
    useAppShellStore.getState().setUpdateChecking(true);
    expect(useAppShellStore.getState().isChecking).toBe(true);
    useAppShellStore.getState().setUpdateDialogOpen(true);
    expect(useAppShellStore.getState().isUpdateDialogOpen).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aiproxy/desktop exec vitest run src/app/store/app-shell.store.test.ts`
Expected: FAIL — `availableUpdate` etc. do not exist on the store.

- [ ] **Step 3: Extend the store**

Replace the contents of `apps/desktop/src/app/store/app-shell.store.ts`:

```ts
import { create } from "zustand";

import type { AppUpdateInfo, AppUpdateProgress } from "@/services/updater/app-updater";

type AppShellState = {
  navigationExpanded: boolean;
  toggleNavigation: () => void;
  // Update state (ephemeral, shell-wide; subscribed by badge / dialog / settings)
  availableUpdate: AppUpdateInfo | null;
  isChecking: boolean;
  isInstalling: boolean;
  updateProgress: AppUpdateProgress | null;
  isUpdateDialogOpen: boolean;
  setAvailableUpdate: (info: AppUpdateInfo | null) => void;
  setUpdateChecking: (checking: boolean) => void;
  setUpdateInstalling: (installing: boolean) => void;
  setUpdateProgress: (progress: AppUpdateProgress | null) => void;
  setUpdateDialogOpen: (open: boolean) => void;
};

export const useAppShellStore = create<AppShellState>((set) => ({
  navigationExpanded: true,
  toggleNavigation: () => set((state) => ({ navigationExpanded: !state.navigationExpanded })),
  availableUpdate: null,
  isChecking: false,
  isInstalling: false,
  updateProgress: null,
  isUpdateDialogOpen: false,
  setAvailableUpdate: (info) => set({ availableUpdate: info }),
  setUpdateChecking: (checking) => set({ isChecking: checking }),
  setUpdateInstalling: (installing) => set({ isInstalling: installing }),
  setUpdateProgress: (progress) => set({ updateProgress: progress }),
  setUpdateDialogOpen: (open) => set({ isUpdateDialogOpen: open }),
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aiproxy/desktop exec vitest run src/app/store/app-shell.store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: typecheck + format:check + lint**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop format:check
pnpm --filter @aiproxy/desktop lint
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/app/store/app-shell.store.ts apps/desktop/src/app/store/app-shell.store.test.ts
git commit -m "feat(app-shell): add update status slice to useAppShellStore"
```

---

## Task 2: i18n keys for the update dialog

**Files:**
- Modify: `apps/desktop/src/i18n/messages/en.ts` (inside `settingsPage`)
- Modify: `apps/desktop/src/i18n/messages/zh-CN.ts` (inside `settingsPage`)

**Interfaces:**
- Produces: keys `settingsPage.updateDialogTitle`, `.updateDialogChangelog`, `.updateDialogUpdateNow`, `.updateDialogLater`, `.updateDialogNoUpdate`.

- [ ] **Step 1: Add English keys**

In `en.ts`:

(a) Inside `common.actions`, after `clearSessions`, add (alphabetical):

```ts
      close: "Close",
```

(b) Inside the `settingsPage` object, after `updatesRestarting`, add:

```ts
    updateDialogChangelog: "What's new",
    updateDialogLater: "Later",
    updateDialogNoUpdate: "AIProxy is up to date.",
    updateDialogTitle: "New version {{version}} is available",
    updateDialogUpdateNow: "Update now",
```

- [ ] **Step 2: Add Chinese keys**

In `zh-CN.ts`:

(a) Inside `common.actions`, after the `clearSessions` key, add:

```ts
      close: "关闭",
```

(b) Inside the `settingsPage` object, after `updatesRestarting`, add:

```ts
    updateDialogChangelog: "更新内容",
    updateDialogLater: "稍后",
    updateDialogNoUpdate: "AIProxy 已是最新版本。",
    updateDialogTitle: "发现新版本 {{version}}",
    updateDialogUpdateNow: "立即更新",
```

- [ ] **Step 3: typecheck + i18n test**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop exec vitest run src/i18n/index.test.ts
```
Expected: PASS (the i18n test asserts en/zh-CN key parity — both files must match).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/i18n/messages/en.ts apps/desktop/src/i18n/messages/zh-CN.ts
git commit -m "feat(i18n): add update dialog strings (en + zh-CN)"
```

---

## Task 3: Shared `checkForUpdateAndStore` helper

Centralizes the check → store logic so startup, menu, and UpdatesSection stay DRY.

**Files:**
- Create: `apps/desktop/src/features/updater/update-status.ts`

**Interfaces:**
- Produces: `async function checkForUpdateAndStore(): Promise<void>` — flips `isChecking`, calls `checkForAppUpdate()`, writes `availableUpdate`, swallows errors (logs, sets `availableUpdate: null`).
- Produces: `async function installUpdateAndStore(): Promise<void>` — flips `isInstalling`, streams `updateProgress`, calls `installPendingAppUpdate`, relaunches (inside the helper).

- [ ] **Step 1: Create the helper**

Create `apps/desktop/src/features/updater/update-status.ts`:

```ts
import { coerceAppError } from "@aiproxy/shared-types";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { checkForAppUpdate, installPendingAppUpdate } from "@/services/updater/app-updater";

/**
 * Check for an update and write the result into the shell store. Silent on
 * failure: a network/registry error just leaves availableUpdate null and logs.
 */
export async function checkForUpdateAndStore(): Promise<void> {
  const store = useAppShellStore.getState();
  store.setUpdateChecking(true);
  try {
    const info = await checkForAppUpdate();
    store.setAvailableUpdate(info);
  } catch (error) {
    // Non-fatal: the app works without update info.
    console.warn("[updater] check failed:", coerceAppError(error).message);
    store.setAvailableUpdate(null);
  } finally {
    store.setUpdateChecking(false);
  }
}

/**
 * Install the pending update, streaming progress into the store, then relaunch
 * (relaunch happens inside installPendingAppUpdate).
 */
export async function installUpdateAndStore(): Promise<void> {
  const store = useAppShellStore.getState();
  store.setUpdateInstalling(true);
  store.setUpdateProgress(null);
  try {
    await installPendingAppUpdate((progress) => store.setUpdateProgress(progress));
  } catch (error) {
    console.warn("[updater] install failed:", coerceAppError(error).message);
    store.setUpdateInstalling(false);
    throw error;
  }
}
```

- [ ] **Step 2: typecheck + format:check + lint**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop format:check
pnpm --filter @aiproxy/desktop lint
```
Expected: PASS (`coerceAppError` is already exported from `@aiproxy/shared-types`, used elsewhere).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/features/updater/update-status.ts
git commit -m "feat(updater): add checkForUpdateAndStore / installUpdateAndStore helpers"
```

---

## Task 4: `UpdateDialog` component

**Files:**
- Create: `apps/desktop/src/features/updater/UpdateDialog.tsx`
- Create: `apps/desktop/src/features/updater/UpdateDialog.test.tsx`

**Interfaces:**
- Consumes: `useAppShellStore` (Task 1), `installUpdateAndStore` (Task 3), i18n keys (Task 2).
- Produces: `export function UpdateDialog()` — renders a `<Dialog>` driven by store state.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/features/updater/UpdateDialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { useAppShellStore } from "@/app/store/app-shell.store";
import { UpdateDialog } from "@/features/updater/UpdateDialog";

describe("UpdateDialog", () => {
  beforeEach(() => {
    useAppShellStore.setState({
      availableUpdate: null,
      isChecking: false,
      isInstalling: false,
      updateProgress: null,
      isUpdateDialogOpen: false,
    });
  });

  it("shows version + changelog + Update now when an update is available", () => {
    useAppShellStore.setState({
      availableUpdate: {
        version: "9.9.9",
        currentVersion: "0.1.6",
        body: "- fix something",
      },
      isUpdateDialogOpen: true,
    });

    render(<UpdateDialog />, { wrapper: AppProviders });

    expect(screen.getByText(/9\.9\.9/i)).toBeInTheDocument();
    expect(screen.getByText("- fix something")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update now/i })).toBeInTheDocument();
  });

  it("shows 'up to date' and no Update button when no update", () => {
    useAppShellStore.setState({ isUpdateDialogOpen: true });

    render(<UpdateDialog />, { wrapper: AppProviders });

    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update now/i })).not.toBeInTheDocument();
  });

  it("renders nothing when dialog is closed", () => {
    useAppShellStore.setState({ isUpdateDialogOpen: false });

    const { container } = render(<UpdateDialog />, { wrapper: AppProviders });
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aiproxy/desktop exec vitest run src/features/updater/UpdateDialog.test.tsx`
Expected: FAIL — `UpdateDialog` module not found.

- [ ] **Step 3: Implement the component**

Create `apps/desktop/src/features/updater/UpdateDialog.tsx`:

```tsx
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";

import { useAppShellStore } from "@/app/store/app-shell.store";
import { useI18n } from "@/i18n";
import { installUpdateAndStore } from "@/features/updater/update-status";

export function UpdateDialog() {
  const { t } = useI18n();
  const availableUpdate = useAppShellStore((s) => s.availableUpdate);
  const isChecking = useAppShellStore((s) => s.isChecking);
  const isInstalling = useAppShellStore((s) => s.isInstalling);
  const updateProgress = useAppShellStore((s) => s.updateProgress);
  const isOpen = useAppShellStore((s) => s.isUpdateDialogOpen);
  const setUpdateDialogOpen = useAppShellStore((s) => s.setUpdateDialogOpen);

  if (!isOpen) {
    return null;
  }

  const progressText =
    updateProgress && updateProgress.contentLength
      ? t("settingsPage.updatesProgress", {
          downloaded: Math.round(updateProgress.downloaded / 1024).toString(),
          total: Math.round(updateProgress.contentLength / 1024).toString(),
        })
      : null;

  const title = isChecking
    ? t("settingsPage.updatesChecking")
    : availableUpdate
      ? t("settingsPage.updateDialogTitle", { version: availableUpdate.version })
      : t("settingsPage.updateDialogNoUpdate");

  async function handleUpdate() {
    try {
      await installUpdateAndStore();
      // installPendingAppUpdate relaunches the app on success.
    } catch {
      // Error already logged by the helper; keep dialog open so the user sees
      // the failure state and can retry or dismiss.
    }
  }

  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={isInstalling ? undefined : () => setUpdateDialogOpen(false)}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {isChecking ? <CircularProgress size={24} /> : null}
        {availableUpdate?.body ? (
          <Box sx={{ mt: isChecking ? 2 : 0 }}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("settingsPage.updateDialogChangelog")}
            </Typography>
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
              {availableUpdate.body}
            </Typography>
          </Box>
        ) : null}
        {isInstalling && progressText ? (
          <Typography variant="caption" sx={{ display: "block", mt: 1 }}>
            {progressText}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions>
        {availableUpdate && !isInstalling ? (
          <Button onClick={() => void handleUpdate()} variant="contained">
            {t("settingsPage.updateDialogUpdateNow")}
          </Button>
        ) : null}
        {!isInstalling ? (
          <Button onClick={() => setUpdateDialogOpen(false)}>
            {availableUpdate
              ? t("settingsPage.updateDialogLater")
              : t("common.actions.close")}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aiproxy/desktop exec vitest run src/features/updater/UpdateDialog.test.tsx`
Expected: PASS (3 tests). (If `common.actions.close` does not exist, check `en.ts` — it is used elsewhere in the app; if absent, reuse an existing close key.)

- [ ] **Step 5: typecheck + format:check + lint**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop format:check
pnpm --filter @aiproxy/desktop lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/updater/UpdateDialog.tsx apps/desktop/src/features/updater/UpdateDialog.test.tsx
git commit -m "feat(updater): add UpdateDialog driven by shell store"
```

---

## Task 5: Settings red-dot + click-to-open in ActivityBar

**Files:**
- Modify: `apps/desktop/src/components/layout/AppShellActivityBar.tsx`

**Interfaces:**
- Consumes: `useAppShellStore.availableUpdate` / `setUpdateDialogOpen`.

- [ ] **Step 1: Subscribe to update state**

In `AppShellActivityBar.tsx`, add the import and read update state inside the component (after `const { t } = useI18n();`):

```tsx
import { useAppShellStore } from "@/app/store/app-shell.store";
```

```tsx
  const availableUpdate = useAppShellStore((s) => s.availableUpdate);
  const setUpdateDialogOpen = useAppShellStore((s) => s.setUpdateDialogOpen);
```

- [ ] **Step 2: Extend `renderNavigationIcon` for a dot + click handler**

Change the signature to accept `showDot` and `onClick`:

```tsx
  function renderNavigationIcon(
    item: (typeof navigationItems)[number],
    options?: { badgeContent?: number; showDot?: boolean; onClick?: () => void },
  ) {
```

On the `<ListItemButton>`, add an `onClick` that, when `options.onClick` is provided, prevents the NavLink navigation and calls it. Add this prop alongside the existing ones:

```tsx
          onClick={
            options?.onClick
              ? (event) => {
                  event.preventDefault();
                  options.onClick?.();
                }
              : undefined
          }
```

Inside `<ListItemIcon>`, after the existing numeric badge block, add the red dot:

```tsx
            {options?.showDot ? (
              <Box
                sx={{
                  bgcolor: "error.main",
                  borderRadius: 999,
                  border: `2px solid ${ACTIVITY_BAR_BG}`,
                  height: 8,
                  position: "absolute",
                  right: -2,
                  top: 2,
                  width: 8,
                }}
              />
            ) : null}
```

- [ ] **Step 3: Wire the Settings item**

Replace the Settings render block (the `{settingsItem ? (...)}` section) so the `List` inside renders:

```tsx
              {renderNavigationIcon(
                settingsItem,
                availableUpdate
                  ? {
                      showDot: true,
                      onClick: () => setUpdateDialogOpen(true),
                    }
                  : undefined,
              )}
```

(When there is no update, `undefined` keeps the default NavLink-to-/settings behavior.)

- [ ] **Step 4: typecheck + format:check + lint**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop format:check
pnpm --filter @aiproxy/desktop lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/layout/AppShellActivityBar.tsx
git commit -m "feat(activity-bar): show update red-dot and open dialog from Settings"
```

---

## Task 6: Startup check + render `UpdateDialog` in AppShell

**Files:**
- Modify: `apps/desktop/src/components/layout/AppShell.tsx`

**Interfaces:**
- Consumes: `checkForUpdateAndStore` (Task 3), `UpdateDialog` (Task 4).

- [ ] **Step 1: Add imports**

In `AppShell.tsx`, add:

```tsx
import { UpdateDialog } from "@/features/updater/UpdateDialog";
import { checkForUpdateAndStore } from "@/features/updater/update-status";
```

- [ ] **Step 2: Add the startup effect**

Inside `AppShell()`, alongside the existing `useEffect` (e.g., after the `macosTitlebarEnabled` effect), add:

```tsx
  useEffect(() => {
    void checkForUpdateAndStore();
  }, []);
```

- [ ] **Step 3: Render the dialog**

In the returned JSX, render `<UpdateDialog />` next to the other top-level overlays (e.g., right after `<SetupWizard />`):

```tsx
      <UpdateDialog />
```

- [ ] **Step 4: typecheck + format:check + lint + full test**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop format:check
pnpm --filter @aiproxy/desktop lint
pnpm --filter @aiproxy/desktop exec vitest run
```
Expected: all PASS (no regression; AppShell isn't directly tested, but the suite must stay green).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/layout/AppShell.tsx
git commit -m "feat(app-shell): auto-check for updates on startup and render UpdateDialog"
```

---

## Task 7: Menu "Check for Updates..." opens the dialog

**Files:**
- Modify: `apps/desktop/src/components/layout/hooks/use-menu-actions.ts`

**Interfaces:**
- Consumes: `useAppShellStore.setUpdateDialogOpen`, `checkForUpdateAndStore`.

- [ ] **Step 1: Replace the `check_for_updates` handler**

In `use-menu-actions.ts`, locate the `case "check_for_updates":` block (around line 179) and replace it with logic that opens the dialog and triggers a fresh check:

```tsx
      case "check_for_updates": {
        const store = useAppShellStore.getState();
        store.setUpdateDialogOpen(true);
        void checkForUpdateAndStore();
        break;
      }
```

- [ ] **Step 2: Add the imports**

At the top of `use-menu-actions.ts`, add:

```tsx
import { useAppShellStore } from "@/app/store/app-shell.store";
import { checkForUpdateAndStore } from "@/features/updater/update-status";
```

- [ ] **Step 3: typecheck + format:check + lint**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop format:check
pnpm --filter @aiproxy/desktop lint
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/layout/hooks/use-menu-actions.ts
git commit -m "feat(menu): Check for Updates opens the update dialog and rechecks"
```

---

## Task 8: `UpdatesSection` subscribes to the store

**Files:**
- Modify: `apps/desktop/src/pages/settings/index.tsx` (`UpdatesSection`)
- Modify: `apps/desktop/src/pages/settings/updates-section.test.tsx`

**Interfaces:**
- Consumes: `useAppShellStore` (Task 1), `checkForUpdateAndStore` (Task 3), `installUpdateAndStore` (Task 3).

- [ ] **Step 1: Rewrite `UpdatesSection` to use the store**

In `pages/settings/index.tsx`, replace the `UpdatesSection` function body so it reads from `useAppShellStore` instead of local state, and the Check button calls `checkForUpdateAndStore()`:

```tsx
export function UpdatesSection() {
  const { t } = useI18n();
  const availableUpdate = useAppShellStore((s) => s.availableUpdate);
  const isChecking = useAppShellStore((s) => s.isChecking);
  const isInstalling = useAppShellStore((s) => s.isInstalling);
  const updateProgress = useAppShellStore((s) => s.updateProgress);
  const [justCheckedNone, setJustCheckedNone] = useState(false);

  async function handleCheck() {
    await checkForUpdateAndStore();
    if (useAppShellStore.getState().availableUpdate === null) {
      setJustCheckedNone(true);
    }
  }

  async function handleInstall() {
    try {
      await installUpdateAndStore();
    } catch {
      // helper logs + resets isInstalling
    }
  }

  const progressText =
    updateProgress && updateProgress.contentLength
      ? t("settingsPage.updatesProgress", {
          downloaded: Math.round(updateProgress.downloaded / 1024).toString(),
          total: Math.round(updateProgress.contentLength / 1024).toString(),
        })
      : null;

  return (
    <SectionCard
      compact
      title={t("settingsPage.updatesSectionTitle")}
      description={t("settingsPage.updatesDescription")}
    >
      <Stack spacing={1.5}>
        <Stack direction={{ sm: "row", xs: "column" }} spacing={1.5} sx={{ alignItems: { sm: "center", xs: "stretch" } }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<SystemUpdateAltRoundedIcon />}
            onClick={() => void handleCheck()}
            disabled={isChecking || isInstalling}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {isChecking
              ? t("settingsPage.updatesCheckingAction")
              : t("settingsPage.updatesCheckAction")}
          </Button>

          <Button
            size="small"
            variant="contained"
            startIcon={<DownloadRoundedIcon />}
            onClick={() => void handleInstall()}
            disabled={!availableUpdate || isChecking || isInstalling}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {isInstalling
              ? t("settingsPage.updatesInstallingAction")
              : t("settingsPage.updatesInstallAction")}
          </Button>
        </Stack>

        {availableUpdate ? (
          <Alert severity="info" variant="outlined" sx={compactAlertSx}>
            {t("settingsPage.updatesAvailableDetail", {
              currentVersion: availableUpdate.currentVersion,
              version: availableUpdate.version,
            })}
          </Alert>
        ) : null}

        {progressText ? (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {progressText}
          </Typography>
        ) : null}

        <Snackbar
          open={justCheckedNone}
          autoHideDuration={3000}
          onClose={() => setJustCheckedNone(false)}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        >
          <Alert severity="success" variant="filled" onClose={() => setJustCheckedNone(false)}>
            {t("settingsPage.updatesNone")}
          </Alert>
        </Snackbar>
      </Stack>
    </SectionCard>
  );
}
```

Add the needed imports to `pages/settings/index.tsx`:

```tsx
import { useAppShellStore } from "@/app/store/app-shell.store";
import { checkForUpdateAndStore, installUpdateAndStore } from "@/features/updater/update-status";
```

(Remove now-unused local-state declarations and the old `feedback`/`toast` state. Keep `Snackbar` and `Alert` imports — they are still used.)

- [ ] **Step 2: Update the test**

In `apps/desktop/src/pages/settings/updates-section.test.tsx`, the mock target changes from `checkForAppUpdate` to `checkForUpdateAndStore` (which `UpdatesSection` now calls), and the store must be seeded. Replace the file:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { useAppShellStore } from "@/app/store/app-shell.store";
import { UpdatesSection } from "@/pages/settings";
import type { AppUpdateInfo } from "@/services/updater/app-updater";

vi.mock("@/features/updater/update-status", () => ({
  checkForUpdateAndStore: vi.fn(),
  installUpdateAndStore: vi.fn(),
}));

import { checkForUpdateAndStore } from "@/features/updater/update-status";

describe("UpdatesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppShellStore.setState({
      availableUpdate: null,
      isChecking: false,
      isInstalling: false,
      updateProgress: null,
      isUpdateDialogOpen: false,
    });
  });

  it("shows 'up to date' toast after a manual check finds nothing", async () => {
    vi.mocked(checkForUpdateAndStore).mockResolvedValue();

    render(<UpdatesSection />, { wrapper: AppProviders });

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    expect(await screen.findByText(/is up to date/i)).toBeInTheDocument();
  });

  it("shows available detail after a manual check finds an update", async () => {
    vi.mocked(checkForUpdateAndStore).mockImplementation(async () => {
      useAppShellStore.setState({
        availableUpdate: { version: "9.9.9", currentVersion: "0.1.5" } as AppUpdateInfo,
      });
    });

    render(<UpdatesSection />, { wrapper: AppProviders });

    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));

    await waitFor(() => {
      expect(screen.getByText(/9\.9\.9/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @aiproxy/desktop exec vitest run src/pages/settings/updates-section.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 4: typecheck + format:check + lint + full test**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop format:check
pnpm --filter @aiproxy/desktop lint
pnpm --filter @aiproxy/desktop exec vitest run
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/pages/settings/index.tsx apps/desktop/src/pages/settings/updates-section.test.tsx
git commit -m "refactor(settings): UpdatesSection subscribes to shared update store"
```

---

## Task 9: Auto-generate changelog into `latest.json`

**Files:**
- Modify: `.github/workflows/release.yml` (the `Generate updater manifest` step, ~line 207-280)

**Interfaces:** none (CI-only).

- [ ] **Step 1: Compute the changelog in the manifest step**

In `.github/workflows/release.yml`, inside the `Generate updater manifest` step's `node <<'NODE' ... NODE` script, add a shell-prepared env var before the `node` block and read it in JS. Replace the step with:

```yaml
      - name: Generate updater manifest
        env:
          CHANGELOG: ${{ github.ref_type == 'tag' && steps.changelog.outputs.text || '' }}
        run: |
          node <<'NODE'
          const fs = require("node:fs");
          const path = require("node:path");

          const repo = "small-dream/AIProxy";
          const tag = process.env.GITHUB_REF_NAME;
          const version = tag.startsWith("v") ? tag.slice(1) : tag;
          const root = path.resolve("release-artifacts");
          const changelog = process.env.CHANGELOG || `AIProxy ${version}`;

          function walk(dir) {
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
              const full = path.join(dir, entry.name);
              return entry.isDirectory() ? walk(full) : [full];
            });
          }

          const files = walk(root);
          const byName = new Map(files.map((file) => [path.basename(file), file]));
          const platformByBundle = new Map(
            files
              .filter((file) => path.basename(file).startsWith("updater-platform-"))
              .map((file) => {
                const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
                return [metadata.bundle, metadata.platform];
              }),
          );

          function pick(match) {
            return files.find((file) => match(path.basename(file)));
          }

          function assetUrl(file) {
            const name = encodeURIComponent(path.basename(file));
            return `https://github.com/${repo}/releases/download/${tag}/${name}`;
          }

          function signatureFor(file) {
            const sig = byName.get(`${path.basename(file)}.sig`);
            return sig ? fs.readFileSync(sig, "utf8").trim() : null;
          }

          const platforms = {};
          const mac = pick((name) => name.endsWith(".app.tar.gz"));
          const linux = pick((name) => name.endsWith(".AppImage"));
          const windows = pick((name) => name.endsWith(".exe")) ?? pick((name) => name.endsWith(".msi"));

          if (mac) {
            const signature = signatureFor(mac);
            if (signature) platforms[platformByBundle.get("macos") ?? "darwin-x86_64"] = { signature, url: assetUrl(mac) };
          }
          if (linux) {
            const signature = signatureFor(linux);
            if (signature) platforms[platformByBundle.get("linux") ?? "linux-x86_64"] = { signature, url: assetUrl(linux) };
          }
          if (windows) {
            const signature = signatureFor(windows);
            if (signature) platforms[platformByBundle.get("windows") ?? "windows-x86_64"] = { signature, url: assetUrl(windows) };
          }

          if (Object.keys(platforms).length === 0) {
            console.log("No signed updater artifacts found — skipping latest.json. Installers will still be published without auto-update support.");
          } else {
            fs.writeFileSync(
              "latest.json",
              `${JSON.stringify({ version, notes: changelog, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`,
            );
            console.log("Wrote latest.json with", Object.keys(platforms).length, "platform(s).");
          }
          NODE
```

- [ ] **Step 2: Add the changelog step before the manifest step**

Insert this step immediately before `Generate updater manifest`:

```yaml
      - name: Build changelog from commits
        id: changelog
        shell: bash
        run: |
          prev_tag=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)
          if [ -n "$prev_tag" ]; then
            text=$(git log --pretty=format:"- %s" "${prev_tag}..HEAD")
          else
            text="Release ${GITHUB_REF_NAME}"
          fi
          {
            echo "text<<CHANGELOG_EOF"
            echo "$text"
            echo "CHANGELOG_EOF"
          } >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: Verify YAML locally (no full CI run possible)**

Run:
```bash
cd /Users/jake/AI/AIProxy
# sanity: the heredoc delimiters are balanced and indentation is consistent
sed -n '/Generate updater manifest/,/^      - name:/p' .github/workflows/release.yml | head -40
```
Expected: the step prints without obvious indentation errors. (Full verification happens on the next tag push in Task 10.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): write git-commit changelog into latest.json notes"
```

---

## Task 10: Verify + ship v0.1.7

**Files:**
- Modify (version bump): `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml` (`[workspace.package]`), `apps/desktop/package.json`, root `package.json` (all `0.1.6` → `0.1.7`); `Cargo.lock` follows.

- [ ] **Step 1: Full quality gate**

Run:
```bash
pnpm --filter @aiproxy/desktop format:check
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop lint
pnpm --filter @aiproxy/desktop exec vitest run
```
Expected: all PASS.

- [ ] **Step 2: Local dev visual check**

Run: `pnpm --filter @aiproxy/desktop dev`
Expected (on the running v0.1.6 build): startup auto-check runs → Settings nav shows a red dot (point to a fake update by temporarily aiming latest.json at a higher version, or trust the CI result) → clicking Settings opens UpdateDialog → changelog renders → Update now / Later behave. (A real update won't be visible locally until v0.1.7 is published, so this is mostly a no-op check that nothing crashes.)

- [ ] **Step 3: Bump version to 0.1.7 (4 files)**

- `apps/desktop/src-tauri/tauri.conf.json:5` → `"version": "0.1.7"`
- `Cargo.toml` `[workspace.package]` → `version = "0.1.7"`
- `apps/desktop/package.json:3` → `"version": "0.1.7"`
- root `package.json:3` → `"version": "0.1.7"`

Confirm `Cargo.lock` 5 `aiproxy-*` crates update too (run `cargo check --workspace` if the IDE didn't).

- [ ] **Step 4: Commit + tag + push**

```bash
git add Cargo.toml Cargo.lock package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
git commit -m "chore(release): bump version to 0.1.7"
git tag -a v0.1.7 -m "Release v0.1.7"
git push origin master
git push origin v0.1.7
```

- [ ] **Step 5: Monitor CI + verify**

Poll the Release run (background, ~18 min): 4 jobs green. Then:
- Download `latest.json` from the v0.1.7 release; confirm `notes` contains the commit bullets (not `"AIProxy 0.1.7"`).
- In the running v0.1.6 app, the startup check should surface the v0.1.7 red dot; opening the dialog shows the changelog; Update now downloads + relaunches to v0.1.7.

---

## Self-Review 记录

- **Spec coverage**:
  - store-owned update state → Task 1 ✅
  - startup auto-check (silent) → Task 6 ✅
  - ActivityBar Settings red-dot (reusing badge mechanism) → Task 5 ✅
  - UpdateDialog (version + changelog + update/later + progress) → Task 4 ✅
  - menu opens dialog → Task 7 ✅
  - UpdatesSection subscribes to store → Task 8 ✅
  - changelog from git commits into latest.json notes → Task 9 ✅
  - i18n bilingual → Task 2 ✅
  - check once / on-demand download / non-persistent dismiss → enforced in helpers (Task 3) + design ✅
- **Placeholder scan**: every code step has actual code; commands have expected output. The only "verify on next tag" item is the release.yml YAML (Task 9 Step 3), which is unavoidable for CI-only changes and is verified in Task 10.
- **Type consistency**: store field names (`availableUpdate`, `isChecking`, `isInstalling`, `updateProgress`, `isUpdateDialogOpen`) and setter names are identical across Tasks 1, 3, 4, 5, 6, 7, 8. `checkForUpdateAndStore` / `installUpdateAndStore` (Task 3) used verbatim in Tasks 6, 7, 8.
- **Known risks**:
  - `common.actions.close` is referenced in UpdateDialog (Task 4) — confirm it exists; if not, reuse an existing close key.
  - release.yml heredoc + multiline `GITHUB_OUTPUT` (Task 9) must be copied verbatim; a stray indentation change breaks the manifest.
