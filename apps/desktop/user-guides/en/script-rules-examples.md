# Script Rule Examples

This example set accompanies [script-rules.md](./script-rules.md).

If you're new to script rules, the suggested order is:

1. "Set a request header" first
2. Then "conditional mock"
3. Then "response extraction" and "response rewrite"

## Example 1: add a debug header to all API requests

Purpose:

- Tag the backend
- Flip certain debug switches
- Identify the source in captures or server logs

Recommended match:

- URL Pattern: `api.example.com`
- Match Stage: `request`
- Methods: leave empty or pick as needed

```ts
export function onRequest(ctx) {
  ctx.request.setHeader("x-debug-mode", "true");
  ctx.log.info("debug header added", {
    url: ctx.request.url,
  });
}
```

## Example 2: add a header only on POST requests

Purpose:

- Avoid side effects on GET requests
- Mark only write operations

Recommended match:

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

## Example 3: switch to a mock response based on a URL param

Purpose:

- Temporarily turn on mocking
- Control whether the script hits via a request param, without changing front-end code

Recommended match:

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

## Example 4: mock based on a request header

Purpose:

- Only specific requests return a mock
- Pair with a front-end switch or test traffic

Recommended match:

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

## Example 5: force an env field to staging in request bodies

Purpose:

- Auto-switch requests to pre-release during integration
- Avoid editing each request body by hand

Recommended match:

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

## Example 6: flip front-end feature flags in a response

Purpose:

- Simulate a backend that has a feature flag on
- Verify new front-end UI

Recommended match:

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

## Example 7: extract a token from a login response

Purpose:

- Quickly see the token returned by login
- Debug an auth chain

Recommended match:

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

## Example 8: extract a user ID and status from a response

Purpose:

- Keep structured fields for troubleshooting
- Quickly review key values in the Automation tab

Recommended match:

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

## Example 9: append a debug field to error responses

Purpose:

- Verify error-handling branches locally on the front end
- Add extra context to problem responses

Recommended match:

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

## Example 10: log hits for a class of requests

Purpose:

- Observe without modifying traffic
- Confirm the script hits the expected endpoints

Recommended match:

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

## Example 11: replace a text response with fixed content

Purpose:

- Temporarily replace an HTML, JS, or text endpoint
- Quickly verify front-end behavior under special copy

Recommended match:

- URL Pattern: `/announcement`
- Match Stage: `response`

```ts
export function onResponse(ctx) {
  ctx.response.setText("maintenance mode", "text/plain");
}
```

## Example 12: skip modification for some endpoints, just log

Purpose:

- Observe first, then add logic gradually
- Lower the risk of script debugging

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

## Recommended debugging flow

When writing a script, follow this order:

1. Write only `ctx.log.info(...)` first
2. Confirm the Rules-page match conditions are right
3. Open the session detail in Sessions
4. Check the **Automation** tab for logs
5. Then add `setHeader`, `setJson`, `respond`, and other modification logic

## Recommended practices

- One script rule does one thing
- Keep the URL Pattern specific
- Avoid heavy computation on high-traffic endpoints
- For large object logs, record only essential fields
- With conditionals, `return` as early as possible

## Troubleshooting tips

If a script seems to "not take effect", check first:

1. Whether the rule is enabled
2. Whether the URL Pattern matches
3. Whether the Match Stage is correct
4. Whether the Methods match
5. Whether the **Automation** tab shows `runtimeError` or `invalidResult`
