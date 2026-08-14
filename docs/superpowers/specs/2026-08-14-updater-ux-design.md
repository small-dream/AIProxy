# 软件更新 UX 重设计

日期:2026-08-14

## 背景

自动升级技术链路已跑通(v0.1.5 → v0.1.6 实测成功)。但当前 UX 不好:

- 必须手动去 Settings → Software Updates 点 "Check for Updates";
- 更新提示只在 Settings 页面,用户不去 Settings 就完全不知道有新版本;
- 检查后反馈单薄,无 changelog。

需参照行业最佳实践(VSCode / Slack)重设计为"更新主动找用户、但非侵入"。

## 设计决策(已与用户对齐)

- **呈现**:角标(ActivityBar Settings 红点)+ 点击弹更新 Dialog。非侵入,用户主动查看。
- **changelog**:release.yml 自动从 git commit log 生成,写入 `latest.json` 的 `notes`。
- **检查频率**:仅启动时检查一次。
- **下载时机**:按需(点"立即更新"才下载,显示进度条)。
- **dismiss**:不持久化。"稍后"= 本次关 Dialog、角标保留;下次启动重新检查仍提示。

## 架构 / 数据流

用 **store-owned** 的 update 状态替代现在 UpdatesSection 的局部 state,让角标、Dialog、Settings 页三处同步:

```text
AppShell 启动 → checkForAppUpdate(静默)→ useShellStore.availableUpdate
                                        ↓ 订阅
   ┌────────────────────────────────────┴──────────────────────┐
   ↓                             ↓                             ↓
ActivityBar                UpdateDialog                  Settings > Updates
Settings 红点           (点角标/菜单触发)            (订阅同一 store)
```

`pendingUpdate` 模块单例(`services/updater/app-updater.ts:8`)保留作 install 句柄。

## 组件设计

### 1. 全局状态:扩展 `useShellStore`

`apps/desktop/src/app/store/app-shell.store.ts`(ephemeral shell state,各处可订阅)新增:

- `availableUpdate: AppUpdateInfo | null`
- `isChecking: boolean`
- `isInstalling: boolean`
- `updateProgress: AppUpdateProgress | null`
- `isUpdateDialogOpen: boolean`
- actions:`setAvailableUpdate(info | null)`、`setUpdateChecking(bool)`、`setUpdateInstalling(bool)`、`setUpdateProgress(progress | null)`、`setUpdateDialogOpen(bool)`

### 2. 启动检查:AppShell mount effect

`apps/desktop/src/components/layout/AppShell.tsx` 新增 mount effect:

- 调 `checkForAppUpdate()`(静默,无 loading 态);
- 成功 → `setAvailableUpdate(info | null)`;
- 失败 → 只 log,不打扰(`setAvailableUpdate(null)`)。

### 3. ActivityBar Settings 红点

`components/layout/AppShellActivityBar.tsx` 的 Settings nav item:现有 `renderNavigationIcon` 的 badge 机制目前只支持数字(`badgeContent?: number`,用于断点计数)。扩展支持"红点"(无数字),当 `useShellStore.availableUpdate` 非空时在 Settings 图标上显示红点。

### 4. UpdateDialog(新组件)

新建 `apps/desktop/src/features/updater/UpdateDialog.tsx`。

- **触发**:点 ActivityBar Settings 红点;菜单 "Check for Updates..."(改 `use-menu-actions.ts` 打开 Dialog 而非 navigate)。
- **内容**:标题"新版本 {version} 可用";changelog(`availableUpdate.body`,从 latest.json notes);按钮"立即更新"(contained)/"稍后"(text)。
- **状态机**:idle →(打开)→ 用户点"立即更新"→ `isInstalling` + 进度条(`updateProgress`)→ `installPendingAppUpdate` 完成后 relaunch(内置)。
- **打开状态**:Dialog 的 open 状态加进 `useShellStore`(`isUpdateDialogOpen` + `setUpdateDialogOpen`),角标点击 / 菜单 / AppShell 统一 toggle。

### 5. UpdatesSection 改造

`pages/settings/index.tsx` 的 `UpdatesSection` 改为订阅 `useShellStore`(删除局部 `availableUpdate`/`isChecking`/`isInstalling`/`progress`/`toast` state):

- 手动 "Check for Updates" 按钮保留作兜底,触发 `checkForAppUpdate()` + 填 store;
- 订阅 store 显示 available detail + Install(与角标/Dialog 一致);
- 手动 check 后若 `availableUpdate === null`,显示"已是最新"toast(短暂反馈用户主动操作的结果);"更新可用"不再用 toast(由角标 + Dialog 表达)。

### 6. changelog 生成(release.yml)

`.github/workflows/release.yml` 的 `Generate updater manifest` 步骤(约 207-280 行):

- 取上一版本到当前的 commit subject:`git log --pretty=format:"- %s" "$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null)"..HEAD`(无上一 tag 时用通用文案);
- 写入 `latest.json` 的 `notes` 字段(替代当前硬编码 `` `AIProxy ${version}` ``);
- `AppUpdateInfo.body`(Tauri 从 notes 读)即被 Dialog 渲染。

## i18n

新增 keys(`settingsPage` 命名空间或新建 `updater`),双语 `en.ts` + `zh-CN.ts`:

- 更新 Dialog:新版本可用标题、changelog 标签、"立即更新"、"稍后"、安装中、重启提示
- ActivityBar / 菜单相关沿用现有

## 改动范围

- `apps/desktop/src/app/store/app-shell.store.ts`:扩展 update 状态 + actions
- `apps/desktop/src/components/layout/AppShell.tsx`:启动检查 effect + 渲染 UpdateDialog
- `apps/desktop/src/components/layout/AppShellActivityBar.tsx`:Settings 红点(扩展 badge 支持 dot)
- `apps/desktop/src/features/updater/UpdateDialog.tsx`(新):更新对话框
- `apps/desktop/src/pages/settings/index.tsx`:UpdatesSection 订阅 store
- `apps/desktop/src/components/layout/hooks/use-menu-actions.ts`:菜单触发 Dialog
- `apps/desktop/src/i18n/messages/{en,zh-CN}.ts`:新文案
- `.github/workflows/release.yml`:changelog 生成 + notes 写入
- 不动 Rust / updater 后端 / 签名链路 / pubkey

## 不做(YAGNI)

- 强制更新(不阻断使用)
- 后台预下载(按需)
- 运行中定时轮询(仅启动检查)
- dismiss 持久化(下次启动仍提示)

## 验证

- 桌面端四件套:`format:check` + `typecheck` + `lint` + `test`
- 组件测试:UpdateDialog 状态机(idle → installing → relaunch)、`useShellStore` update actions
- 本地 dev:启动检查 → 角标出现 → 点开 Dialog → changelog 显示 → 更新流程
- 发版验证:latest.json `notes` 含 commit changelog;Dialog 渲染 body
