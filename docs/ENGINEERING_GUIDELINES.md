# AIProxy Engineering Guidelines

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：工程开发规范
- 当前阶段：`P3 / 持续改进完成后的治理基线`
- 文档状态：`Living Spec v1.4`（P3 更新：DbError、proxy-core 模块边界、rule-engine 拆分、前端大型页面拆分约束）
- 关联文档：
  - `docs/PRD.md`
  - `docs/ARCHITECTURE.md`
  - `docs/API_SPEC.md`
  - `docs/UI_GUIDELINES.md`

## 2. 目的

本规范用于统一 AIProxy 项目的代码质量标准、设计约束、测试要求与文档同步要求，作为团队成员与 AI 协作开发时的默认执行标准。

所有后续实现、重构、修复与扩展，均应优先遵循本规范；若与业务需求冲突，应先更新相关文档并明确决策原因。

## 3. 全局原则

- 优先采用官方最佳实践与惯用写法
- 优先复用既有模块，而非重写
- 优先做收敛式改动，避免不必要的连锁影响
- 优先通过类型、约束、测试和日志保证可靠性
- 优先通过抽象隔离变化点，而非在多个位置散落条件分支
- **所有代码必须考虑跨平台适配**：任何涉及系统交互的功能都必须同时处理 Windows、macOS、Linux 三个平台

## 4. 跨平台适配要求

AIProxy 是跨平台桌面工具（Windows / macOS / Linux），所有代码必须遵循以下约束：

### 4.1 平台特定代码隔离

- 平台特定实现必须通过 Rust 的 `#[cfg(target_os)]` 条件编译隔离，禁止在业务逻辑中混入平台判断
- 每个平台相关能力必须提供三个平台的实现或显式的 unsupported fallback
- 平台模块必须遵循统一接口契约（函数签名、返回类型、错误处理方式一致）
- 禁止在非平台模块中直接使用平台专有 API
- 参考 `proxy-core` 的 `types.rs` / `types_unix.rs` / `types_windows.rs` 拆分模式：共享代码在 `types.rs`，通过 `#[cfg(unix)]` / `#[cfg(windows)]` 的 `#[path = ...] mod platform` 委托平台实现

### 4.2 系统交互领域

以下领域涉及平台差异，任何新增或修改必须同时处理三个平台：

| 领域 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 系统代理 | 注册表 + WinINet | networksetup | gsettings / kwriteconfig6 |
| 证书信任检测 | PowerShell + Cert store | security verify-cert | 系统 CA 目录扫描 |
| 证书安装器 | rundll32 | Keychain Access | xdg-open |
| 网络接口枚举 | PowerShell Get-NetIPAddress | libc getifaddrs | libc getifaddrs |

### 4.3 文件路径与系统命令

- 文件路径必须使用 `std::path::Path` / `PathBuf` 或 `path.join()`，禁止硬编码路径分隔符
- 调用外部命令前必须检查命令是否存在或提供 fallback
- 配置文件目录使用 `dirs` crate 获取平台标准路径
- 日志文件路径通过 `discover_workspace_root_from_current_exe()` 或 `env::temp_dir()` 解析

### 4.4 前端跨平台约束

- 前端不得假设当前运行平台，必须通过 Tauri API 或后端返回的 `platform` 字段判断
- 非 Tauri 运行时的 fallback 代码必须动态检测平台，禁止硬编码为任一特定平台
- 用户可见的平台相关文案（如证书安装步骤）必须通过 i18n 系统，按平台提供正确的引导内容
- UI 交互不能仅针对某一平台设计（如 macOS overlay titlebar），需为其他平台提供合理的 fallback
- 标题栏、菜单栏和窗口控制属于平台集成边界：macOS 使用原生系统菜单；Windows / Linux 使用自绘菜单栏时，菜单项 ID 必须复用同一套 `AppShell` 命令分发语义，并在 Tauri capabilities 中显式声明窗口 API 权限

### 4.5 新增平台能力的检查清单

新增任何涉及系统交互的功能时，必须确认：

1. Rust 端是否需要 `#[cfg(target_os)]` 条件编译？
2. 是否为三个平台都提供了实现或合理的 fallback？
3. 前端是否有平台相关的展示逻辑？是否覆盖了所有平台？
4. i18n 是否为新平台的引导文案提供了翻译？
5. 是否已更新 `docs/SYSTEM_PROXY.md`（系统代理）、`docs/API_SPEC.md`（命令行为）等相关文档？

## 5. 设计与架构要求

### 5.1 官方最佳实践

- 遵循所选技术栈的官方最佳实践与 idiomatic style
- 不重复造轮子；引入第三方库前先评估是否已有稳定官方或社区事实标准
- 若需偏离官方推荐方案，必须在相关文档中记录原因与影响

### 5.2 设计模式使用原则

- 设计模式只在解决真实复杂度时引入
- 优先考虑策略模式、工厂模式、观察者模式等简单直接的模式
- 禁止为”未来可能会用到”而过度抽象

### 5.3 SOLID 原则

- 单一职责：模块、类、函数只解决一个问题
- 开闭原则：新增功能优先通过扩展实现
- 里氏替换：抽象与实现保持行为一致
- 接口隔离：接口只暴露必要能力
- 依赖倒置：高层模块依赖抽象，不依赖细节实现

### 5.4 改动收敛原则

- 优先修改现有模块，而不是新增重复模块
- 优先局部调整，而不是跨层重写
- 禁止顺手修复与当前任务无关的问题，除非该问题会阻塞目标实现

### 5.5 重构后模块边界硬约束

以下边界是 `c675a5026bf1824e652ccaf06d91944df289992a` 之后的治理结果，后续开发必须维持：

- `proxy-core` 不允许恢复单文件巨型实现：
  - HTTP 代理主链路归入 `http_proxy.rs`
  - WebSocket upgrade、101/非 101 响应处理与 WS relay 建立归入 `ws_upgrade.rs`
  - CONNECT blind relay、MITM TLS 与 CONNECT 相关 response head 读取归入 `connect.rs`
  - 上游请求转发、响应读取与 body spool helper 归入 `upstream.rs`
  - 连接上下文归入 `connection.rs`
  - 请求/响应 I/O 工具归入 `http_io.rs`
  - 共享运行时上下文归入 `context.rs`
  - 结构化代理错误归入 `error.rs`
  - 跨平台共享类型与 IP 探测归入 `types.rs`，平台特定实现分别归入 `types_unix.rs` 和 `types_windows.rs`
  - 规则能力归入 `rules/` 目录，不允许重新创建顶层 `rules.rs`
- `bootstrap/mod.rs` 只保留 `AppState` 聚合、初始化、运行时状态和公共 API 编排：
  - DB 读写与 body store 访问归入 `bootstrap/repository.rs`
  - session 内存缓存归入 `bootstrap/cache.rs`
  - DB row 与 domain/shared 类型转换归入 `bootstrap/converters.rs`
  - Tauri event emit 归入 `bootstrap/events.rs`
- `aiproxy-rule-engine` 不允许恢复 monolithic `lib.rs`：
  - 脚本规则与 trace 类型归入 `types.rs`
  - TypeScript 转译、导出校验和 entrypoint 检测归入 `compile.rs`
  - QuickJS 沙箱执行和 request/response hook 归入 `execute.rs`
  - JS host bridge 与 runtime module 构造归入 `js_bridge.rs`
  - `lib.rs` 只保留模块声明、public re-export 和测试
- 前端大型页面必须按“页面负责布局、hook 负责状态流程、helper 负责纯计算、service 负责命令调用”的方式拆分。新增复杂交互时优先扩展 `features/<domain>/` 下的 hook/helper/component，不把业务流程堆回 `pages/<domain>/index.tsx`。
- 三层同构命令架构必须保持一致：Rust `commands/<domain>.rs`、前端 `services/commands/<domain>.ts`、共享类型 `packages/shared-types/src/<domain>.ts` 同步演进。
- 已删除的空壳 crate（`session-store`、`throttle-engine`、`exporter`）不得仅为占位重新加入；只有当存在可独立测试、可复用的真实领域逻辑时，才允许新增 crate，并需同步架构文档或 ADR。

## 6. 可读性与可维护性要求

### 6.1 命名规范

- 命名必须清晰、自解释
- 避免不必要缩写
- 常量必须提取并命名，禁止散落魔法值
- 类型、接口、组件、服务命名必须反映职责边界

### 6.2 函数与模块约束

- 函数/方法保持短小，聚焦单一职责
- 控制圈复杂度，避免深层嵌套
- 模块接口应稳定、易理解、易测试
- 文件大小应保持精简，避免单文件承载多个独立责任

### 6.3 注释原则

- 注释只解释“为什么”，不解释“做了什么”
- 对复杂边界、协议差异、平台限制、性能权衡等场景必须解释原因
- 如果代码本身不清晰，应先重构代码，再考虑补充注释

## 7. 健壮性要求

### 7.1 输入校验

- 所有外部输入必须做防御性校验
- 明确处理空值、非法值、越界值、格式错误和平台差异
- 对文件路径、端口、规则配置、导出目标等高风险输入进行额外约束

### 7.2 异常处理

- 异常处理必须具体，不允许空 `catch`
- 禁止直接吞掉异常
- 需要降级时，应明确降级策略与用户可感知反馈
- 错误信息必须包含足够上下文，便于定位
- Tauri command 边界保持 `Result<T, String>`，但错误字符串必须使用 `commands/common.rs` 的 `app_error()` / `app_error_with_details()` 生成 JSON 错误载荷；禁止新增裸字符串错误作为用户可见 command 失败。
- `proxy-core` 核心代理路径优先使用 `ProxyError` 表达错误语义。仅限解析/转换/纯 helper 等局部边界可返回 `String`，向代理主流程或 Tauri 边界传播前必须补足上下文并映射为结构化错误。
- `crates/db` 公共 API 必须返回 `Result<T, DbError>`，禁止新增公共 `Result<T, String>`。新增 `DbError` variant 前需确认现有 `Connection` / `QueryFailed` / `NotFound` / `ConstraintViolation` / `MigrationFailed` / `Validation` / `Io` 是否足够表达语义。
- DB 列表查询失败不得静默返回空数组。真实空状态返回 `Ok(vec![])`，prepare/query/row decode/IO 失败返回 `DbError`，并由 Tauri command 边界转换为结构化 `app_error()`。
- 处理 `rusqlite::MappedRows` 时禁止使用 `.filter_map(|row| row.ok())` 或等价写法吞掉坏行；必须 `collect::<Result<Vec<_>, _>>()` 并把 row decode 错误映射为 `DbError::query("decode ...", err)`。
- React ErrorBoundary：所有页面级组件必须被 ErrorBoundary 包裹。全局 ErrorBoundary 位于 `AppProviders` 内（`CssBaseline` 之后），页面级 ErrorBoundary 包裹每个 lazy route。Fallback 必须使用 MUI 组件（禁止纯文本），并提供「重试」与「重载应用」两个操作按钮

### 7.3 结构化日志

- 关键逻辑和异常路径必须记录结构化日志
- 日志应包含上下文信息：`who / what / when / why`
- 日志框架使用 `tracing` 生态，通过 `tracing` 宏输出：
  - `tracing::debug!`：调试细节、流程节点
  - `tracing::info!`：关键状态变化、正常业务事件
  - `tracing::warn!`：可恢复异常、降级处理、非致命风险
  - `tracing::error!`：失败、异常终止、数据不一致、关键流程中断
- 结构化日志字段格式保持不变：timestamp、level、component、event、key=value pairs
- Rust 核心 crate 必须直接使用 `tracing::debug!/info!/warn!/error!` 宏；禁止重新引入 `emit_log` 这类会提前分配字段的自定义日志函数。

### 7.4 日志约束

- 默认不记录敏感信息明文
- 请求/响应 Body 如需打印，必须脱敏或截断
- 错误日志应可定位到模块、动作、对象和原因

### 7.5 开发期日志落地要求

- 开发阶段必须保证日志可直接落盘，不能只停留在控制台输出
- 文件写入通过 `tracing_appender::non_blocking` 缓冲，避免阻塞业务线程
- 日志文件位置必须写入文档，并保持稳定可查
- 核心链路至少覆盖：
  - 应用启动
  - Tauri Command 调用
  - 系统代理切换
  - 代理监听启动与停止
  - 请求进入、转发成功、转发失败
  - panic 与未处理错误
- 当 UI 上出现泛化错误提示时，必须同步确保日志里存在可定位的真实错误信息

### 7.6 Tauri 安全约束（CSP）

- `tauri.conf.json` 必须配置 `security.csp` 和 `security.devCsp` 两个字段，分别覆盖生产与开发环境
- 生产环境 CSP 不得设为 `null` 或留空，必须显式声明允许的资源来源
- 开发环境 CSP（`devCsp`）可适当放宽以支持 HMR / devtools，但仍需明确配置，不得省略

## 8. 可扩展性要求

### 8.1 变化点隔离

- 对规则引擎、导出格式、协议处理、存储策略等变化点，应通过抽象隔离
- 新增能力应尽量通过扩展新实现接入，而不是修改多个历史模块

### 8.2 配置与逻辑分离

- 配置不得硬编码在业务逻辑中
- 默认值应集中管理并命名
- 环境相关配置、主题配置、端口配置、功能开关应独立定义

### 8.3 前端静态质量基线

- 桌面端前端静态校验默认执行：
  - `pnpm --filter @aiproxy/desktop lint`
  - `pnpm --filter @aiproxy/desktop typecheck`
  - `pnpm --filter @aiproxy/desktop test`
- ESLint 使用 flat config，配置文件位于 `apps/desktop/eslint.config.mjs`
- 当前桌面端 lint 基线基于：
  - `eslint@10.2.0`
  - `@eslint/js@10.0.1`
  - `typescript-eslint`
  - `eslint-plugin-react-hooks`
- 当前仓库接受 `eslint-plugin-react-hooks` 对 ESLint 10 的 peer warning，前提是：
  - 安装成功
  - `pnpm --filter @aiproxy/desktop lint` 可稳定通过
  - 不因规避 warning 而回退已启用的 lint 基线
- 若后续插件发布明确支持 ESLint 10 的正式版本，应优先升级并移除该说明

### 8.4 共享类型与查询 Key

- `BodyType`、`RawLanguage`、会话查询 key 等跨组件契约必须集中定义，禁止在页面、store 或 hook 中重复声明同名常量/类型。
- 前端与 Rust 命令载荷发生字段增删时，必须同步更新 `packages/shared-types`、命令客户端 parser、Rust command payload 以及 `docs/API_SPEC.md`。
- Session detail 字段采用 deferred body/raw 策略时，轻量 payload 与补丁 payload 的字段边界必须在 API 文档中说明；禁止为省事直接返回大 body 导致 UI 卡顿或内存风险。

### 8.5 规则热路径约束

- Rewrite、Script、Breakpoint 等支持 regex 的规则必须在 manager 加载/保存阶段预编译并缓存，热路径禁止每次请求 `Regex::new()`。
- 无效 regex 规则必须 fail-open：记录 `warn`，该规则不参与匹配，不得导致代理主链路 panic 或中断。
- 规则执行顺序、fail-open/fail-closed 策略、trace 落库字段属于用户可解释性契约，修改前必须更新架构文档与相关测试。

## 9. 测试要求

### 9.1 单元测试

- 所有新增和修改的代码必须补充单元测试
- 至少覆盖：
  - 正常路径
  - 边界条件
  - 异常场景

### 9.2 测试编写原则

- 测试遵循 `AAA` 模式：
  - `Arrange`
  - `Act`
  - `Assert`
- 每个测试用例只验证一个行为
- 测试必须可独立运行、可重复执行、无外部依赖
- 测试名称应准确表达预期行为

### 9.3 测试边界

- 对纯函数、转换器、校验器、规则匹配器必须优先做单测
- 对关键集成流程补充集成测试
- 对异常路径和错误映射必须有覆盖

### 9.4 性能基线

#### 压力测试夹具

使用 `scripts/generate-stress-fixtures.ts` 生成大规模测试数据，输出到 `fixtures/stress/`：

- 10k sessions：验证虚拟滚动在大数据量下的渲染性能
- 1k WS messages：验证 WebSocket 消息列表的滚动流畅度
- 50MB body：验证大 Body 场景下代理和 UI 的稳定性

#### 验收阈值

| 场景 | 阈值 |
| ------ | ------ |
| 10k sessions 渲染 | 必须使用虚拟滚动，无明显卡顿 |
| 1k WS messages 滚动 | 滚动流畅，无掉帧 |
| 50MB body 处理 | 代理和 UI 均不崩溃 |

#### 发布检查清单

每个里程碑发布前必须运行 `scripts/release-checklist.sh`，该脚本依次执行：

1. `typecheck`
2. `lint`
3. 前端测试
4. Rust 测试
5. `clippy`

### 9.5 属性测试（Property-Based Testing）

- 项目已引入 `proptest` 作为属性测试框架（`proxy-core` 和 `db` crate 的 dev-dependencies）
- 属性测试适用于需要大范围输入空间覆盖的场景，如：
  - URL pattern 匹配与 rewrite 逻辑
  - 网络地址解析与格式化
  - HTTP header 清洗与 CRLF 注入防护
  - 数据库查询参数构造与 SQL 注入防护
  - JSON 序列化/反序列化边界
  - 路径安全校验（path traversal）
- 属性测试不替代单元测试，而是补充覆盖难以手动枚举的边界组合
- 新增属性测试时应在测试文件头部 `use proptest::prelude::*;` 并通过 `proptest!` 宏定义策略

## 10. 文档要求

### 10.1 文档同步原则

- 修改代码前，先确认是否需要更新文档
- 如需求、架构、接口、目录结构、主题规范发生变化，必须先更新对应文档

### 10.2 必须同步的文档

- `README.md`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/API_SPEC.md`
- `docs/UI_GUIDELINES.md`
- `CHANGELOG.md`（若项目引入）

### 10.3 接口变更要求

- 如有接口变更，必须同步更新接口说明与示例
- 如有数据模型变更，必须同步更新 schema、事件和调用约束

## 11. AI 协作要求

- AI 生成代码必须遵循本规范和双文档驱动原则
- 任何结构性改动都应先检查 `docs/PRD.md` 与 `docs/ARCHITECTURE.md`
- AI 修改代码时优先在既有模块内收敛处理，避免平铺式新增重复实现
- AI 提交实现时应说明：
  - 改动原因
  - 影响范围
  - 测试覆盖
  - 是否同步更新文档

## 12. 落地执行清单

后续每次开发任务默认检查以下事项：

- 是否遵循现有架构边界
- 是否复用已有模块与类型
- 是否做输入校验与异常处理
- 是否补充结构化日志
- 是否补充单元测试
- 是否同步更新相关文档
- **是否为三个平台（Windows / macOS / Linux）都提供了实现或合理的 fallback**

## 13. 优先级说明

若出现规范冲突，按以下优先级执行：

1. 用户明确要求
2. `docs/PRD.md`
3. `docs/ARCHITECTURE.md`
4. `docs/API_SPEC.md`
5. `docs/UI_GUIDELINES.md`
6. `docs/ENGINEERING_GUIDELINES.md`

如需偏离本规范，必须先在文档中记录原因。

## 14. M2 实现约束

### 14.1 hyper 与 reqwest 使用边界

`proxy-core` 中 `forward_request()` 使用 `hyper` 替代 `reqwest`，通过自定义 `TimingConnector` 采集全部 7 个 timing 阶段。以下是使用边界：

- `forward_request()`（代理捕获路径）：使用 `hyper` + `TimingConnector`，可采集 dns / connect / tls / request_send / waiting / response_read / total
- `send_direct_request()`（Compose 路径）：继续使用 `reqwest`，仅提供 totalMs / waitingMs / responseReadMs
- `TimingConnector` 实现 `hyper::service::Service` trait，通过 `Instant` 时间戳计算各阶段耗时
- `timing_source` 字段（`"proxy" | "compose" | "har-import"`）标识 timing 数据来源，前端 `WaterfallChart` 据此调整展示粒度
- 新增 HTTP 客户端能力时，应优先评估是否需要完整 timing 采集；如果需要，应复用 `TimingConnector` 模式而非重新实现
- 客户端 TLS 配置统一由 `tls-manager::client` 提供（`build_dangerous_client_config` / `build_dangerous_tls_connector_with_alpn`），`proxy-core` 不再自行构建 `ClientConfig`；详见 `docs/DECISIONS/ADR-003-proxy-http-client-strategy.md`

### 14.2 Insights SQL 查询性能

Insights 页面通过 SQLite 聚合查询提供统计分析。以下是性能约束：

- `compute_insights()` 应优先使用 SQLite 聚合查询，避免把完整会话列表加载到前端或 Rust 内存中再统计
- Host 分组统计、状态码分布、方法分布使用 `GROUP BY` 聚合，不加载完整会话列表到内存
- 慢请求排名使用 `ORDER BY duration_ms DESC LIMIT N`，避免无限制排序
- P50/P95/P99 使用有界查询结果计算；host 级 P95 子查询必须传播 prepare/query/row decode 错误，禁止失败时静默返回 `0.0`
- 查询范围由 `InsightsFilter` 控制，支持 `session_ids`、`host_exact`、`host_keyword` 和 `excluded_hosts`
- 当会话量超过一定阈值时，应考虑增加时间范围过滤（`startTime` / `endTime`）避免查询超时
- 导出（Markdown / JSON）由前端纯函数生成，不涉及额外数据库查询
