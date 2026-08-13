# Settings UI: TLS layout + updater toast — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Verify Upstream TLS control into a standard setting row (and fix the focus label/border overlap), replace the always-on "up to date" status with an auto-dismissing Snackbar toast, then ship v0.1.6 and verify auto-upgrade from the locally installed v0.1.5.

**Architecture:** Two sections in `pages/settings/index.tsx` are edited in place. `ProxySettingsSection`'s TLS block is rebuilt as a vertical setting row (label+desc on the left, Switch on the right; hosts textarea moved below and rendered only when ON; the always-on Alert is dropped, an OFF-state warning caption is kept). `UpdatesSection` drops its always-rendered feedback `Alert`; "up to date" / errors surface as a transient `Snackbar` (`autoHideDuration={3000}`) while the available-update detail + Install button stay persistent. A component test covers the updater feedback behavior.

**Tech Stack:** React 19, TypeScript, MUI (`Snackbar`/`Alert`/`Switch`/`TextField`/`Box`/`Typography`), Vitest + Testing Library, Tauri updater.

## Global Constraints

- i18n 双语:复用现有 `en.ts` / `zh-CN.ts` 的 key,**不改文案**(本次无需动 i18n 文件)
- 不动 Rust / `packages/shared-types` / Tauri 命令 / updater 后端 / 签名发布链路
- 不加自动轮询、不加跨页"更新可用"徽章
- 跨平台:`Snackbar`/`Alert` 为 MUI 通用组件,三平台一致
- 提交信息沿用 conventional commits,结尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`

## File Structure

- **Modify** `apps/desktop/src/pages/settings/index.tsx`
  - 加 `Snackbar` 到 `@mui/material` import(line 6-19)
  - `ProxySettingsSection` TLS 块重写(line 304-366)
  - `UpdatesSection` 重写状态 + 渲染(line 400-541);函数加 `export` 供测试
- **Create** `apps/desktop/src/pages/settings/updates-section.test.tsx` — `UpdatesSection` 行为测试
- **参考(不改)**:`features/sessions/use-session-context-actions.ts`(局部 Snackbar 模式)、`pages/sessions/index.tsx:765`(Snackbar 渲染风格)

---

## Task 1: TLS setting row + focus-overlap fix

**说明:** 这是纯 JSX/样式重构,条件渲染由 `draft.verifyUpstreamTls` 驱动,无独立纯逻辑可单测;验证靠 typecheck + 本地目视(focus/blur 两态)。focus 重叠的根因是 `tlsVerifyHosts` TextField 用了 `label`(floating label)+ `compactFieldSx` 的 `minHeight:38` 压缩了 multiline outlined 的 notch。修复:去掉 `label`、改外部 `Typography` 标题 + 纯 `placeholder`、不再套 `compactFieldSx`。

**Files:**
- Modify: `apps/desktop/src/pages/settings/index.tsx:304-366`(TLS 块)

**Interfaces:** 无新增导出;`draft.verifyUpstreamTls` / `draft.tlsVerifyHostsText` / `setDraft` / `setFeedback` 沿用现有。

- [ ] **Step 1: 替换 TLS 块 JSX**

把 `pages/settings/index.tsx` 中从 ` {/* H3: upstream TLS certificate verification opt-out... */}` 注释所在的 `<Stack direction={{ md: "row", xs: "column" }} ...>`(约 line 304)直到紧随其后的 ON/OFF `Alert`(约 line 366)整段,替换为:

```tsx
        {/* H3: upstream TLS certificate verification opt-out. Off by default
            (the debug proxy accepts any upstream cert). Turning it on makes
            new HTTPS/WSS connections verify against the OS root store. */}
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 2,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2">{t("proxyPresets.verifyUpstreamTls")}</Typography>
            <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
              {t("proxyPresets.verifyUpstreamTlsDescription")}
            </Typography>
            {!draft.verifyUpstreamTls ? (
              <Typography
                variant="caption"
                sx={{ display: "block", mt: 0.5, color: "warning.main" }}
              >
                {t("proxyPresets.verifyUpstreamTlsDisabledHint")}
              </Typography>
            ) : null}
          </Box>
          <Switch
            size="small"
            checked={draft.verifyUpstreamTls}
            onChange={(event) => {
              setDraft({ ...draft, verifyUpstreamTls: event.target.checked });
              setFeedback(null);
            }}
          />
        </Box>

        {draft.verifyUpstreamTls ? (
          <Box>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("proxyPresets.tlsVerifyHosts")}
            </Typography>
            <TextField
              size="small"
              multiline
              minRows={2}
              maxRows={4}
              placeholder={t("proxyPresets.tlsVerifyHostsPlaceholder")}
              value={draft.tlsVerifyHostsText}
              onChange={(event) => {
                setDraft({ ...draft, tlsVerifyHostsText: event.target.value });
                setFeedback(null);
              }}
              sx={{ display: "block", mt: 0.5 }}
            />
          </Box>
        ) : null}
```

要点:
- `TextField` 去掉 `label`(纯 placeholder),去掉 `compactFieldSx`(`display:"block"` 用默认 multiline 高度/padding)→ 消除 focus 时 floating label 与边框重叠。
- 白名单输入框仅在 `verifyUpstreamTls === true` 时渲染。
- 去掉原常驻 ON/OFF `Alert`;OFF 时在描述下方显示 `warning.main` 色 caption(`verifyUpstreamTlsDisabledHint`)。

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS(无 TS 错误;`CheckCircleRoundedIcon` 若不再被本文件其他地方使用会报 unused——若如此,从 import 移除;否则保留)。

- [ ] **Step 3: 本地目视**

Run: `pnpm --filter @aiproxy/desktop dev`,打开 Settings → Proxy Settings:
Expected:
- TLS 行:标题+描述在左、Switch 在右;白名单输入框不显示,OFF warning caption 显示。
- 开启 Switch:白名单输入框出现;focus 输入框时 placeholder 不与边框重叠。
- 关闭 Switch:白名单消失,OFF warning caption 回来。

- [ ] **Step 4: lint**

Run: `pnpm --filter @aiproxy/desktop lint`
Expected: PASS(若 `CheckCircleRoundedIcon` 变 unused,eslint 会报——按 Step 2 处理后应通过)。

- [ ] **Step 5: commit**

```bash
git add apps/desktop/src/pages/settings/index.tsx
git commit -m "fix(settings): restructure Verify Upstream TLS row and fix focus overlap

Move the hosts allowlist below the switch (shown only when ON), drop the
always-on Alert for a compact OFF warning caption, and rebuild the textarea
as an external label + placeholder-only field so the floating label no
longer overlaps the outlined border on focus."
```

(若需要,在 commit message 末尾追加 `Co-Authored-By: Claude <noreply@anthropic.com>`。)

---

## Task 2: UpdatesSection auto-dismissing Snackbar toast + test

**Files:**
- Modify: `apps/desktop/src/pages/settings/index.tsx`(`@mui/material` import 加 `Snackbar`;`UpdatesSection` 加 `export` + 重写)
- Create: `apps/desktop/src/pages/settings/updates-section.test.tsx`

**Interfaces:**
- Produces: `export function UpdatesSection()`(命名导出,供测试 import)
- Consumes: `checkForAppUpdate` / `installPendingAppUpdate` from `@/services/updater/app-updater`(已 import);`AppProviders` 作为测试 wrapper

- [ ] **Step 1: 写失败测试**

创建 `apps/desktop/src/pages/settings/updates-section.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { UpdatesSection } from "@/pages/settings";
import { type AppUpdateInfo } from "@/services/updater/app-updater";

vi.mock("@/services/updater/app-updater", () => ({
  checkForAppUpdate: vi.fn(),
  installPendingAppUpdate: vi.fn(),
}));

import { checkForAppUpdate } from "@/services/updater/app-updater";

describe("UpdatesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an 'up to date' toast when no update is available", async () => {
    vi.mocked(checkForAppUpdate).mockResolvedValue(null);
    const user = userEvent.setup();

    render(<UpdatesSection />, { wrapper: AppProviders });

    await user.click(screen.getByRole("button", { name: /check for updates/i }));

    expect(await screen.findByText(/is up to date/i)).toBeInTheDocument();
  });

  it("shows available update detail and no 'up to date' toast when an update exists", async () => {
    vi.mocked(checkForAppUpdate).mockResolvedValue({
      version: "9.9.9",
      currentVersion: "0.1.5",
    } as AppUpdateInfo);
    const user = userEvent.setup();

    render(<UpdatesSection />, { wrapper: AppProviders });

    await user.click(screen.getByRole("button", { name: /check for updates/i }));

    await waitFor(() => {
      expect(screen.getByText(/9\.9\.9/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/is up to date/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter @aiproxy/desktop test updates-section`
Expected: FAIL — 当前 `UpdatesSection` 未 export(import 报错),且 "up to date" 文案在常驻 Alert 里(第二个 case 会误判通过,但第一个 case 的 import 失败导致整体 FAIL)。先确认 import 报错或断言失败。

- [ ] **Step 3: 加 `Snackbar` 到 import**

在 `pages/settings/index.tsx` 的 `@mui/material` import(line 6-19)里加入 `Snackbar`(按字母序放在 `Select` 之后、`Stack` 之前):

```tsx
import {
  Alert,
  Button,
  Box,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
```

- [ ] **Step 4: export `UpdatesSection`**

把 `function UpdatesSection()`(约 line 400)改为:

```tsx
export function UpdatesSection() {
```

- [ ] **Step 5: 重写 `UpdatesSection` 状态**

把 `feedback` state(line 406-409)替换为 `toast` state:

```tsx
  const [toast, setToast] = useState<{ message: string; severity: "success" | "error" } | null>(
    null,
  );
```

- [ ] **Step 6: 重写 `handleCheck`**

替换 `handleCheck`(line 411-436):

```tsx
  const handleCheck = useCallback(async () => {
    setIsChecking(true);
    setProgress(null);

    try {
      const update = await checkForAppUpdate();
      setAvailableUpdate(update);
      if (!update) {
        setToast({ message: t("settingsPage.updatesNone"), severity: "success" });
      }
    } catch (error) {
      const normalizedError = coerceAppError(error);
      setToast({
        message: normalizedError.message.trim() || t("common.errors.generic"),
        severity: "error",
      });
    } finally {
      setIsChecking(false);
    }
  }, [t]);
```

- [ ] **Step 7: 重写 `handleInstall`**

替换 `handleInstall`(line 438-453):

```tsx
  async function handleInstall() {
    setIsInstalling(true);

    try {
      await installPendingAppUpdate((nextProgress) => setProgress(nextProgress));
      setToast({ message: t("settingsPage.updatesRestarting"), severity: "success" });
    } catch (error) {
      const normalizedError = coerceAppError(error);
      setToast({
        message: normalizedError.message.trim() || t("common.errors.generic"),
        severity: "error",
      });
      setIsInstalling(false);
    }
  }
```

- [ ] **Step 8: 重写渲染 — 去掉常驻 feedback Alert,加 Snackbar**

把 `return (...)`(line 474-540)中按钮行之后的 `<Alert severity={feedback.severity} ...>{feedback.message}</Alert>`(line 515-517)**删除**,保留 `availableUpdate` detail Alert(line 519-526)与 `progressText`。然后在 `</Stack>` 闭合前(即 `progressText` 块之后、外层 `</Stack>` 之前)加入 Snackbar:

```tsx
        <Snackbar
          open={toast !== null}
          autoHideDuration={3000}
          onClose={() => setToast(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        >
          {toast ? (
            <Alert
              severity={toast.severity}
              variant="filled"
              onClose={() => setToast(null)}
            >
              {toast.message}
            </Alert>
          ) : undefined}
        </Snackbar>
```

最终 `UpdatesSection` 的 return 结构(完整):

```tsx
  return (
    <SectionCard
      compact
      title={t("settingsPage.updatesSectionTitle")}
      description={t("settingsPage.updatesDescription")}
    >
      <Stack spacing={1.5}>
        <Stack
          direction={{ sm: "row", xs: "column" }}
          spacing={1.5}
          sx={{
            alignItems: { sm: "center", xs: "stretch" },
          }}
        >
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
          open={toast !== null}
          autoHideDuration={3000}
          onClose={() => setToast(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        >
          {toast ? (
            <Alert
              severity={toast.severity}
              variant="filled"
              onClose={() => setToast(null)}
            >
              {toast.message}
            </Alert>
          ) : undefined}
        </Snackbar>
      </Stack>
    </SectionCard>
  );
```

- [ ] **Step 9: 运行测试,确认通过**

Run: `pnpm --filter @aiproxy/desktop test updates-section`
Expected: PASS — case 1(无更新→toast "up to date")、case 2(有更新→detail 显示 + 无 "up to date" 文案)。

- [ ] **Step 10: typecheck**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: PASS。(`UpdateFeedback` type 与 `feedback` 变量已移除;若 `UpdateFeedback` 不再被引用,一并删除其声明 line 395-398。)

- [ ] **Step 11: commit**

```bash
git add apps/desktop/src/pages/settings/index.tsx apps/desktop/src/pages/settings/updates-section.test.tsx
git commit -m "feat(settings): show update status as auto-dismissing Snackbar toast

Drop the always-rendered feedback Alert in UpdatesSection; surface 'up to
date' and errors via a transient Snackbar (autoHideDuration 3000) while the
available-update detail + Install button stay persistent. Add a component
test for the check/no-update and check/update-available paths."
```

---

## Task 3: Verify + ship v0.1.6

**Files:**
- Modify(版本号 bump):`apps/desktop/src-tauri/tauri.conf.json`、`Cargo.toml`(`[workspace.package]`)、`apps/desktop/package.json`、根 `package.json`(均 0.1.5 → 0.1.6);`Cargo.lock` 随之更新(IDE rust-analyzer 自动)

- [ ] **Step 1: 全量质量门禁**

Run:
```bash
pnpm --filter @aiproxy/desktop typecheck
pnpm --filter @aiproxy/desktop lint
pnpm --filter @aiproxy/desktop test
```
Expected: 全 PASS。

- [ ] **Step 2: 本地 dev 目视确认完整两处改动**

Run: `pnpm --filter @aiproxy/desktop dev`,Settings 页:
Expected:
- TLS:标准 row + 白名单仅 ON 显示 + focus 无重叠 + OFF warning caption
- Updates:初始无状态文案;点 Check → 若最新,右下 toast "AIProxy is up to date." ~3s 消失;若有更新,保留 detail + Install

- [ ] **Step 3: bump 版本号到 0.1.6(4 处)**

- `apps/desktop/src-tauri/tauri.conf.json:5` → `"version": "0.1.6"`
- `Cargo.toml` `[workspace.package]` → `version = "0.1.6"`
- `apps/desktop/package.json:3` → `"version": "0.1.6"`
- 根 `package.json:3` → `"version": "0.1.6"`

确认 `Cargo.lock` 的 5 个 `aiproxy-*` crate 随之 0.1.5 → 0.1.6(若 IDE 未自动更新,跑 `cargo check --workspace` 触发)。

- [ ] **Step 4: 提交版本号 bump**

```bash
git add Cargo.toml Cargo.lock package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
git commit -m "chore(release): bump version to 0.1.6"
```

- [ ] **Step 5: 打 annotated tag**

```bash
git tag -a v0.1.6 -m "Release v0.1.6"
```

- [ ] **Step 6: 推送 master + tag(触发 Release workflow)**

```bash
git push origin master
git push origin v0.1.6
```
Expected: master 推送成功;tag 推送触发 Release workflow(run id 记下)。

- [ ] **Step 7: 监听 CI 完成**

后台轮询 run(参考之前 v0.1.4/v0.1.5 的轮询脚本,约 ~18 分钟):4 个 job 全 success。

- [ ] **Step 8: 验证升级链路 + 本地自动升级**

- 从 v0.1.6 release 下载 `latest.json`,确认 `version === "0.1.6"`,且 `platforms[].url` 全部 HTTP 200(含 macOS `AIProxy.app.tar.gz`)。
- **本地升级实测**:在已安装的 v0.1.5 里点 "Check for Updates" → 应检测到 0.1.6 → Install & Restart → 完成自动升级(验证新 pubkey + `.app.tar.gz` 修复端到端打通)。

---

## Self-Review 记录

- **Spec coverage**:
  - TLS 标准 row + 白名单仅 ON + 去 Alert(OFF warning caption)→ Task 1 ✅
  - focus 重叠修复(外部标题 + 纯 placeholder,去 floating label/compactFieldSx)→ Task 1 ✅
  - up to date → Snackbar toast(autoHide 3000)→ Task 2 ✅
  - checking → 按钮 loading → Task 2 保留(isChecking)✅
  - available → detail + Install 常驻 → Task 2 ✅
  - error → Snackbar(error)→ Task 2 ✅
  - 发版 v0.1.6 + 验证升级 → Task 3 ✅
- **Placeholder scan**:无 TBD/TODO;每步含 exact code 或 exact 命令。
- **Type consistency**:`toast: { message: string; severity: "success" | "error" } | null` 在 state/handler/Snackbar 一致;`AppUpdateInfo` 字段(version/currentVersion)与 `app-updater.ts` 用法一致。
- **已知小风险**:Step 2/4 若 `CheckCircleRoundedIcon` 在移除 ON Alert 后变 unused,需从 import 删除——已在 Step 2 标注。
