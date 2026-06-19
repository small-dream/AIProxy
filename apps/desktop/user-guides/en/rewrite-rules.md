# Rewrite Rules Guide

## What it does

Rewrite rules let you automatically modify matched HTTP requests or responses as the proxy forwards them. They fit debugging, mocking, temporary environment switching, header tweaks, disabling cache, and replacing response content.

Rewrite is not a text-generation capability — it's an automatic packet-rewriting capability at the proxy layer. Once saved, a rule joins the proxy pipeline immediately.

## Typical uses

- **Add a debug header**: e.g. add `x-debug-mode: true` to requests
- **Switch environments**: redirect matched API requests to a staging upstream
- **Append query params**: e.g. auto-append `env=staging`
- **Disable response caching**: override `Cache-Control`
- **Mock a JSON response**: replace the response body with fixed JSON, or modify/delete specific fields by path
- **Debug CORS / auth issues**: temporarily add/remove headers to locate the cause

## Where to find it

1. Open AIProxy
2. Click **Rules** in the left nav
3. Click the **Rewrite** tab at the top

You can also right-click a request in the Sessions list and choose **Create Rewrite Rule** — AIProxy generates an editable Rewrite draft from the current request.

## Current capabilities

This version supports:

- Header rewrite: add / override / remove request or response headers
- Query rewrite: add / override / remove request URL query params
- Body rewrite: replace the whole request or response body, or modify/delete specific fields by JSON Path, and set `Content-Type`
- Redirect rewrite: forward a request to another target URL, optionally keeping the original path / query
- URL Pattern, HTTP Method, and Stage matching
- Priority and enable/disable control
- Common templates
- A pre-save rule tester
- A Session Automation tab showing Rewrite hit records with before/after diff

Not yet supported:

- Modifying the response status code
- A dedicated Cookie editor
- Regex capture-and-replace
- Variable templates such as `{{timestamp}}`, `{{uuid}}`
- Header / Query / Body conditional expressions

## Rule workbench

The Rewrite page uses a staged workbench:

- **Templates**: create a rule from a common scenario
- **When**: configure match conditions
- **Then**: configure rewrite actions
- **Test**: verify a hit before saving, using a sample URL, Method, and Stage

### Templates

Built-in templates:

- **Debug header**: add a debug header to requests
- **Disable cache**: set response cache headers
- **Env query**: append an environment query param
- **Staging redirect**: redirect to a staging upstream
- **Mock JSON**: replace the response with fixed JSON

New users should start from a template, then adjust the URL Pattern, Method, and specific fields.

## Match conditions

| Field | Description | Example |
|---|---|---|
| Rule Name | A name for search and recognition | `API → staging` |
| Enabled | Whether the rule is active | on |
| Priority | Higher wins | `100` |
| URL Pattern | The URL match pattern, interpreted per Match Type | `api.example.com/v1/*` |
| Match Type | How the URL Pattern is matched, default Contains | `Wildcard` |
| HTTP Methods | Match only these methods; empty = all | `GET, POST` |
| Match Stage | Request stage, response stage, or either | `request` |

### URL Pattern rules

Match Type controls how the URL Pattern is compared against the request URL. Four options:

| Match Type | Behavior | Pattern example | Matches `https://api.example.com/v1/users` |
|---|---|---|---|
| **Contains** (default) | URL contains the pattern (substring) | `api.example.com` | ✓ |
| **Wildcard** | `*` matches zero or more characters | `api.example.com/v1/*` | ✓ |
| **Exact** | URL must equal the pattern | `https://api.example.com/v1/users` | ✓ |
| **Regex** | Pattern is a regular expression | `api\.example\.com/v1/.*` | ✓ |

In Contains mode, an empty value or `*` matches all URLs. In Wildcard mode, an empty value or `*` also matches all URLs.

Examples:

| Match Type | Pattern | Matches |
|---|---|---|
| Contains | `api.example.com` | `https://api.example.com/v1/users` |
| Wildcard | `api.example.com/v1/*` | `https://api.example.com/v1/users?id=1` |
| Wildcard | `*login*` | any URL containing `login` |
| Exact | `https://api.example.com/v1/users` | only that exact URL |
| Regex | `api\..*\.com/v[12]/` | `api.example.com/v1/users`, `api.staging.com/v2/items` |

## Rewrite actions

### Header Rewrite

Can target request or response.

Supports:

- `set`: add or override a header
- `remove`: delete a header

Examples:

| Target | Op | Header | Value |
|---|---|---|---|
| request | set | `x-debug-mode` | `true` |
| response | set | `Cache-Control` | `no-store` |
| response | remove | `ETag` | - |

### Query Rewrite

Query Rewrite only takes effect before the request goes upstream.

Supports:

- `set`: add or override a query param
- `remove`: delete a query param

Examples:

| Op | Param | Value |
|---|---|---|
| set | `env` | `staging` |
| remove | `utm_source` | - |

### Body Rewrite

Can target request or response, with two modes:

**Replace mode** (whole-body replacement):
- Replace the entire body with custom content
- Also set the `Content-Type`

Example response JSON:

```json
{
  "ok": true,
  "source": "aiproxy"
}
```

**Fields mode** (field-level modification):
- Locate and modify/delete specific fields by JSON Path
- Supports object paths like `data.user.name` and array indices like `items[0].name`
- Supports the `$.` prefix (e.g. `$.data.user.name`)
- Each field supports:
  - `set`: set the field to a typed value (string / number / boolean / null / JSON)
  - `remove`: delete the field
- In fields mode you still need to set `Content-Type` (usually `application/json`)

Fields-mode example — modifying a JSON response:

| Op | Path | Type | Value |
|---|---|---|---|
| set | `user.name` | string | `Jane` |
| set | `user.enabled` | boolean | `true` |
| remove | `debug` | — | — |

Original body:

```json
{"user":{"name":"Jake"},"debug":true}
```

After rewrite:

```json
{"user":{"name":"Jane","enabled":true}}
```

### Redirect Rewrite

Redirect Rewrite only takes effect before the request goes upstream. It changes the target URL.

Options:

- **Preserve Path**: keep the original request path
- **Preserve Query**: keep the original request query

Example:

Original request:

```text
https://api.example.com/v1/users?id=1
```

Target:

```text
https://staging.example.com
```

With both path and query preserved, the final request becomes:

```text
https://staging.example.com/v1/users?id=1
```

## Rule tester

The **Test** panel on the right verifies whether the current rule will hit, before saving.

Inputs:

- Sample URL
- Method
- Stage

Outputs:

- Whether it hits
- The miss reason, e.g. Method mismatch, URL mismatch, Stage mismatch
- A summary of the actions expected to run on a hit

## Create a rule from a session

Right-click a request in the Sessions list and choose **Create Rewrite Rule**.

AIProxy auto-fills:

- The current request URL
- Host + Path as the URL Pattern
- The current HTTP Method
- The default request stage
- A header-rewrite draft you can save immediately

This is the recommended path, especially for generating rules quickly from real traffic.

## View hit records & diff

Open a session and click the **Automation** tab in the Response area.

If that request matched a Rewrite, the page shows:

- The matched rule name and ID
- The Rewrite type
- The execution stage
- The result: success / skipped / failed
- Duration
- The before/after diff

Diff by type:

- Header: original vs. rewritten header values
- Query: original vs. rewritten param values
- Body: original vs. rewritten body preview; in fields mode, each field's before/after values
- Redirect: original vs. rewritten URL

## Execution order

Request stage:

```text
Rewrite -> Map -> Script(onRequest) -> Breakpoint -> Throttle -> Upstream
```

Response stage:

```text
Upstream / Local Response -> Response Rewrite -> Script(onResponse) -> Breakpoint -> Throttle -> Client
```

Notes:

- When `Map Local` returns a local response directly, the request-stage Script doesn't run, but response-stage Rewrite / Script can still process that returned content
- When the response body exceeds the capture limit, AIProxy skips response Body rewrites to avoid performance issues with large files

## Invalid-combination guards

This version blocks or warns about these easily-misunderstood combinations:

- Query Rewrite at the response stage
- Redirect Rewrite at the response stage
- A request-stage rule that picks a response Header / Body target
- A response-stage rule that picks a request Header / Body target

If you see a warning, adjust the Stage or Target as suggested.

## FAQ

### Q: The rule is saved but doesn't take effect?

Check:

1. Whether the rule is enabled
2. Whether the URL Pattern matches the full URL
3. Whether the HTTP Method matches
4. Whether the Match Stage matches
5. Whether a higher-priority rule modified the URL or related fields first
6. Whether the Automation tab shows skipped / failed records

### Q: Why can't Query / Redirect be used at the response stage?

Query and Redirect modify the request URL about to go upstream. By the time the response comes back, the request target is already fixed, so these actions only make sense at the request stage.

### Q: How do multiple Rewrite rules execute?

Within the same stage, matched Rewrite rules run in priority order, high to low. A later rule may see the request or response as modified by an earlier rule.

### Q: What's the difference between Rewrite and Script?

Rewrite fits common, structured, low-barrier rewrites like Header, Query, Body, and Redirect. Script fits complex conditions, dynamic logic, field-level processing, and custom mocks. Prefer Rewrite in general; reach for Script for complex cases.
