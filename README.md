# Pharles

Pharles 是一个面向开发者的跨平台代理调试工具项目，目标能力对标 Charles，并采用独立的 Material Design 桌面体验。

当前仓库已完成：

- `docs/` 需求、架构、接口、UI、工程规范文档
- monorepo 工程骨架
- 桌面端应用入口与 Rust 核心模块占位结构

## 文档入口

- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/API_SPEC.md`
- `docs/UI_GUIDELINES.md`
- `docs/ENGINEERING_GUIDELINES.md`

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
- 所有工程实现遵循 `docs/ENGINEERING_GUIDELINES.md`

## 下一步建议

1. 安装 Node.js、pnpm、Rust 与 Tauri 所需系统依赖
2. 执行依赖安装
3. 开始搭建 `apps/desktop` 的基础运行链路
4. 逐步实现代理核心、规则引擎和会话存储

