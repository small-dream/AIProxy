# Pharles

Pharles 是一个面向开发者的跨平台代理调试工具项目，目标能力对标 Charles，并采用独立的 Material Design 桌面体验。

当前仓库已完成：

- `docs/` 需求、架构、接口、UI、工程规范文档
- monorepo 工程骨架
- 桌面端应用入口与 Rust 核心模块占位结构
- 最小 bootstrap 命令链路（查询代理状态、启动代理、停止代理）

## 文档入口

- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/API_SPEC.md`
- `docs/UI_GUIDELINES.md`
- `docs/PAGE_BLUEPRINTS.md`
- `docs/ENGINEERING_GUIDELINES.md`
- `docs/SYSTEM_PROXY.md`

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

## 开发期日志

桌面端开发构建会把结构化调试日志写入以下位置之一：

- 优先：`logs/dev/pharles-desktop-dev.log`
- 回退：`%TEMP%\\pharles-dev\\logs\\dev\\pharles-desktop-dev.log`

当前日志覆盖：

- Tauri 命令调用开始 / 成功 / 失败
- Windows 系统代理快照、接管、恢复、WinINet 刷新
- Rust 代理核心监听、请求进入、转发成功、转发失败、CONNECT 拒绝
- 前端命令层控制台结构化日志

抓包链路排障建议：

1. 点击 `Start Proxy`
2. 点击 `Enable System Proxy`
3. 打开 `http://neverssl.com`
4. 查看 `logs/dev/pharles-desktop-dev.log`
5. 重点搜索 `start_proxy_requested`、`start_proxy_succeeded`、`enable_system_proxy_succeeded`、`listener_started`、`request_forwarded`

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

## 当前可手动验证的 HTTP 抓包闭环

1. 启动桌面应用
2. 点击 `Start Proxy`
3. 将浏览器或系统 HTTP 代理指向 `127.0.0.1:8888`
4. 访问一个明文 `http://` 站点
5. 在 `Sessions` 页面查看捕获到的会话列表

当前限制：

- 仅支持明文 HTTP 代理请求
- HTTPS `CONNECT` 隧道与证书解密尚未接入
