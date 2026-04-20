# TypeScript 脚本化规则引擎 v1 详细实现计划

## Summary

目标是在现有规则体系上新增一类 `Script Rule`，允许高级用户用单文件 `JS/TS` 脚本参与 HTTP 请求与响应处理，并保持与现有 Rewrite / Map / Breakpoint / Throttle 规则体系兼容。

v1 范围已锁定为：

- 覆盖 HTTP 全链路：请求前、响应后、动态响应、条件过滤、数据提取、日志
- 严格沙箱：不开放文件系统、网络、模块加载、宿主命令执行
- 单文件脚本：支持应用内编辑，支持从本地文件一次性导入
- 脚本在现有内建规则之后执行
- 脚本日志与提取结果按 session 持久化，可在会话详情里回看

## Implementation Changes

### 1. 规则模型与执行链

在 `crates/rule-engine` 中正式落地脚本规则运行时，不顺手重构现有 Rewrite / Map 逻辑，避免功能上线被大范围重构拖慢。

新增 `ScriptRule` 领域模型，字段沿用现有规则中心习惯：

- `id / workspaceId / name / note / enabled / priority`
- `match: { urlPattern, methods, stage }`
- `language: "javascript" | "typescript"`
- `sourceType: "inline" | "fileImport"`
- `sourceCode`
- `sourcePath?`
- `entrypoints: { onRequest: boolean, onResponse: boolean }`

脚本模块约定导出可选同步函数：

```ts
export function onRequest(ctx) {}
export function onResponse(ctx) {}
```

执行顺序固定为：

- 请求阶段：Rewrite -> Map -> Script `onRequest` -> Breakpoint -> Throttle -> Upstream
- 响应阶段：Upstream/Local Response -> Response Rewrite -> Script `onResponse` -> Breakpoint -> Throttle -> Client

补充约束：

- `Map Local` 已短路生成响应时，不再执行 `onRequest`，直接对该本地响应执行 `onResponse`
- 脚本异常、超时、结果校验失败一律 `fail-open`
- 只有脚本成功返回后，宿主才把脚本内修改过的请求/响应副本应用回真实流量，避免半途异常留下脏状态

### 2. TS/JS 运行时与沙箱

运行时技术选择：

- TS 转译与语法校验：`deno_ast`
- JS 执行引擎：`rquickjs`

保存规则时完成：

- 解析源码
- `TS -> JS` 转译
- source map 生成
- 检查导出函数是否合法
- 生成 `entrypoints`
- 将源码、编译结果、source map 一并持久化

运行时只执行已编译的 JS，不在代理热路径里做转译。

沙箱默认能力：

- 无 `fetch`
- 无 `require/import`
- 无文件系统
- 无网络
- 无 Tauri/OS API
- 无定时器和后台任务
- 仅注入最小宿主 API

宿主 API 只提供：

- `ctx.request` / `ctx.response` 的可变副本
- `ctx.session` 基础元数据
- `ctx.log.debug/info/warn/error(message, data?)`
- `ctx.extract(key, value)`
- `ctx.respond({ status, headers, bodyText?, bodyBase64? })`
- 文本/JSON/Base64 body 读写辅助方法

默认资源限制：

- 单脚本源码大小上限 `128 KB`
- 单次 hook 执行超时 `50 ms`
- 单次运行最大日志/提取条目 `50`
- 单条日志或提取值序列化后上限 `8 KB`

### 3. 持久化与桌面命令层

SQLite 新增三张表：

- `script_rules`
  - 保存规则元数据、源码、编译 JS、source map、entrypoints、更新时间
- `script_runs`
  - 每次命中一条脚本规则时记录一条运行摘要
  - 字段包含 `session_id / rule_id / workspace_id / stage / outcome / duration_ms / created_at`
- `script_run_entries`
  - 保存该次运行产出的日志、提取结果、运行错误
  - 字段包含 `run_id / kind / level / key / message / payload_json / seq`

桌面端启动时：

- 从 DB 加载 `script_rules`
- 构建内存 `ScriptManager`
- 与现有 `RewriteManager / MapManager / DnsManager` 并列挂入 `AppState`

Tauri commands 新增：

- `list_script_rules`
- `save_script_rule`
- `delete_rule` 扩展支持 `ruleType: "script"`
- `list_script_session_trace`
  - 输入 `sessionId`
  - 返回按规则分组的运行摘要 + 日志 + 提取结果

非 Tauri fallback：

- 规则配置沿用 `services/commands` 的 localStorage fallback，便于前端独立开发
- 脚本执行、运行日志、提取结果不做浏览器 fallback

### 4. 前端规则中心与会话查看

规则页新增 `Scripts` tab，沿用现有 `ManagedRulesWorkbench` 结构，不引入全新交互模型。

编辑器首版能力：

- 新建 JS/TS 脚本规则
- 设置名称、启用、优先级、匹配条件
- 选择语言
- 多行代码编辑
- 从本地文件导入为单文件脚本
- 模板创建
  - 修改请求头
  - 动态 mock 响应
  - 提取 token 并记日志
- 保存时展示编译/导出校验错误

v1 不做：

- Monaco/IDE 级智能补全
- 多文件工程
- npm 依赖
- 文件监听热更新

会话详情新增一个懒加载的 `Automation` 响应侧 tab，展示：

- 命中的脚本规则
- 每条规则的阶段、耗时、结果
- 日志流
- 提取结果
- 运行错误

这里复用 WebSocket Messages 的加载模式，不把脚本运行记录直接塞进 `SessionDetail` 主 DTO。

## Public APIs / Types

新增共享类型：

- `ScriptRule`
- `ScriptRuleLanguage`
- `ScriptRuleSourceType`
- `ScriptEntrypoints`
- `ScriptRunOutcome`
- `ScriptRunEntry`
- `ScriptSessionTrace`

新增命令契约：

- `list_script_rules(workspaceId) -> ScriptRule[]`
- `save_script_rule(input) -> ScriptRule`
- `list_script_session_trace(sessionId) -> ScriptSessionTrace[]`

脚本 API 合约固定为：

- `onRequest(ctx): void`
- `onResponse(ctx): void`

脚本导出的返回值不作为主接口；宿主以 `ctx` 上的显式操作为准，避免返回结构过于松散。

## Test Plan

Rust 侧：

- `script_rules` / `script_runs` / `script_run_entries` 的 DB round-trip
- TS 脚本保存时可成功转译并识别导出 hook
- 非法源码、非法导出名、超大脚本、超时脚本会被正确拒绝或 fail-open
- `onRequest` 可修改 method/url/headers/query/body
- `onRequest` 可动态生成响应并跳过 upstream
- `onResponse` 可修改 headers/body/status
- `Map Local` 命中后仍可进入 `onResponse`
- 脚本异常不会中断正常代理链路
- 日志与提取结果按 session 正确落库

代理集成测试：

- HTTP 明文请求脚本命中
- HTTPS MITM 请求脚本命中
- 脚本与 Rewrite/Map/Breakpoint/Throttle 的执行顺序符合约定
- source map 错误定位能映射回原始 TS 行号

前端侧：

- `ScriptRule` 类型守卫与解析器
- Rules 页面脚本 tab 的增删改查
- 保存失败时编译错误可见
- Session `Automation` tab 可正确展示 trace 数据
- 非 Tauri 环境下规则配置 fallback 正常

验收场景：

- 用户写一个 TS 脚本给请求加 header，抓包中能看到变更
- 用户按 URL 条件动态返回 mock JSON，不访问上游
- 用户在响应阶段提取 token 并在 session 详情里回看
- 用户脚本报错后，请求仍继续，错误在 Automation tab 可见

## Assumptions / Defaults

- v1 只处理 HTTP/HTTPS 请求响应，不覆盖 WebSocket 消息脚本化
- v1 不做完整 TypeScript 语义 type-check，只做语法转译、导出校验、运行期契约校验
- 文件导入是“一次性导入到规则源码”，不是外部文件实时绑定
- 不在本次需求里把现有 Rewrite / Map / DNS 迁入 `rule-engine`
- 文档必须同步更新：`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/API_SPEC.md`、`docs/FEATURE_ROADMAP.md`
