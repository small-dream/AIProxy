# AIProxy AGENTS.md

这是 AIProxy 仓库的通用协作指导文件（AGENTS.md），供所有 AI 编码工具（Claude Code、Codex、Cursor、GitHub Copilot、Gemini CLI 等）和协作者参考。内容按“短、具体、可执行”的原则编写，重点记录这个项目里高频且稳定的协作约束。

## 1. 项目概览

- AIProxy 是一个面向开发者的跨平台代理调试工具，产品方向对标 Charles。
- 当前主应用是 `apps/desktop`。
- 这是一个 monorepo，包含桌面端、Rust 核心模块、共享 TypeScript 包和项目文档。

## 2. 技术栈

- 桌面壳：`Tauri 2`
- 前端：`React 19` + `TypeScript` + `Vite`
- UI：`MUI`
- 前端状态：`Zustand` + `TanStack Query`
- 路由：`React Router`
- 核心能力：`Rust`
- 前端测试：`Vitest` + `Testing Library`

## 3. 目录速览

- `apps/desktop`：桌面端前端与 Tauri 应用
- `crates`：Rust 核心模块，如代理、规则、导出、TLS、会话存储
- `packages/shared-types`：前后端共享契约
- `packages/ui-tokens`：共享设计令牌
- `docs`：需求、架构、API、UI、页面蓝图、工程规范事实源
- `scripts`：开发、构建、发布脚本

## 4. 文档事实源

涉及结构性改动前，先查对应文档：

- `docs/PRD.md`：产品目标与范围
- `docs/ARCHITECTURE.md`：系统分层、模块边界、职责划分
- `docs/API_SPEC.md`：命令、事件、数据模型契约
- `docs/UI_GUIDELINES.md`：UI 规范与交互规则
- `docs/PAGE_BLUEPRINTS.md`：页面结构、状态模型、事件流
- `docs/ENGINEERING_GUIDELINES.md`：工程质量基线
- `docs/DECISIONS/ADR-001-frontend-i18n.md`：前端国际化约束
- `docs/SYSTEM_PROXY.md`：系统代理与平台差异说明

代码改动如果会让这些文档过时，必须在同一任务里同步更新。

## 5. 语言约定

- 与用户的沟通回复、项目文档（AGENTS.md、docs/ 等）统一使用**中文**。
- 代码注释统一使用**英文**。
- Commit 信息（subject 与 body）统一使用**英文**，遵循 Conventional Commits 格式（见 `CONTRIBUTING.md`）。
- 用户可见的 UI 文案遵循 i18n 双语机制，不在此约束范围内。

## 6. 默认工作方式

- 优先做收敛式修改，不要无关扩散。
- 优先复用现有模块、类型、helpers，不要平铺式新增重复实现。
- 保持前端表现层、命令/服务层、Rust 领域层边界清晰。
- 不要为了“未来可能会用到”而提前做大抽象。
- 修改前先看相邻实现，优先沿用既有命名、结构和风格。
- 遇到架构或 UX 相关任务，先读文档，不要靠猜。
- **所有代码必须考虑跨平台适配**：涉及系统交互的功能必须同时处理 Windows、macOS、Linux 三个平台。

## 7. 前端约束

- 前端主目录是 `apps/desktop/src`。
- 目录职责遵循现有分层：
  - `pages/*`：路由级页面
  - `features/*`：业务域逻辑与页面内功能组件
  - `components/*`：共享 UI / layout 组件
  - `services/*`：命令、事件、日志等接入层
  - `i18n/*`：国际化资源与能力
- 桌面端优先使用现有 `@/` 路径别名。
- 用户可见文案禁止直接硬编码到组件里，必须同步维护：
  - `apps/desktop/src/i18n/messages/en.ts`
  - `apps/desktop/src/i18n/messages/zh-CN.ts`
- 保持现有桌面优先的 MUI 视觉与交互风格，不要在单个页面里引入冲突的设计语言。

## 8. Rust 与共享契约约束

- 前后端共享数据结构优先收敛到 `packages/shared-types`。
- Tauri command 的行为、参数和返回值要与 `docs/API_SPEC.md` 保持一致。
- 平台相关差异要显式处理并记录，不要隐藏为“偶发现象”。
- 关键链路优先补结构化日志，而不是静默失败。

## 9. 文档同步规则

- 需求或范围变化：更新 `docs/PRD.md`
- 架构或模块边界变化：更新 `docs/ARCHITECTURE.md`
- API / command / event / shared types 变化：更新 `docs/API_SPEC.md`
- UI 模式或交互变化：更新 `docs/UI_GUIDELINES.md`
- 页面结构、状态模型、事件流变化：更新 `docs/PAGE_BLUEPRINTS.md`
- 工程规则变化：更新 `docs/ENGINEERING_GUIDELINES.md`
- 用户可见文案变化：同时更新中英文消息文件

注意：页面交互改动通常需要同时更新 `docs/UI_GUIDELINES.md` 和 `docs/PAGE_BLUEPRINTS.md`。

## 10. 质量要求

- 新增或修改逻辑时，优先为纯函数、映射、解析、校验、状态变换补测试。
- 不要留下空 `catch`；如果必须降级，需要有明确原因和用户/日志侧反馈。
- 错误处理应提供足够上下文，便于 UI 提示或日志排障。
- 重要改动完成后，至少运行与改动最相关的 lint、test、typecheck。

## 11. 常用命令

在仓库根目录运行：

- 安装依赖：`pnpm install`
- 启动桌面端开发：`pnpm --filter @aiproxy/desktop dev`
- 桌面端 lint：`pnpm --filter @aiproxy/desktop lint`
- 桌面端 test：`pnpm --filter @aiproxy/desktop test`
- 桌面端 typecheck：`pnpm --filter @aiproxy/desktop typecheck`
- 全仓 lint：`pnpm lint`
- 全仓 test：`pnpm test`
- 全仓 typecheck：`pnpm typecheck`
- 清理构建缓存（Rust target + Vite 缓存）：`pnpm clean`

常用封装脚本：

- `pnpm desktop:run`
- `pnpm desktop:build`
- `pnpm desktop:bundle`

## 12. 调试与排障

- 开发日志优先看 `logs/dev/aiproxy-desktop-dev.log`。
- 代理、证书、系统代理、手机抓包问题优先结合日志和文档排查，不要只根据 UI 现象猜测。
- HTTPS、证书信任、系统代理接管在不同平台上差异明显，修改相关代码时要保留平台保护和说明。

## 13. 发布流程

详细指南见 `docs/RELEASE_GUIDE.md`（事实源），发布相关命令在 `scripts/release-checklist.sh` 与 `.github/workflows/release.yml`。核心步骤：

1. **同步版本号**：`package.json`、`Cargo.toml`、`Cargo.lock`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json` 五处必须保持一致。
2. **质量门禁**：运行 `scripts/release-checklist.sh`（typecheck / lint / test / Rust tests / clippy），并确认 GitHub Actions CI 通过。
3. **打包验证**：脚本不支持跨平台打包，必须在对应原生宿主机上执行 `pnpm desktop:bundle:<platform>` 验证产物。
4. **发布摘要**：在创建 tag 前新增 `docs/releases/v<版本号>.md`；文件名必须与 tag 一致，且必须包含中文 `更新内容` 和英文 `What's new`。该文件是 GitHub Release 与应用内更新的唯一更新内容来源，详见 `docs/releases/README.md`。
5. **触发发布**：仅从 `v*` tag 触发 `release.yml`；workflow 会校验发布摘要，随后在 macOS / Windows / Linux 三端打包并发布 GitHub Release。含 `-test` / `-beta` 的 tag 会标记为 pre-release。
6. **签名与自动更新**：updater 产物（`.sig`、`latest.json`）仅在配置 `TAURI_SIGNING_PRIVATE_KEY` 时生成；未配置则发布普通安装包且不阻塞流程。安装、自动更新和未签名风险提示由工作流根据实际产物追加，禁止在发布摘要中硬编码签名状态。
7. **发布后验证**：验证自动更新（旧版本检测新版本、安装并重启后版本生效）与系统代理恢复。
8. **回滚**：阻断问题先标记问题版本为 pre-release，将 `latest.json` 回滚到上一稳定版本，再发布修复版本并在 Release Notes 说明。

## 14. 在这个仓库里，好的改动应当是

- 符合当前模块边界
- 与文档保持一致
- 不破坏双语体验
- 覆盖三个平台（Windows / macOS / Linux），或为不支持的平台提供合理的 fallback
- 带有必要的验证或测试
- 让后续协作者更容易理解，而不是更依赖上下文猜测
