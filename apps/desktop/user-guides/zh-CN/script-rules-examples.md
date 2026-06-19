# 脚本规则示例集

这份示例集用于配合 [script-rules.md](./script-rules.md) 使用。

如果你是第一次接触脚本规则，建议顺序是：

1. 先看“设置请求头”
2. 再看“按条件 Mock”
3. 最后看“响应提取”和“响应改写”

## 示例 1：给所有 API 请求加调试头

用途：

- 给后端打标记
- 打开某些调试开关
- 便于在抓包或服务端日志中识别来源

推荐匹配：

- URL Pattern: `api.example.com`
- Match Stage: `request`
- Methods: 留空或按需选择

```ts
export function onRequest(ctx) {
  ctx.request.setHeader("x-debug-mode", "true");
  ctx.log.info("debug header added", {
    url: ctx.request.url,
  });
}
```

## 示例 2：只在 POST 请求上加 Header

用途：

- 避免对 GET 请求产生副作用
- 仅标记写操作

推荐匹配：

- URL Pattern: `api.example.com`
- Match Stage: `request`
- Methods: `POST`

```ts
export function onRequest(ctx) {
  if (ctx.request.method !== "POST") {
    return;
  }

  ctx.request.setHeader("x-request-origin", "aiproxy-script");
}
```

## 示例 3：根据 URL 参数切换到 Mock 响应

用途：

- 临时打开 Mock
- 不改前端代码，通过请求参数控制是否命中脚本

推荐匹配：

- URL Pattern: `/api/user/profile`
- Match Stage: `request`

```ts
export function onRequest(ctx) {
  const url = new URL(ctx.request.url);

  if (url.searchParams.get("mock") !== "1") {
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
      from: "script-rule",
    }, null, 2),
    mimeType: "application/json",
  });
}
```

## 示例 4：按请求头决定是否 Mock

用途：

- 只有特定请求才返回 Mock
- 配合前端开关或测试流量使用

推荐匹配：

- URL Pattern: `/api/orders`
- Match Stage: `request`

```ts
export function onRequest(ctx) {
  const shouldMock = ctx.request.headers.some(
    (header) =>
      header.name.toLowerCase() === "x-use-mock" &&
      header.value === "1",
  );

  if (!shouldMock) {
    return;
  }

  ctx.respond({
    status: 200,
    headers: [
      { name: "content-type", value: "application/json" },
    ],
    bodyText: JSON.stringify({
      items: [],
      total: 0,
      source: "mock",
    }, null, 2),
    mimeType: "application/json",
  });
}
```

## 示例 5：统一把请求体里的环境字段改成 staging

用途：

- 联调时把请求自动切到预发环境
- 避免手工改每个请求体

推荐匹配：

- URL Pattern: `/api/`
- Match Stage: `request`
- Methods: `POST`, `PUT`, `PATCH`

```ts
export function onRequest(ctx) {
  const contentType = ctx.request.mimeType ?? "";

  if (!contentType.includes("json")) {
    return;
  }

  const body = ctx.request.getJson();

  if (!body || typeof body !== "object") {
    return;
  }

  body.env = "staging";
  ctx.request.setJson(body);
}
```

## 示例 6：在响应里打开前端功能开关

用途：

- 模拟后端已开启某个 feature flag
- 验证前端新功能 UI

推荐匹配：

- URL Pattern: `/feature-flags`
- Match Stage: `response`

```ts
export function onResponse(ctx) {
  const data = ctx.response.getJson();

  if (!data || typeof data !== "object") {
    return;
  }

  data.newDashboard = true;
  data.betaBanner = true;

  ctx.response.setJson(data);
  ctx.log.info("feature flags overridden");
}
```

## 示例 7：从登录响应中提取 token

用途：

- 快速查看登录返回的 token
- 调试认证链路

推荐匹配：

- URL Pattern: `/login`
- Match Stage: `response`
- Methods: `POST`

```ts
export function onResponse(ctx) {
  const data = ctx.response.getJson();
  const token = data?.token;

  if (!token) {
    return;
  }

  ctx.extract("token", token);
  ctx.log.info("token extracted", {
    length: String(token).length,
  });
}
```

## 示例 8：提取响应中的用户 ID 和状态

用途：

- 给排障留结构化字段
- 在 Automation 标签页快速回看关键值

推荐匹配：

- URL Pattern: `/api/user/`
- Match Stage: `response`

```ts
export function onResponse(ctx) {
  const data = ctx.response.getJson();

  if (!data) {
    return;
  }

  if (data.id !== undefined) {
    ctx.extract("userId", data.id);
  }

  if (data.status !== undefined) {
    ctx.extract("userStatus", data.status);
  }
}
```

## 示例 9：给错误响应追加调试字段

用途：

- 前端本地验证错误处理分支
- 给问题响应加额外上下文

推荐匹配：

- URL Pattern: `/api/`
- Match Stage: `response`

```ts
export function onResponse(ctx) {
  if (ctx.response.status < 400) {
    return;
  }

  const contentType = ctx.response.mimeType ?? "";

  if (!contentType.includes("json")) {
    return;
  }

  const data = ctx.response.getJson() ?? {};
  data.debug = {
    injectedBy: "aiproxy-script",
    originalStatus: ctx.response.status,
  };

  ctx.response.setJson(data);
}
```

## 示例 10：记录某类请求的命中情况

用途：

- 不修改流量，只做观测
- 确认脚本是否命中了预期接口

推荐匹配：

- URL Pattern: `/checkout`
- Match Stage: `either`

```ts
export function onRequest(ctx) {
  ctx.log.info("checkout request matched", {
    method: ctx.request.method,
    url: ctx.request.url,
  });
}

export function onResponse(ctx) {
  ctx.log.info("checkout response matched", {
    status: ctx.response.status,
  });
}
```

## 示例 11：把文本响应替换成固定内容

用途：

- 临时替换 HTML、JS、文本接口返回
- 快速验证前端在特殊文案下的表现

推荐匹配：

- URL Pattern: `/announcement`
- Match Stage: `response`

```ts
export function onResponse(ctx) {
  ctx.response.setText("maintenance mode", "text/plain");
}
```

## 示例 12：对某些接口跳过修改，只打印日志

用途：

- 先观测，再逐步加逻辑
- 降低脚本调试风险

```ts
export function onRequest(ctx) {
  if (!ctx.request.url.includes("/api/orders")) {
    return;
  }

  ctx.log.info("orders request observed", {
    headers: ctx.request.headers.length,
  });
}
```

## 推荐调试方式

写脚本时建议按这个顺序来：

1. 先只写 `ctx.log.info(...)`
2. 确认 Rules 页匹配条件正确
3. 在 Sessions 里打开会话详情
4. 到 **Automation** 标签页看日志
5. 再加入 `setHeader`、`setJson`、`respond` 等修改逻辑

## 推荐实践

- 一条脚本规则只做一件事
- URL Pattern 尽量具体
- 高频接口尽量避免复杂计算
- 大对象日志只记录必要字段
- 有条件判断时，尽早 `return`

## 排障提示

如果脚本看起来“没生效”，优先检查：

1. 规则是否已启用
2. URL Pattern 是否命中
3. Match Stage 是否正确
4. Methods 是否匹配
5. 是否在 **Automation** 标签页里看到了 `runtimeError` 或 `invalidResult`
