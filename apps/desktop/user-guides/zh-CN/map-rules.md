# 映射规则（Map Local / Map Remote）使用指南

映射规则让你把命中的请求**指向别处**：要么直接返回本地文件（Map Local），要么把请求转发到另一个上游地址（Map Remote）。两者共用同一套字段，区别在于目标是「本地路径」还是「远程 URL」。

## 功能定位

- **Map Local（本地映射）**：命中后**直接返回本地文件内容**，跳过上游。适合 Mock 固定响应、用本地构建产物替换线上静态资源。
- **Map Remote（远程映射）**：命中后**改写上游目标 URL**，继续走完整代理管线。适合一键切环境（生产 → 预发 / Mock 网关）。

> Map Remote 和 [Rewrite 的 Redirect](./rewrite-rules.md) 不同：Redirect 是给客户端返回一个重定向响应（客户端再发起新请求）；Map Remote 是在代理内部悄悄换上游，客户端无感知，且原始抓包上下文保留。

## 入口位置

1. 在左侧导航栏点击 **Rules**
2. 点击顶部 **映射（Mapping）** 标签页
3. 在 Mapping 内切换到 **本地映射（Map Local）** 或 **远程映射（Map Remote）** 子标签（与 [DNS 映射](./dns-mapping.md) 并列）

## 共用字段

Map Local 和 Map Remote 共用同一组字段：

| 字段 | 说明 | 默认 |
|---|---|---|
| 规则名称 | 便于识别 | — |
| 启用 | 控制是否生效 | 开启 |
| 优先级 | 数字越大越优先；多条命中取最高。可在列表里拖拽行调整顺序并自动重排优先级 | `100` |
| 来源 URL 模式 | 要匹配的请求 URL 模式，按 Match Type 解释 | — |
| Match Type | 模式匹配方式：Contains（默认）/ Wildcard / Exact / Regex | Contains |
| 保留路径（Preserve Path） | 是否保留原请求的 path | 开启 |
| 保留 Query（Preserve Query） | 是否保留原请求的 query | 开启 |

默认 **Contains** 方式下：空值或 `*` 匹配全部，否则请求 URL 需包含该子串——例如 `example.com/assets/` 会匹配该路径下的请求。其他方式：**Wildcard** 用 `*` 占位但两端锚定（不以 `*` 开头的模式必须从 URL 开头匹配，不以 `*` 结尾的模式要匹配到结尾）；**Exact** 要求整个 URL 与模式完全相等；**Regex** 编译为正则表达式（非法正则会静默地永不命中）。

多条规则命中时，按**优先级降序**取最高的一条。

### 管理映射规则

勾选行前复选框可批量 **启用 / 禁用 / 删除**；拖动行首把手可排序（优先级自动重排，列表顺序即优先顺序）。也可以在 [Sessions](./sessions.md) 里右键某条请求 → **Map Local 此请求**，会基于该 Host + Path 预填一条新草稿。Map Local / Map Remote 规则包含在 Rules 页的[导入 / 导出](./rewrite-rules.md#规则导入--导出)中。

## Map Local：返回本地文件

**目标**字段填**本地文件或目录路径**（可用「选择文件 / 选择目录」按钮拾取）：

- 指向**文件**：命中后直接返回该文件内容
- 指向**目录**：根据请求 path 在该目录下定位文件（开启「保留路径」时按原 path 拼接）；目录根且无 path 时默认返回 `index.html`

返回的响应：

- 状态码固定 **200**
- `Content-Type` 按文件后缀自动推断（如 `.json` → `application/json`、`.js` → JavaScript、`.png` → image/png 等，无法识别时为 `application/octet-stream`）
- Body 为文件原始内容

> 出于安全考虑，请求 path 中的 `.` / `..` 会被清理，防止越出目标目录读取任意文件。

### 命中后的管线行为

Map Local 直接产生本地响应，因此：

- **跳过上游请求**
- 请求阶段的 [脚本](./script-rules.md) `onRequest` 不会执行
- 但响应阶段的 Rewrite / 脚本 `onResponse` 仍会继续处理这份本地响应

## Map Remote：转发到另一个上游

**目标**字段填一个 **`http://` 或 `https://` 开头的基地址**（例如 `https://staging.example.com`）：

- 命中后，请求的 host / 上游被替换为该目标
- 开启「保留路径 / 保留 Query」时，原请求的 path 和 query 会拼到新目标上。目标 URL 的 path 会作为 base path 使用，并自动合并斜杠：目标 `/gateway/` + 原路径 `/v1/users` 最终为 `/gateway/v1/users`。
- 请求**继续走完整代理管线**（[脚本](./script-rules.md) / [断点](./breakpoints.md) / [限速](./throttling.md) / 上游），不是给客户端返回重定向

例如来源 `api.example.com`、目标 `https://staging.example.com`，开启保留路径与 Query 后，`https://api.example.com/v1/users?id=1` 会被转发到 `https://staging.example.com/v1/users?id=1`，客户端完全无感知，且 Sessions 里仍保留原始 URL 上下文。

## Map Remote vs Rewrite Redirect

| 维度 | Map Remote | Rewrite Redirect |
|---|---|---|
| 行为 | 代理内部换上游，继续走管线 | 给客户端返回 3xx 重定向响应 |
| 客户端感知 | 无感知，连接不中断 | 客户端会再发起新请求到目标 |
| 抓包上下文 | 保留原始 URL | 出现新的重定向请求 |
| 适用 | 切环境、切上游 | 强制客户端跳转 |

## 典型用途

### Map Local

- 把某个 API 映射到本地一份固定 JSON 做 Mock
- 用本地构建产物（`dist/`）替换线上 JS / CSS，调试前端改动而无需发布
- 把图片 / 字体等静态资源指到本地缓存

### Map Remote

- 一键把生产域名切到预发环境联调
- 把某接口切到 Mock 网关
- 临时把流量导到本机起的另一服务

## 常见问题

### Q: Map Local 设置了却没返回本地文件？

检查：

1. 规则是否启用
2. 在当前 Match Type 下来源 URL 模式是否真的能命中该请求 URL
3. 目标路径是否存在、可读
4. 是否有更高优先级的规则先命中
5. 如果指向目录，确认请求 path 能在该目录下找到对应文件

### Q: Map Local 命中后脚本为什么不执行？

Map Local 在请求阶段直接返回本地响应，所以 `onRequest` 被跳过；但响应阶段的 `onResponse` 仍会执行。

### Q: Map Remote 和 Rewrite Redirect 该用哪个？

想「悄悄换上游、客户端无感」用 Map Remote；想「让客户端跳到新地址」用 Rewrite Redirect。

### Q: 目录映射时访问根路径返回什么？

默认返回目录下的 `index.html`。请求 path 里的 `.` / `..` 会被清理，无法越出目标目录。
