# Throttling 弱网模拟使用指南

## 功能简介

Throttling 用于在代理层模拟弱网环境，例如高延迟、低带宽、丢包、上传慢或下载慢。它适合移动端、前端页面、客户端应用和 API 联调中的网络健壮性测试。

在 AIProxy 中，Throttling 指的是**弱网 / 链路模拟**，不是 API 网关里的 QPS 限流、并发限制、Quota 或 `429 Too Many Requests`。

## 典型用途

- **验证弱网加载体验**：检查页面骨架屏、loading、重试提示是否合理
- **测试移动网络场景**：模拟 4G、Slow 3G、弱 Wi-Fi 等环境
- **排查接口慢响应体验**：只对某个接口增加延迟，观察前端或客户端表现
- **验证上传 / 下载边界**：模拟上传慢、下载慢对业务流程的影响
- **测试丢包恢复**：模拟请求被弱网丢弃后的错误提示、重试或降级逻辑
- **回归关键链路**：对登录、支付、搜索、首屏接口等高风险路径建立固定弱网规则

## 入口位置

1. 打开 AIProxy
2. 在左侧导航栏点击 **Throttling / 弱网**
3. 页面顶部是运行状态区，左侧是 **Profiles / Rules** 切换，右侧是对应编辑器

也可以在 Sessions 列表中右键某条请求，点击 **Create Throttling Rule**，AIProxy 会基于当前请求生成一条定向弱网规则草稿。

## 当前版本能力

当前版本支持：

- 全局 Profile：对当前 Workspace 的代理流量启用一组弱网参数
- 预设 Profile：例如 Fast 4G、Slow 3G、Lossy Wi-Fi
- 自定义 Profile：配置延迟、上行、下行、丢包率
- 定向 Rule：按 URL pattern（支持 Match Type）、HTTP Method、Stage、Priority 控制弱网作用范围
- 15 分钟临时启用并显示倒计时；到期自动关闭（应用保持运行时）
- 规则行内开关启停 + 规则复制
- 一键关闭全局弱网
- Session Automation 标签页展示 Throttling Trace
- Sessions 列表可切换只查看被弱网影响的请求
- Session 右键创建定向弱网规则
- 通过 Rules 页的单文件导入导出做备份（[详见](./rewrite-rules.md#规则导入--导出)）

当前版本暂不支持：

- Jitter 随机抖动
- Timeout / Offline 场景参数
- WebSocket 消息级限速
- 保存前测试器
- API QPS / Quota / 并发限流

## 页面结构

### 顶部运行状态区

顶部状态区用于确认弱网是否正在影响流量。

展示内容：

| 区域 | 说明 |
|---|---|
| 开关状态 | 当前弱网是否开启 |
| Active Profile | 当前全局生效的 Profile |
| Hits | 已命中的弱网请求数 |
| Drops | 因丢包被模拟失败的请求数 |
| Delay | 累计增加的 request / response 延迟 |
| 15 min | 临时启用当前选中的 Profile |
| 关闭弱网 | 立即关闭全局弱网 |

建议：测试结束后点击 **关闭弱网**，避免后续抓包受到弱网影响。

临时启用期间会显示倒计时标签和「全局 Profile + N 条定向规则」的范围说明。注意倒计时在应用层计时——如果中途重启 AIProxy，临时启用的 Profile 会保持生效状态，直到你手动关闭。

### Profiles

Profiles 是可复用的弱网参数集合。

每个 Profile 包含：

| 字段 | 说明 | 示例 |
|---|---|---|
| Profile Name | 配置名称 | `Slow checkout API` |
| Latency | 给每个请求和响应阶段各增加的固定延迟（0–2000 ms） | `300 ms` |
| Download | 响应下载带宽，按 chunk 渐进交付（1–100,000 kbps） | `768 kbps` |
| Upload | 请求上传带宽；上传 body 会先缓冲，再按计算出的延迟发出（1–50,000 kbps） | `320 kbps` |
| Packet Loss | 请求或响应阶段各自被丢弃的概率（0–100%） | `1.2%` |
| Enable after save | 保存后是否立即作为全局 Profile 启用 | 开启 / 关闭 |

常用操作：

- 点击预设或自定义 Profile，可在右侧查看和编辑
- 点击 **Apply**，把该 Profile 作为全局弱网配置临时启用 **15 分钟**（顶部会出现倒计时标签）
- 点击 **New Custom**，创建自定义弱网配置
- 点击 **Save Profile**，保存配置但不一定启用
- 点击 **Save & Apply**，保存并保持全局启用，直到手动关闭弱网

## 全局弱网与定向规则

AIProxy 当前有两种弱网生效方式。

### 全局 Profile

全局 Profile 会影响当前 Workspace 下经过代理的请求。

适合：

- 快速验证整个页面或 App 在弱网下的表现
- 做一轮完整弱网回归
- 不关心具体接口，只想整体模拟网络变差

注意：

- 全局 Profile 影响范围较大
- 如果只想测试某个接口，建议使用定向 Rule
- 测试结束后记得关闭

### 定向 Rule

定向 Rule 只影响匹配到的请求。它适合精准测试某个接口、域名或方法。

Rule 字段：

| 字段 | 说明 | 示例 |
|---|---|---|
| Rule name | 规则名称 | `Slow login API` |
| Enabled | 是否启用该规则（列表内也可行内开关） | 开启 |
| Profile | 命中后使用的弱网 Profile——仅当该 Profile 处于启用状态时规则才会生效 | `Slow 3G` |
| URL pattern | 匹配完整请求 URL，按 Match Type 解释 | `*://api.example.com/login*` |
| Match Type | 模式匹配方式：Contains（默认）/ Wildcard / Exact / Regex | Wildcard |
| Methods | 匹配 HTTP Method，留空表示全部 | `POST` |
| Stage | 作用阶段 | `Request + response` |
| Priority | 优先级，数字越大越优先 | `100` |

编辑器还提供 **Duplicate（复制）**，可以基于现有规则快速创建新规则。

当定向 Rule 与全局 Profile 同时存在时：

1. 如果请求命中某条启用的 Rule、且其引用的 Profile 也处于启用状态，使用该 Rule 指定的 Profile
2. 多条 Rule 同时命中时，优先级最高的 Rule 生效
3. 如果没有命中任何 Rule，再使用全局 active Profile

## URL pattern

默认的 **Contains** 方式匹配任何包含模式文本的 URL——此时 `*` 是普通字符。想用 `*` 占位请选 **Wildcard**；除以 `*` 开头/结尾外，模式两端锚定。

| Pattern | Match Type | 匹配示例 |
|---|---|---|
| `api.example.com` | Contains（默认） | 任何包含 `api.example.com` 的 URL |
| `*://api.example.com/*` | Wildcard | `https://api.example.com/v1/users` |
| `*login*` | Wildcard | 任何包含 `login` 的 URL |
| `https://api.example.com/users` | Exact | 仅这个完全相同的接口 URL |
| `*` | Contains 或 Wildcard | 全部请求 |

建议：

- 定向 Rule 尽量写具体，避免误伤其他接口
- 从 Session 右键创建规则通常更准确，因为 AIProxy 会自动带入真实 URL、Host、Path 和 Method
- 多条规则可能同时匹配时，用 Priority 控制最终生效规则

## 从 Session 创建定向弱网规则

这是推荐的精准创建方式。

1. 打开 **Sessions**
2. 找到要模拟弱网的请求
3. 右键该请求
4. 点击 **Create Throttling Rule**
5. AIProxy 会跳转到 **Throttling** 页面，并自动生成规则草稿
6. 选择要使用的 Profile
7. 检查 URL / Method / Stage / Priority
8. 点击 **Save Rule**

自动带入内容：

- Host
- Path
- Method
- 完整 URL

适合场景：

- 只让登录接口变慢
- 只让图片下载变慢
- 只让某个 POST 请求丢包
- 只验证一个 GraphQL endpoint 的弱网表现

## 查看弱网是否生效

### 在 Sessions 中过滤

Sessions 顶部提供 **Throttled / All Sessions** 切换。

- **Throttled**：只显示已产生 Throttling Trace 的请求
- **All Sessions**：显示全部请求

这个过滤适合快速确认哪些请求被弱网影响过。

### 在 Session Automation 中查看 Trace

点击某条 Session 后，打开右侧 Response 区域的 **Automation** 标签页。

如果该请求被 Throttling 影响，会看到 **Throttling** 区块。

Trace 会展示：

| 字段 | 说明 |
|---|---|
| Profile | 使用的弱网 Profile |
| Rule | 如果由定向 Rule 命中，会显示规则名称 |
| Stage | request 或 response |
| Outcome | applied 或 dropped |
| Delay | 本阶段增加的总延迟 |
| Latency | 固定延迟部分 |
| Transfer | 按上行 / 下行带宽计算出的传输延迟 |
| Body | 参与计算的 body 大小 |
| Message | 丢包或异常说明 |

常见判断：

- `request / applied`：请求阶段已增加 latency 或 upload delay
- `response / applied`：响应阶段已增加 download delay
- `request / dropped`：请求被丢包模拟拦截，通常会返回超时类响应
- `response / dropped`：响应在传输中途被丢弃，客户端看到的是失败的响应

## 推荐工作流

### 快速整体弱网测试

1. 打开 **Throttling**
2. 在 Profiles 中选择 `Slow 3G`
3. 点击 **Apply** 做 15 分钟临时启用（或 **Save & Apply** 长期保持）
4. 回到应用执行测试流程
5. 在 Sessions 中观察慢请求和错误态
6. 测试结束后点击 **关闭弱网**

### 精准接口弱网测试

1. 先在 **Sessions** 中捕获目标接口
2. 右键请求，选择 **Create Throttling Rule**
3. 在 Throttling 页面选择合适 Profile
4. 检查 URL pattern 和 Method
5. 保存 Rule
6. 重新触发该接口
7. 打开 Session 的 **Automation** 标签确认 Trace

### 丢包恢复测试

1. 创建或选择一个带 Packet Loss 的 Profile
2. 建议先用定向 Rule 只作用于目标接口
3. 重新触发请求多次
4. 在 Sessions 中切到 **Throttled**
5. 打开 Automation 查看是否出现 `dropped`
6. 验证应用是否正确提示、重试或降级

## 工作原理

AIProxy 在代理管线中应用 Throttling：

1. 请求进入代理后，先根据 Workspace 找到匹配的 Throttling Rule
2. 如果有 Rule 命中，使用该 Rule 指定的 Profile
3. 如果没有 Rule 命中，使用当前全局 active Profile
4. 请求阶段：
   - 按 `packetLossRatio` 判断是否模拟丢包
   - 按 `latencyMs` 增加固定延迟
   - 按 request body 大小和 `uploadKbps` 计算上传延迟（上传 body 先缓冲，再按计算出的延迟交给上游）
5. 响应阶段：
   - 同样做丢包判定并增加固定延迟——两个阶段对称处理
   - 按 `downloadKbps` 交付响应，以约 16 KiB 的 chunk 渐进发送，下载逐步到达
6. 每次生效都会写入 Session 级 Throttling Trace

注意：上传侧是缓冲后延迟发送；下载侧按 chunk 渐进交付。它能较好地模拟“整体变慢”的体验，但暂不能完全模拟流式接口或大文件的逐块实时加载。

## 数据持久化

Throttling 配置会保存到本地 SQLite 数据库：

- `throttle_profiles`：保存全局 / 可复用 Profile
- `throttle_rules`：保存定向规则
- `throttle_runs`：保存每条 Session 的 Throttling Trace

应用重启后，Profile 和 Rule 会自动恢复。

## 常见问题

### Q: Throttling 和 API Rate Limit 是一回事吗？

不是。当前 Throttling 是弱网模拟，用来改变请求 / 响应链路的延迟、带宽和丢包表现。它不会实现 QPS 配额、API Key 限额、`Retry-After` 或 `429 Too Many Requests`。

### Q: 为什么我保存了 Profile，但请求没有变慢？

检查以下几点：

1. Profile 是否已点击 **Apply** 或 **Save & Apply**
2. 是否有定向 Rule 命中并覆盖了全局 Profile
3. 请求是否真的经过 AIProxy 代理
4. 如果只设置了 Upload，但请求 body 很小，体感可能不明显
5. 打开 Session 的 **Automation** 标签，确认是否有 Throttling Trace

### Q: 为什么只想影响一个接口，却所有请求都变慢了？

你可能启用了全局 Profile。请点击顶部 **关闭弱网**，然后创建定向 Rule，只匹配目标 URL / Method。

### Q: 多条 Rule 同时命中时谁生效？

Priority 数字最大的 Rule 生效。建议为更具体的规则设置更高优先级，例如：

- `POST /login`：Priority `200`
- `api.example.com/*`：Priority `100`

### Q: Packet Loss 设置为 10%，为什么不是每 10 次必定失败 1 次？

Packet Loss 是按请求独立随机判断。`10%` 表示每次请求都有 10% 概率被模拟丢包，不保证固定间隔失败。

### Q: WebSocket 会被 Throttling 影响吗？

当前 HTTP / HTTPS 请求链路会应用 Throttling。WebSocket 握手请求可能受 HTTP 阶段影响，但消息级限速、逐帧延迟和 WebSocket 丢包不是当前版本能力。

### Q: 如何确认请求是被 Throttling 丢弃的？

打开该 Session 的 **Automation** 标签，查看 Throttling Trace。如果 `Outcome` 是 `dropped`，并且 Message 显示被 active throttle profile 丢弃，就说明这是弱网丢包模拟造成的。

### Q: 15 分钟临时启用到期后会怎样？

到期后 AIProxy 会停用当前生效的 Profile。由于定向 Rule 借用 Profile 生效，它们也会一并暂停——Rule 只有在其引用的 Profile 处于启用状态时才会起作用。重新 Apply（或启用）某个 Profile 即可恢复弱网。
