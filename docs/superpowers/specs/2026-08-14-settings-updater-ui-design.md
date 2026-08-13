# 设置页 UI 优化:Verify Upstream TLS 布局 + 更新状态 toast

日期:2026-08-14

## 背景

设置页两处 UI 问题:

1. **Verify Upstream TLS 控件**:`Switch` + 标题/描述 与 `tlsVerifyHosts` 多行输入框并排挤在同一行(md 宽度的 horizontal Stack),视觉拥挤。
2. **"AIProxy is up to date."**:检查更新后常驻显示在 `UpdatesSection` 的 feedback Alert 里,不符合行业做法——应只在检查后临时出现并自动消失。

## 设计决策

### 1. TLS 控件布局(方案 A:开关在上、白名单在下)

**现状**:`pages/settings/index.tsx` 的 `ProxySettingsSection`,Switch + `FormControlLabel`(body2 标题 + caption 描述) 与 `tlsVerifyHosts` 多行 `TextField` 在 horizontal Stack 并排;下方一个常驻 `Alert`(ON=success hint / OFF=warning hint)。

**改为**:

- **标准 setting row**:标题 + 描述在左,Switch 在右(单行,垂直居中)。
- **`tlsVerifyHosts` 多行输入框移到 Switch 下方,仅在 `verifyUpstreamTls === true` 时渲染**(关闭时完全隐藏,减少视觉负担)。
- **移除常驻 Alert**:
  - Switch 状态由控件本身体现。
  - **OFF 时**:在描述下方显示一行 warning 色 caption(复用 `verifyUpstreamTlsDisabledHint` 文案,可适当精简),提醒"不安全"。
  - **ON 时**:不显示额外提示(Switch 已表明开启 + 白名单输入框出现);`verifyUpstreamTlsEnabledHint` 不再渲染(i18n key 保留不删,避免牵连)。
- i18n keys 复用现有(`verifyUpstreamTls` / `verifyUpstreamTlsDescription` / `tlsVerifyHosts` / `tlsVerifyHostsPlaceholder` / `verifyUpstreamTlsDisabledHint`)。

### 2. 更新状态提示(Snackbar toast)

**现状**:`UpdatesSection` 有一个常驻 feedback `Alert`,初始 `updatesIdle`,检查后变 `updatesNone`("AIProxy is up to date.")等,一直显示。

**改为**:

- **移除常驻 feedback Alert**(初始不再显示 `updatesIdle`)。
- 状态映射:
  - **idle**:无提示,只有 "Check for Updates" 按钮
  - **checking**:按钮 loading(文案 `updatesCheckingAction`),不发 toast
  - **up-to-date**:`Snackbar`(severity success)"AIProxy is up to date.",`autoHideDuration={3000}` 自动消失
  - **available**:保留常驻 Alert(`updatesAvailable` 详情)+ "Install & Restart" 按钮(有操作,不消失)
  - **error**:`Snackbar`(severity error)错误信息,`autoHideDuration` 自动消失
- 复用项目已有 Snackbar 模式(参考 `features/sessions/use-session-context-actions.ts` 的 `showSnackbar` / `handleSnackbarClose`)。
- 现有触发不变:手动按钮 + 应用菜单 "Check for Updates..."(`aiproxy-check-for-updates` 事件)。

## 改动范围

- `apps/desktop/src/pages/settings/index.tsx`:`ProxySettingsSection`(TLS 区,约 304-366 行)+ `UpdatesSection`(约 400-526 行)
- `apps/desktop/src/i18n/messages/en.ts`、`zh-CN.ts`:若 helper/disabledHint 文案需精简则同步
- **不动**:Rust / shared-types / Tauri 命令 / updater 后端逻辑 / 签名发布链路

## 不做(YAGNI)

- 不加自动检查 / 定时轮询(保持手动按钮 + 菜单触发)
- 不加跨页面"更新可用"徽章(需新增共享 store,超出本次范围)
- 不改 updater 签名 / 发布链路(已在 v0.1.5 修复并验证)

## 验证

- 桌面端:`pnpm --filter @aiproxy/desktop typecheck && lint && test`
- 本地 dev 跑设置页,目视确认:TLS 标准 row;白名单仅 ON 时显示;OFF 时 warning caption;检查更新→"已是最新"toast 约 3s 消失;"有更新"保留详情 + Install 按钮
- 发版 v0.1.6 → 本地 v0.1.5 触发自动升级,端到端验证(覆盖 `.app.tar.gz` 修复 + 新 pubkey 链路)
