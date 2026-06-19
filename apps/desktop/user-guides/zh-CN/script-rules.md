# TypeScript / JavaScript 脚本规则使用指南

## 功能简介

脚本规则允许你使用单文件 `JavaScript` 或 `TypeScript` 编写自定义代理逻辑，在请求发送前或响应返回前参与处理流量。

适用场景包括：

- **动态改写**：根据 URL、方法、Header、Body 内容动态修改请求或响应
- **条件过滤**：只在满足特定条件时生效
- **动态 Mock**：按条件直接返回自定义响应，不访问上游服务
- **数据提取**：从响应中提取 token、ID、状态字段并记录下来
- **调试日志**：为特定请求打点，方便回看脚本命中情况

## 当前版本能力边界

`v1` 支持：

- HTTP / HTTPS 请求与响应阶段脚本
- 单文件 `JS / TS`
- 应用内编辑
- 从本地 `.js / .mjs / .ts / .mts` 文件一次性导入
- 会话级日志与提取结果查看；Automation 标签页会同时展示 Rewrite 命中记录和 Script trace

`v1` 不支持：

- WebSocket 消息脚本化
- 多文件工程
- `npm` 依赖
- `import / require`
- 文件系统、网络、系统命令调用
- 定时器、后台任务

## 入口位置

1. 打开 AIProxy
2. 在左侧导航栏点击 **Rules**
3. 点击顶部 **Scripts** 标签页

## 创建脚本规则

1. 点击 **New Script Rule**
2. 在右侧编辑器填写基础信息
3. 选择脚本语言：
   - `TypeScript`
   - `JavaScript`
4. 填写匹配条件：
   - URL Pattern
   - HTTP Methods
   - Match Stage
5. 在脚本源码区域输入脚本
6. 点击 **Save Rule**

保存成功后，规则会立即生效。

## 字段说明

| 字段 | 说明 | 示例 |
|---|---|---|
| Rule Name | 规则名称，便于搜索和识别 | `给 API 请求加调试头` |
| Enabled | 控制规则是否生效 | 开启 |
| Priority | 数字越大优先级越高 | `100` |
| URL Pattern | URL 子串匹配模式 | `api.example.com/v1/` |
| HTTP Methods | 只匹配指定方法，留空表示全部 | `GET, POST` |
| Match Stage | `request`、`response`、`either` | `request` |
| Language | `TypeScript` 或 `JavaScript` | `TypeScript` |
| Script Source | 脚本正文 | 见下方示例 |

## 导入本地脚本文件

如果你已经在本地写好了脚本文件，可以直接导入：

1. 点击 **Import File**
2. 选择本地文件
3. 支持的扩展名：
   - `.js`
   - `.mjs`
   - `.ts`
   - `.mts`
4. 导入后源码会复制到当前规则中

注意：

- 导入是**一次性复制**，不是实时绑定外部文件
- 后续外部文件改动不会自动同步回 AIProxy

## 内置模板

脚本规则页提供了几个快捷模板：

- **Set Header**：给请求加 Header
- **Mock Response**：按条件返回自定义响应
- **Extract Data**：从响应中提取字段并记录日志

建议先从模板开始，再逐步调整逻辑。

## 脚本导出约定

脚本只支持导出以下两个函数：

```ts
export function onRequest(ctx) {}
export function onResponse(ctx) {}
```

规则可以只导出其中一个，也可以两个都导出。

不支持：

- `export const ...`
- `export default ...`
- `import ...`
- `require(...)`

## 执行时机

脚本规则按以下顺序执行：

### 请求阶段

`Rewrite -> Map -> Script(onRequest) -> Breakpoint -> Throttle -> Upstream`

### 响应阶段

`Upstream / Local Response -> Response Rewrite -> Script(onResponse) -> Breakpoint -> Throttle -> Client`

补充说明：

- 如果 `Map Local` 已经直接返回本地响应，`onRequest` 不会执行
- 但 `onResponse` 仍然会对这份本地响应继续执行

## `ctx` 可用能力

脚本运行时只开放最小宿主 API。

### `ctx.request`

请求阶段和响应阶段都可读取。

常用字段和方法：

- `ctx.request.method`
- `ctx.request.url`
- `ctx.request.headers`
- `ctx.request.bodyText`
- `ctx.request.bodyBase64`
- `ctx.request.mimeType`
- `ctx.request.getText()`
- `ctx.request.setText(text, mimeType?)`
- `ctx.request.getJson()`
- `ctx.request.setJson(value, mimeType?)`
- `ctx.request.getBase64()`
- `ctx.request.setBase64(value, mimeType?)`
- `ctx.request.setHeader(name, value)`
- `ctx.request.removeHeader(name)`

### `ctx.response`

仅在 `onResponse(ctx)` 中可用。

常用字段和方法：

- `ctx.response.status`
- `ctx.response.headers`
- `ctx.response.bodyText`
- `ctx.response.bodyBase64`
- `ctx.response.mimeType`
- `ctx.response.getText()`
- `ctx.response.setText(text, mimeType?)`
- `ctx.response.getJson()`
- `ctx.response.setJson(value, mimeType?)`
- `ctx.response.getBase64()`
- `ctx.response.setBase64(value, mimeType?)`
- `ctx.response.setHeader(name, value)`
- `ctx.response.removeHeader(name)`

### `ctx.session`

当前会话基础信息：

- `ctx.session.id`
- `ctx.session.host`
- `ctx.session.method`
- `ctx.session.path`
- `ctx.session.url`
- `ctx.session.workspaceId`
- `ctx.session.stage`

### `ctx.log`

用于记录调试日志：

- `ctx.log.debug(message, data?)`
- `ctx.log.info(message, data?)`
- `ctx.log.warn(message, data?)`
- `ctx.log.error(message, data?)`

### `ctx.extract(key, value)`

用于提取结构化数据，方便在会话详情中回看。

### `ctx.respond(...)`

用于在 `onRequest` 中直接生成响应：

```ts
ctx.respond({
  status: 200,
  headers: [
    { name: "content-type", value: "application/json" },
  ],
  bodyText: JSON.stringify({ ok: true }, null, 2),
  mimeType: "application/json",
});
```

调用后将跳过上游请求，直接返回该响应。

## 常见示例

### 示例 1：给请求加 Header

```ts
export function onRequest(ctx) {
  ctx.request.setHeader("x-debug-mode", "true");
}
```

适用场景：

- 打开服务端调试开关
- 给请求打标记
- 做灰度流量标识

### 示例 2：按路径动态 Mock

```ts
export function onRequest(ctx) {
  if (!ctx.request.url.includes("/api/user/profile")) {
    return;
  }

  ctx.respond({
    status: 200,
    headers: [
      { name: "content-type", value: "application/json" },
    ],
    bodyText: JSON.stringify({
      id: 1,
      name: "Mock User",
      role: "tester",
    }, null, 2),
    mimeType: "application/json",
  });
}
```

适用场景：

- 前后端联调时临时 Mock
- 验证客户端在特殊返回数据下的行为

### 示例 3：从响应中提取 Token

```ts
export function onResponse(ctx) {
  const data = ctx.response.getJson();
  const token = data?.token;

  if (!token) {
    return;
  }

  ctx.extract("token", token);
  ctx.log.info("token extracted", { token });
}
```

适用场景：

- 登录接口返回 token 后自动记录
- 提取关键业务字段做排查

### 示例 4：按条件改写响应

```ts
export function onResponse(ctx) {
  if (!ctx.request.url.includes("/feature-flags")) {
    return;
  }

  const data = ctx.response.getJson() ?? {};
  data.newDashboard = true;
  ctx.response.setJson(data);
}
```

适用场景：

- 打开前端功能开关
- 模拟后端返回的不同配置

## 调试与查看结果

脚本命中后的日志和提取结果可以在会话详情中查看：

1. 打开 **Sessions**
2. 选择一条命中过脚本规则的会话
3. 在右侧 Inspector 的 Response 区域点击 **Automation** 标签页

你会看到：

- 命中的脚本规则
- 执行阶段（request / response）
- 执行结果（success / skipped / runtimeError / timedOut / invalidResult）
- 执行耗时
- `ctx.log.*` 输出的日志
- `ctx.extract(...)` 提取出的结构化数据

## 失败处理机制

脚本规则默认采用 **fail-open** 策略。

这意味着：

- 脚本报错时，请求不会因此整体失败
- 脚本超时时，请求继续按原始链路执行
- 返回结果非法时，该次修改会被丢弃
- 错误信息会记录到 **Automation** 标签页，便于回看
- 如果同一条请求也命中了 Rewrite，Automation 标签页会先展示 Rewrite 的 before / after diff，再展示 Script 日志

这样可以避免一条脚本规则把整条代理链路卡死。

## 资源限制

为保证代理稳定性，脚本运行有以下限制：

- 单脚本源码大小上限：`128 KB`
- 单次 hook 执行超时：`50 ms`
- 单次运行最大日志 / 提取条目：`50`
- 单条日志或提取值序列化上限：`8 KB`

建议：

- 保持脚本逻辑简单直接
- 避免复杂计算和超大对象日志
- 避免在脚本里做重度 JSON 处理

## 安全限制

脚本运行在严格沙箱中，默认**不能**：

- 发网络请求
- 读取或写入文件
- 调用本地系统命令
- 使用 `import` 或 `require`
- 使用 Tauri / Node / Deno API

这样做是为了保证代理运行稳定可控，避免用户脚本影响桌面环境或请求链路安全。

## 匹配建议

为了避免脚本规则“误伤”过多流量，建议：

- URL Pattern 尽量具体，不要长期使用 `*`
- 用 HTTP Methods 缩小匹配范围
- 根据需要把 Match Stage 设为 `request` 或 `response`
- 使用 Priority 控制多条脚本规则的顺序

## 常见问题

### Q: 为什么脚本保存失败？

常见原因：

1. 没有导出 `onRequest` 或 `onResponse`
2. 使用了不支持的导出形式
3. TypeScript / JavaScript 语法错误
4. 脚本超过大小限制

### Q: 为什么脚本写了但没生效？

检查以下几点：

1. 规则是否已启用
2. URL Pattern 是否命中当前请求
3. HTTP Methods 是否匹配
4. Match Stage 是否正确
5. 是否有更高优先级的脚本规则先修改了流量

### Q: `onRequest` 里为什么拿不到 `ctx.response`？

因为响应还没有返回，`ctx.response` 只在 `onResponse(ctx)` 中可用。

### Q: 为什么 `Map Local` 命中后 `onRequest` 没执行？

这是当前设计的一部分。`Map Local` 已经在请求阶段直接生成了本地响应，所以 `onRequest` 会跳过；但对应的 `onResponse` 仍然会执行。

### Q: 可以在脚本里访问磁盘文件或请求外部接口吗？

不可以。`v1` 运行在严格沙箱中，不开放文件系统和网络能力。

### Q: 可以拆多个文件吗？

当前不支持。`v1` 只支持单文件脚本。

## 推荐实践

- 先从模板开始，不要一上来写过长脚本
- 一条规则只解决一个问题，便于排查
- 先用 `ctx.log.info(...)` 观察命中情况，再加入修改逻辑
- 对于高频接口，优先写轻量逻辑，避免代理性能波动
