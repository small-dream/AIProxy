# Rewrite 改写规则使用指南

## 功能简介

Rewrite 规则允许你在代理转发过程中自动修改命中的 HTTP 请求或响应。它适合联调、Mock、临时切环境、调试 Header、关闭缓存、替换响应内容等场景。

Rewrite 不是文本生成能力，而是代理层的自动改包能力。规则保存后会立即参与代理链路。

## 典型用途

- **临时加调试 Header**：例如给请求添加 `x-debug-mode: true`
- **切换环境**：把命中的 API 请求 Redirect 到 staging 上游
- **追加 Query 参数**：例如自动追加 `env=staging`
- **关闭响应缓存**：覆盖 `Cache-Control`
- **Mock JSON 响应**：把响应 Body 替换为固定 JSON，或按字段路径修改/删除指定字段
- **排查 CORS / 鉴权问题**：临时增删 Header，快速验证问题来源

## 入口位置

1. 打开 AIProxy
2. 在左侧导航栏点击 **Rules**
3. 点击顶部 **Rewrite** 标签页

也可以在 Sessions 列表中右键某条请求，点击 **Create Rewrite Rule**，AIProxy 会基于当前请求自动生成一条可编辑的 Rewrite 草稿。

## 规则导入 / 导出

**Rules** 页头部提供 **导出（Export） / 导入（Import）** 按钮（每个标签页都可用）。导出会下载单个 `aiproxy-rules-YYYY-MM-DD.json` 文件，包含全部规则种类——Rewrite、Map Local / Map Remote、DNS 映射、Script、断点，以及限速规则和 Profile（`aiproxy.rules` 格式，版本 1）。导入先选择本地 `.json` 文件，再在预览对话框中按类型勾选并确认；导入的规则会分配新 id、以 **禁用状态** 落到默认工作区——不会覆盖任何现有内容。

## 当前版本能力

当前版本支持：

- Header 改写：新增 / 覆盖 / 删除请求或响应 Header
- Query 改写：新增 / 覆盖 / 删除请求 URL Query 参数
- Body 改写：整段替换请求或响应 Body，或按 JSON Path 修改/删除指定字段，并设置 `Content-Type`
- Redirect 改写：把请求转发到另一个目标 URL，可选择保留原 path / query
- 单条规则支持多个有序动作：Header / Query / Body / Redirect 步骤按顺序自上而下执行
- URL Pattern、HTTP Method、Stage 匹配
- 优先级与启停控制
- 高频模板
- 保存前规则测试器
- Session Automation 标签页展示 Rewrite 命中记录与 before / after diff

当前版本暂不支持：

- 修改响应状态码
- Cookie 专用编辑器
- 正则捕获替换
- 变量模板，例如 `{{timestamp}}`、`{{uuid}}`
- Header / Query / Body 条件表达式

## 规则工作台

Rewrite 页面采用三段式工作台：

- **Templates**：从常见场景创建规则
- **When**：配置匹配条件
- **Then**：配置改写动作
- **Test**：保存前用样例 URL、Method、Stage 测试是否命中

### Templates

内置模板包括：

- **Debug header**：给请求添加调试 Header
- **Disable cache**：设置响应缓存 Header
- **Env query**：追加环境 Query 参数
- **Staging redirect**：重定向到 staging 上游
- **Mock JSON**：替换响应为固定 JSON

建议新用户先从模板开始，再调整 URL Pattern、Method 和具体字段。

## 匹配条件

| 字段 | 说明 | 示例 |
|---|---|---|
| Rule Name | 规则名称，便于搜索和识别 | `API 切 staging` |
| Enabled | 控制规则是否生效 | 开启 |
| Priority | 数字越大优先级越高 | `100` |
| URL Pattern | URL 匹配模式，按 Match Type 指定的方式解释 | `api.example.com/v1/*` |
| Match Type | URL Pattern 的匹配方式，默认 Contains | `Wildcard` |
| HTTP Methods | 只匹配指定方法，留空表示全部 | `GET, POST` |
| Match Stage | 请求阶段、响应阶段，或两者 | `request` |

### URL Pattern 规则

Match Type 控制 URL Pattern 如何与请求 URL 进行比对。可选四种方式：

| Match Type | 行为 | Pattern 示例 | 匹配 `https://api.example.com/v1/users` |
|---|---|---|---|
| **Contains** (默认) | URL 包含 Pattern 即命中（子串匹配） | `api.example.com` | ✓ |
| **Wildcard** | `*` 作为通配符，匹配零个或多个字符 | `api.example.com/v1/*` | ✓ |
| **Exact** | URL 必须与 Pattern 完全相等 | `https://api.example.com/v1/users` | ✓ |
| **Regex** | Pattern 作为正则表达式匹配 | `api\.example\.com/v1/.*` | ✓ |

Contains 模式下，空值或 `*` 表示匹配所有 URL。Wildcard 模式下，空值或 `*` 同样匹配所有 URL。

示例：

| Match Type | Pattern | 匹配示例 |
|---|---|---|
| Contains | `api.example.com` | `https://api.example.com/v1/users` |
| Wildcard | `api.example.com/v1/*` | `https://api.example.com/v1/users?id=1` |
| Wildcard | `*login*` | 任意包含 `login` 的 URL |
| Exact | `https://api.example.com/v1/users` | 仅完全相同的 URL |
| Regex | `api\..*\.com/v[12]/` | `api.example.com/v1/users`、`api.staging.com/v2/items` |

## 改写动作

一条规则可以串联多个有序动作——例如先加一个 Header，再改 Body，再 Redirect。每个动作是一张编号卡片，带独立的类型下拉框（Header / Query / Body / Redirect）和对应的编辑器；用卡片上的上下箭头调整顺序，用 **+ 添加动作** 追加。动作严格自上而下执行；规则之间仍按优先级执行，后面的规则看到的是前面规则改写后的结果。

某个动作失败时（例如 Fields 模式下 Body 不是合法 JSON），其余动作仍会继续执行，每个失败都会作为错误记录展示在 Automation 中——只有全部动作都失败时整条规则才算失败。与当前阶段不匹配的动作会被记为 skipped。

### Header Rewrite

可作用于 request 或 response。

支持：

- `set`：新增或覆盖 Header
- `remove`：删除 Header

示例：

| 目标 | 操作 | Header | 值 |
|---|---|---|---|
| request | set | `x-debug-mode` | `true` |
| response | set | `Cache-Control` | `no-store` |
| response | remove | `ETag` | - |

### Query Rewrite

Query Rewrite 只在请求发往上游前生效。

支持：

- `set`：新增或覆盖 Query 参数
- `remove`：删除 Query 参数

示例：

| 操作 | 参数 | 值 |
|---|---|---|
| set | `env` | `staging` |
| remove | `utm_source` | - |

### Body Rewrite

可作用于 request 或 response，支持两种模式：

**Replace 模式**（整段替换）：
- 用自定义内容替换整个 Body
- 同步设置 `Content-Type`

示例响应 JSON：

```json
{
  "ok": true,
  "source": "aiproxy"
}
```

**Fields 模式**（字段修改）：
- 按 JSON Path 定位并修改/删除指定字段
- 支持 `data.user.name` 对象路径和 `items[0].name` 数组下标
- 支持 `$.` 前缀（如 `$.data.user.name`）
- 每个字段可选操作：
  - `set`：设置字段值为指定类型（string / number / boolean / null / JSON）
  - `remove`：删除该字段
- 字段模式下仍然需要设置 `Content-Type`（通常为 `application/json`）

字段模式示例 — 修改 JSON 响应：

| 操作 | 路径 | 类型 | 值 |
|---|---|---|---|
| set | `user.name` | string | `Jane` |
| set | `user.enabled` | boolean | `true` |
| remove | `debug` | — | — |

原 Body：

```json
{"user":{"name":"Alice"},"debug":true}
```

改写后：

```json
{"user":{"name":"Jane","enabled":true}}
```

### Redirect Rewrite

Redirect Rewrite 只在请求发往上游前生效。它会修改目标 URL。

可选项：

- **Preserve Path**：保留原请求 path
- **Preserve Query**：保留原请求 query

示例：

原请求：

```text
https://api.example.com/v1/users?id=1
```

目标：

```text
https://staging.example.com
```

如果同时保留 path 和 query，最终请求会变成：

```text
https://staging.example.com/v1/users?id=1
```

## 规则测试器

右侧 **Test** 面板用于保存前验证当前规则是否会命中。

输入：

- Sample URL
- Method
- Stage

输出：

- 是否命中
- 不命中的原因，例如 Method 不匹配、URL 不匹配、Stage 不匹配
- 命中后预计执行的动作摘要

## 从 Session 创建规则

在 Sessions 列表中右键某条请求，选择 **Create Rewrite Rule**。

AIProxy 会自动带入：

- 当前请求 URL
- Host + Path 作为 URL Pattern
- 当前 HTTP Method
- 默认请求阶段
- 一个可立即保存的 Header Rewrite 草稿

这是推荐的创建路径，尤其适合从真实流量快速生成规则。

## 查看命中记录与 Diff

打开某条 Session 后，在 Response 区域点击 **Automation** 标签页。

如果该请求命中过 Rewrite，页面会展示：

- 命中的规则名称和 ID
- Rewrite 类型
- 执行阶段
- 执行结果：success / skipped / failed
- 耗时
- before / after diff

不同类型的 diff：

- Header：原 Header 值与改写后 Header 值
- Query：原参数值与改写后参数值
- Body：原 Body 预览与改写后 Body 预览；字段模式下展示每个字段的 before / after 值
- Redirect：原 URL 与改写后 URL

## 执行顺序

请求阶段：

```text
Rewrite -> Map -> Script(onRequest) -> Breakpoint -> Throttle -> Upstream
```

响应阶段：

```text
Upstream / Local Response -> Response Rewrite -> Script(onResponse) -> Breakpoint -> Throttle -> Client
```

补充说明：

- `Map Local` 直接返回本地响应时，请求阶段 Script 不执行，但响应阶段 Rewrite / Script 仍可继续处理返回内容
- 响应体超过捕获上限（当前为 20 MB）时，AIProxy 会跳过响应 Body 改写，避免大文件造成性能问题
- HTTP/2 请求目前跳过 Body 改写（会记录一条 skipped 轨迹）

## 规则管理

- **批量操作**：勾选行前的复选框会出现批量操作栏 **启用 / 禁用 / 删除 / 完成**；删除会先确认，部分失败时通过 toast 提示。
- **拖拽排序**：行首有拖拽把手，拖动后会重算优先级，使列表顺序与执行顺序一致（越靠上优先级越高）。
- **未保存草稿保护**：编辑器有未保存修改时，离开 Rules 页面、切换标签页、选择另一条规则、新建规则或套用模板，都会先弹「有未保存的更改……是否丢弃？」确认。
- 字段级校验错误在首次尝试保存后显示在每个出错字段下方；Alert 仅用于保存失败和跨字段警告。

## 无效组合保护

当前版本直接拒绝保存以下容易误解的组合——在修正 Stage 或 Target 前 **Save** 按钮不会生效，同时会有警告说明原因：

- response 阶段的 Query Rewrite
- response 阶段的 Redirect Rewrite
- request 阶段规则却选择 response Header / Body target
- response 阶段规则却选择 request Header / Body target

## 常见问题

### Q: 规则保存了，但没有生效？

检查：

1. 规则是否启用
2. URL Pattern 是否匹配完整 URL
3. HTTP Method 是否匹配
4. Match Stage 是否匹配
5. 是否有更高优先级规则先修改了 URL 或相关字段
6. Automation 标签页是否有 skipped / failed 记录

### Q: 为什么 Query / Redirect 不能用于 response 阶段？

Query 和 Redirect 修改的是即将发往上游的请求 URL。响应回来时，请求目标已经确定，因此这两类动作只在 request 阶段有意义。

### Q: 多条 Rewrite 会怎么执行？

同一阶段内，命中的 Rewrite 规则按优先级从高到低依次执行。后执行的规则可能看到前一条规则改写后的请求或响应。同一条规则内的多个动作则严格自上而下执行。

### Q: Rewrite 和 Script 有什么区别？

Rewrite 适合常见、结构化、低门槛的改写，例如 Header、Query、Body、Redirect。Script 适合复杂条件、动态逻辑、字段级处理和自定义 Mock。一般建议优先使用 Rewrite，复杂场景再使用 Script。
