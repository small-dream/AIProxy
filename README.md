# AIProxy

AIProxy 是一个面向开发者的跨平台代理调试工具项目，目标能力对标 Charles，并采用独立的 Material Design 桌面体验。

当前仓库已完成：

- `docs/` 需求、架构、接口、UI、工程规范文档
- monorepo 工程骨架
- 桌面端应用入口与 Rust 核心模块占位结构
- 最小 bootstrap 命令链路（查询代理状态、启动代理、停止代理）

## 质量校验

桌面端当前质量命令：

- `pnpm --filter @aiproxy/desktop lint`
- `pnpm --filter @aiproxy/desktop test`
- `pnpm --filter @aiproxy/desktop typecheck`

说明：

- 桌面端 lint 采用 ESLint flat config，配置文件位于 `apps/desktop/eslint.config.mjs`
- 当前版本组合为 `eslint@10.2.0` + `@eslint/js@10.0.1`
- `eslint-plugin-react-hooks@7.0.1` 在安装时仍会对 ESLint 10 给出 peer warning，但当前仓库接受该 warning，且 lint 可正常执行

## 文档入口

- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/API_SPEC.md`
- `docs/UI_GUIDELINES.md`
- `docs/PAGE_BLUEPRINTS.md`
- `docs/ENGINEERING_GUIDELINES.md`
- `docs/SYSTEM_PROXY.md`
- `docs/DECISIONS/ADR-001-frontend-i18n.md`

## 仓库结构

```text
apps/           桌面端应用
crates/         Rust 核心能力模块
packages/       共享类型、UI tokens、工程配置
docs/           需求与架构事实源
fixtures/       测试与调试样本
scripts/        开发、构建、发布脚本
```

## 开发约定

- 任何需求变更先更新 `docs/PRD.md` 与 `docs/ARCHITECTURE.md`
- 所有接口变更同步更新 `docs/API_SPEC.md`
- 所有 UI 规范变更同步更新 `docs/UI_GUIDELINES.md`
- 所有页面结构调整同步更新 `docs/PAGE_BLUEPRINTS.md`
- 所有工程实现遵循 `docs/ENGINEERING_GUIDELINES.md`
- 多语言能力遵循 `docs/DECISIONS/ADR-001-frontend-i18n.md`

## 开发期日志

桌面端开发构建会把结构化调试日志写入以下位置之一：

- 优先：`logs/dev/aiproxy-desktop-dev.log`
- 回退：`%TEMP%\\aiproxy-dev\\logs\\dev\\aiproxy-desktop-dev.log`

当前日志覆盖：

- Tauri 命令调用开始 / 成功 / 失败
- Windows 系统代理快照、接管、恢复、WinINet 刷新
- Rust 代理核心监听、CONNECT 分流、TLS 握手、上游请求开始 / 成功 / 失败
- 前端命令层控制台结构化日志

说明：

- 桌面端每次启动会自动清空旧的 `dev log`，只保留本次运行日志
- 证书已信任时，主界面启动按钮会以 HTTPS 解密模式启动代理

抓包链路排障建议：

1. 在 Certificates 页面生成并信任根证书
2. 点击 `Start HTTPS Proxy`
3. 点击 `Enable System Proxy`
4. 打开一个 `https://` 站点
5. 查看 `logs/dev/aiproxy-desktop-dev.log`
6. 重点搜索 `start_proxy_requested`、`start_proxy_succeeded`、`enable_system_proxy_succeeded`、`listener_started`、`connect_received`、`connect_mitm_started`、`tls_handshake_succeeded`、`upstream_request_started`、`https_request_forwarded`

## 下一步建议

1. 安装 Node.js、pnpm、Rust 与 Tauri 所需系统依赖
2. 执行依赖安装
3. 开始搭建 `apps/desktop` 的基础运行链路
4. 逐步实现代理核心、规则引擎和会话存储

## 当前实现状态

- 前端主工作台已接入 bootstrap 查询
- 首页支持基于共享契约展示代理状态
- Tauri 侧已提供最小状态命令用于后续接入真实代理运行时
- P0-1 已支持本地明文 HTTP 代理捕获与会话列表展示
- P0-2 已支持 HTTPS 证书生成、MITM 解密、系统代理接管
- 手机端抓包：代理绑定 `0.0.0.0`，支持局域网设备连接；Certificates 页面提供二维码下载证书、iOS/Android 配置指引，以及 Android 开发者 ADB 辅助安装
- P0-4 已支持 Compose / Repeat（构造请求与重发）
- P0-5 已支持 Breakpoints（请求/响应阶段断点拦截、查看修改、放行/丢弃/Mock）
- 桌面端已规划双语国际化方案：支持 `中文 / English`，默认跟随系统语言
- 桌面端设置页已支持代理预设管理（端口、SSL）以及应用级语言、外观偏好
- 桌面端主题系统已支持浅色、暗黑与跟随系统，并覆盖应用壳层、卡片、导航、会话视图与 JSON 代码高亮

## 当前可手动验证的 HTTP 抓包闭环

1. 启动桌面应用
2. 点击 `Start Proxy`
3. 将浏览器或系统 HTTP 代理指向 `127.0.0.1:8888`
4. 访问一个明文 `http://` 站点
5. 在 `Sessions` 页面查看捕获到的会话列表

## 当前可手动验证的 HTTPS 抓包闭环

1. 在 Certificates 页面生成根证书
2. 安装并信任根证书（Windows: 点击 Install Certificate）
3. 点击 `Start HTTPS Proxy`
4. 点击 `Enable System Proxy`
5. 访问一个 `https://` 站点
6. 在 `Sessions` 页面查看捕获到的 HTTPS 会话详情

## 当前可手动验证的手机端抓包闭环

1. 确保手机与电脑在同一 Wi-Fi 网络
2. 启动 HTTPS 代理
3. 在 Certificates 页面查看 Mobile Setup Card 中的二维码和 IP 信息
4. 手机扫描二维码下载并安装根证书（iOS 需额外启用证书信任）
5. 手机 Wi-Fi 代理设置为手动，填入电脑 IP 和代理端口
6. 在 `Sessions` 页面查看来自手机的 HTTP/HTTPS 会话

Android 开发者也可以在 Certificates 页的 Android 标签中使用 `ADB Install`，在多台设备/模拟器同时连接时选择目标 serial，将证书推送到对应设备并直接拉起系统安装器。

当前限制：

- HTTPS 证书信任流程跨平台复杂度高
- Android 7+ 默认不信任用户证书，需要额外配置
