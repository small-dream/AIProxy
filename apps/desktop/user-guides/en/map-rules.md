# Map Rules (Map Local / Map Remote) Guide

Map rules let you point a matched request **elsewhere**: either return a local file directly (Map Local) or forward the request to another upstream URL (Map Remote). Both share the same fields; the difference is whether the target is a "local path" or a "remote URL".

## What it's for

- **Map Local**: on a hit, **return local file content directly**, skipping upstream. Good for mocking fixed responses or replacing online static assets with a local build.
- **Map Remote**: on a hit, **rewrite the upstream target URL** and continue the full proxy pipeline. Good for one-click environment switching (prod → staging / a mock gateway).

> Map Remote differs from [Rewrite's Redirect](./rewrite-rules.md): Redirect returns a redirect response to the client (the client then makes a new request); Map Remote swaps the upstream silently inside the proxy, the client is unaware, and the original capture context is preserved.

## Where to find it

1. Click **Rules** in the left nav
2. Click the **Mapping** tab at the top
3. Switch to **Map Local** or **Map Remote** inside Mapping (alongside [DNS mapping](./dns-mapping.md))

## Shared fields

Map Local and Map Remote share one field set:

| Field | Description | Default |
|---|---|---|
| Rule name | For recognition | — |
| Enabled | Whether it's active | on |
| Priority | Higher wins; on multiple matches the highest wins | `100` |
| Source URL pattern | The request URL pattern to match | — |
| Preserve Path | Keep the original request path | on |
| Preserve Query | Keep the original request query | on |

The source URL pattern uses **substring matching** (same as DNS mapping): empty or `*` matches all, otherwise the request URL must contain the substring. For example `example.com/assets/` matches requests under that path.

When multiple rules match, the **highest-priority** one wins.

## Map Local: return a local file

The **target** field takes a **local file or folder path** (use the "Choose File / Choose Folder" button to pick):

- A **file**: return that file's content directly on a hit
- A **folder**: locate the file under that folder by the request path (with "Preserve Path" on, the path is appended); for a folder root with no path, `index.html` is returned by default

The returned response:

- Status code is fixed **200**
- `Content-Type` is inferred from the file extension (e.g. `.json` → `application/json`, `.js` → JavaScript, `.png` → image/png; unrecognized → `application/octet-stream`)
- Body is the raw file content

> For safety, `.` / `..` in the request path are stripped to prevent reading arbitrary files outside the target folder.

### Pipeline behavior on a hit

Map Local produces a local response directly, so:

- The upstream request is **skipped**
- Request-stage [scripts](./script-rules.md) `onRequest` don't run
- But response-stage Rewrite / `onResponse` still process that local response

## Map Remote: forward to another upstream

The **target** field takes an **`http://` or `https://` base URL** (e.g. `https://staging.example.com`):

- On a hit, the request's host / upstream is swapped to that target
- With "Preserve Path / Preserve Query" on, the original path and query are appended to the new target. The target URL path is treated as a base path and slashes are normalized: `/gateway/` plus `/v1/users` becomes `/gateway/v1/users`.
- The request **continues the full proxy pipeline** ([scripts](./script-rules.md) / [breakpoints](./breakpoints.md) / [throttling](./throttling.md) / upstream) — it does not return a redirect to the client

For example, source `api.example.com`, target `https://staging.example.com`, with path and query preserved, `https://api.example.com/v1/users?id=1` is forwarded to `https://staging.example.com/v1/users?id=1`. The client is completely unaware, and Sessions keeps the original URL context.

## Map Remote vs Rewrite Redirect

| Dimension | Map Remote | Rewrite Redirect |
|---|---|---|
| Behavior | Swaps upstream inside the proxy; continues the pipeline | Returns a 3xx redirect response to the client |
| Client awareness | Unaware; connection intact | Client makes a new request to the target |
| Capture context | Original URL preserved | A new redirect request appears |
| Use | Switch environments / upstream | Force a client jump |

## Typical uses

### Map Local

- Map an API to a local fixed JSON for mocking
- Replace online JS / CSS with a local build (`dist/`) to debug front-end changes without publishing
- Point static assets like images / fonts at a local cache

### Map Remote

- One-click switch from a prod domain to staging for integration
- Point an endpoint at a mock gateway
- Temporarily route traffic to another service running on your machine

## FAQ

### Q: Map Local is set but no local file is returned?

Check:

1. Whether the rule is enabled
2. Whether the source URL pattern actually contains the target request URL (substring match)
3. Whether the target path exists and is readable
4. Whether a higher-priority rule matched first
5. If pointing at a folder, confirm the request path resolves to a file under it

### Q: Why don't scripts run after a Map Local hit?

Map Local returns a local response directly in the request stage, so `onRequest` is skipped — but the response-stage `onResponse` still runs.

### Q: Map Remote or Rewrite Redirect — which should I use?

Use Map Remote to "silently swap upstream with the client unaware"; use Rewrite Redirect to "have the client jump to a new address".

### Q: What does a folder map return at the root path?

By default it returns `index.html` under the folder. `.` / `..` in the request path are stripped, so it can't escape the target folder.
