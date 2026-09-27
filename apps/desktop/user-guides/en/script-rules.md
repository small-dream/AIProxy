# TypeScript / JavaScript Script Rules Guide

## What it does

Script rules let you write custom proxy logic in a single-file `JavaScript` or `TypeScript` source and participate in processing traffic before a request is sent or a response is returned.

Use cases:

- **Dynamic rewriting**: modify a request or response based on URL, method, headers, or body
- **Conditional filtering**: only take effect under specific conditions
- **Dynamic mocking**: return a custom response directly without hitting the upstream
- **Data extraction**: pull a token, ID, or status field out of a response and log it
- **Debug logging**: add logging for specific requests to review script hits later

## Current capability boundaries

`v1` supports:

- HTTP / HTTPS request and response stage scripts
- Single-file `JS / TS`
- In-app editing
- One-time import from a local `.js / .mjs / .ts / .mts` file
- `async` hook functions (`await` works inside them)
- Per-session log and extraction viewing; the Automation tab shows both Rewrite hit records and Script traces

`v1` does not support:

- Scripting WebSocket messages
- Multi-file projects
- `npm` dependencies
- `import / require`
- File system, network, or system-command access
- Timers or background tasks

## Where to find it

1. Open AIProxy
2. Click **Rules** in the left nav
3. Click the **Scripts** tab at the top

## Create a script rule

1. Click **New Script Rule**
2. Fill in the basic info in the right editor
3. Choose the script language:
   - `TypeScript`
   - `JavaScript`
4. Fill in the match conditions:
   - URL Pattern
   - HTTP Methods
   - Match Stage
5. Type the script in the source area
6. Click **Save Rule**

Once saved, the rule takes effect immediately.

## Fields

| Field | Description | Example |
|---|---|---|
| Rule Name | A name for search and recognition | `Add debug header to API` |
| Enabled | Whether the rule is active (also toggleable inline in the list) | on |
| Priority | Higher wins; drag rows in the list to reorder — priorities renumber automatically | `100` |
| URL Pattern | Matches against the request URL, interpreted per Match Type | `api.example.com/v1/` |
| Match Type | Contains (default) / Wildcard / Exact / Regex | Contains |
| HTTP Methods | Match only these methods; empty = all | `GET, POST` |
| Match Stage | `request`, `response`, `either` | `request` |
| Language | `TypeScript` or `JavaScript` | `TypeScript` |
| Script Source | The script body | see examples below |

## Managing script rules

Tick row checkboxes for bulk **Enable / Disable / Delete**, and drag row handles to reorder — priorities renumber so list order equals precedence. Script rules are included in the Rules-page [import / export](./rewrite-rules.md#import--export-rules).

## Import a local script file

If you've already written a script file locally, you can import it directly:

1. Click **Import File**
2. Pick a local file
3. Supported extensions:
   - `.js`
   - `.mjs`
   - `.ts`
   - `.mts`
4. After import, the source is copied into the current rule

Notes:

- Import is a **one-time copy**, not a live binding to the external file
- Later changes to the external file do not sync back into AIProxy

## Built-in templates

The script-rules page offers a few quick templates:

- **Set Header**: add a header to a request
- **Mock Response**: return a custom response conditionally
- **Extract Data**: pull a field out of a response and log it

Start from a template, then refine the logic.

## Export convention

A script may only export these two functions:

```ts
export function onRequest(ctx) {}
export function onResponse(ctx) {}
```

A rule can export just one, or both.

Not supported:

- `export const ...`
- `export default ...`
- `import ...`
- `require(...)`

## Execution timing

Script rules run in this order:

### Request stage

`Rewrite -> Map -> Script(onRequest) -> Breakpoint -> Throttle -> Upstream`

### Response stage

`Upstream / Local Response -> Response Rewrite -> Script(onResponse) -> Breakpoint -> Throttle -> Client`

Notes:

- If `Map Local` already returned a local response, `onRequest` won't run
- But `onResponse` still runs on that local response

## `ctx` capabilities

The runtime exposes only a minimal host API.

### `ctx.request`

Readable in both the request and response stages.

Common fields and methods:

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

Only available inside `onResponse(ctx)`.

Common fields and methods:

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

Current session basics:

- `ctx.session.id`
- `ctx.session.host`
- `ctx.session.method`
- `ctx.session.path`
- `ctx.session.url`
- `ctx.session.workspaceId`
- `ctx.session.stage`

### `ctx.log`

For debug logging:

- `ctx.log.debug(message, data?)`
- `ctx.log.info(message, data?)`
- `ctx.log.warn(message, data?)`
- `ctx.log.error(message, data?)`

### `ctx.extract(key, value)`

For extracting structured data, to review later in session details.

### `ctx.respond(...)`

For generating a response directly inside `onRequest`:

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

Calling this skips the upstream request and returns that response directly.

## Common examples

### Example 1: add a header to a request

```ts
export function onRequest(ctx) {
  ctx.request.setHeader("x-debug-mode", "true");
}
```

Use cases:

- Flip a server-side debug switch
- Tag a request
- Mark canary traffic

### Example 2: mock by path

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

Use cases:

- Temporary mock during front-end/back-end integration
- Verify how a client behaves under special response data

### Example 3: extract a token from the response

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

Use cases:

- Auto-record a token after the login API returns
- Pull key business fields for troubleshooting

### Example 4: rewrite a response conditionally

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

Use cases:

- Flip a front-end feature flag
- Simulate different backend configs

## Debugging & viewing results

After a script hits, its logs and extracted data are viewable in the session details:

1. Open **Sessions**
2. Pick a session that matched a script rule
3. In the right inspector's Response area, click the **Automation** tab

You'll see:

- The matched script rule
- The execution stage (request / response)
- The result (success / skipped / runtimeError / timedOut / invalidResult)
- Duration
- `ctx.log.*` output
- Structured data from `ctx.extract(...)`

## Failure handling

Script rules default to a **fail-open** policy.

This means:

- A script error does not fail the whole request
- A script timeout continues along the original pipeline
- An invalid return result has that modification discarded
- Errors are recorded in the **Automation** tab for review
- If the same request also matched a Rewrite, the Automation tab shows the Rewrite before/after diff first, then the Script logs

This prevents one script rule from stalling the whole proxy chain.

## Resource limits

To keep the proxy stable, scripts are bounded:

- Max single-script source size: `128 KB`
- Max single-hook execution timeout: `500 ms`
- Max log / extract entries per run: `50`
- Max serialization size per log entry or extract value: `8 KB`
- Per-run memory cap: `16 MB` — exceeding it fails that hook, fail-open
- Up to 64 hooks run concurrently; excess runs wait for a free slot and are skipped when one doesn't free up in time

Recommendations:

- Keep script logic simple and direct
- Avoid heavy computation and huge object logging
- Avoid heavy JSON processing in scripts

## Security limits

Scripts run in a strict sandbox and by default **cannot**:

- Make network requests
- Read or write files
- Run local system commands
- Use `import` or `require`
- Use Tauri / Node / Deno APIs

This keeps the proxy stable and prevents user scripts from affecting the desktop environment or request-chain security.

## Matching advice

To avoid a script rule "catching" too much traffic:

- Keep the URL Pattern specific; avoid long-term `*`
- Narrow scope with HTTP Methods
- Set Match Stage to `request` or `response` as needed
- Use Priority to order multiple script rules

## FAQ

### Q: Why does the script fail to save?

Common causes:

1. No `onRequest` or `onResponse` exported
2. An unsupported export form
3. A TypeScript / JavaScript syntax error
4. The script exceeds the size limit

### Q: Why doesn't the script take effect?

Check:

1. Whether the rule is enabled
2. Whether the URL Pattern matches the current request
3. Whether the HTTP Methods match
4. Whether the Match Stage is correct
5. Whether a higher-priority script rule modified the traffic first

### Q: Why is `ctx.response` unavailable in `onRequest`?

Because the response hasn't come back yet; `ctx.response` is only available inside `onResponse(ctx)`.

### Q: Why didn't `onRequest` run after `Map Local` matched?

That's by design. `Map Local` already produced a local response in the request stage, so `onRequest` is skipped — but the matching `onResponse` still runs.

### Q: Can a script access disk files or call external APIs?

No. `v1` runs in a strict sandbox with no file-system or network access.

### Q: Can I split it across multiple files?

Not currently. `v1` supports single-file scripts only.

## Recommended practices

- Start from a template; don't write long scripts from scratch
- One rule, one problem — easier to troubleshoot
- Use `ctx.log.info(...)` to observe hits first, then add modification logic
- For high-traffic endpoints, keep logic lightweight to avoid proxy jitter
