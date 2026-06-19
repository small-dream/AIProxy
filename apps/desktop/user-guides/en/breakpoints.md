# Breakpoints Guide

Breakpoints let you **pause** traffic right before a request is sent or a response is returned, temporarily inspect or edit request/response fields, then decide to forward, drop, or replace it with a mock. They fit locating issues, manual packet-tweaking, and temporary mocking.

## What it's for

A breakpoint is a "manual intervention" tool: on a hit it **blocks** the request and waits for you to act in the intercept panel. That differs from [Rewrite](./rewrite-rules.md) / [scripts](./script-rules.md), which auto-rewrite — those run automatically, while a breakpoint needs you to handle each hit.

> A breakpoint never auto-forwards. If you don't handle it, the matched request stays hung. Remember to delete or disable breakpoint rules after debugging.

## Where to find it

1. Click **Rules** in the left nav
2. Click the **Breakpoint** tab at the top

The page has two quick toggles at the top:

- **Break on all requests**: a fast breakpoint for the request stage of every request
- **Break on all responses**: a fast breakpoint for the response stage of every request

For fine control, click **Add Rule** to create a breakpoint rule with match conditions.

## Breakpoint rule fields

Breakpoint rules are leaner than other rule types — **no rule name, no priority**: a hit triggers immediately, handled "first match wins":

| Field | Description | Default |
|---|---|---|
| Enabled | Whether it's active | on |
| URL Pattern | URL match pattern | empty (empty matches all) |
| Match Type | How the URL Pattern is matched | `Contains` (substring) |
| HTTP Methods | Match only these methods; empty = all | empty (all methods) |
| Match Stage | Hit stage: request or response | request |

Match Type options are `Contains` (substring, default) / `Wildcard` / `Exact` / `Regex`, with the same meaning as [Rewrite's Match Type](./rewrite-rules.md#url-pattern-rules).

## The intercept panel on a hit

When a request or response hits a breakpoint, the **intercept panel** slides in on the right, and the Rules nav icon shows a pending-breakpoint count badge (click it to jump to the rules page). In the panel you can:

- **Forward**: continue the pipeline with no changes
- **Drop**: terminate the request/response and return an error to the client
- **Mock Response (request stage only)**: replace it with a custom response, skipping upstream

The panel lets you move between multiple pending breakpoints with prev/next buttons and shows "N / total".

### Editable fields

**Request stage** can edit:

- Query params (add / remove / edit)
- Request headers (add / remove / edit)
- Request body (Form / JSON / Raw modes; JSON can be formatted in one click)

**Response stage** can edit:

- Status code (100–599)
- Response headers
- Response body

After you edit a body, AIProxy automatically removes response headers that would mismatch the new body — `content-encoding`, `content-md5`, `digest`, `etag` — to avoid client validation failures.

## Breakpoint position in the pipeline

A breakpoint sits late in the rule chain, so it sees the result of earlier rewrites:

```text
Request: Rewrite -> Map -> Script(onRequest) -> Breakpoint -> Throttle -> Upstream
Response: Upstream/Local Response -> Response Rewrite -> Script(onResponse) -> Breakpoint -> Throttle -> Client
```

## Mock response

In the request stage, click **Mock Response** to enter mock mode and configure:

- Status code (default 200)
- Response headers (default includes `content-type: application/json`)
- Response body (default sample JSON)

On confirm, the request returns that mock response directly without hitting upstream. Good for quickly verifying how a client handles a given response.

## Typical uses

- **Locate intermittent issues**: set a request breakpoint on an endpoint and inspect the real headers / body on a hit
- **Manual packet-tweaking**: tweak one field to see the backend's reaction, without a Rewrite rule
- **Temporary mocking**: use Mock Response to return a fake response quickly
- **Verify client error handling**: change the status code to 500 at the response stage and watch the front end degrade

## FAQ

### Q: After a hit the request hangs with no response?

A breakpoint needs you to act. The intercept panel only releases on Forward / Drop / Mock. If the panel is closed, the Rules nav badge still shows pending breakpoints.

### Q: How is a breakpoint different from Rewrite / scripts?

Rewrite and scripts rewrite **automatically**, running silently on a hit; a breakpoint intervenes **manually**, requiring an action each hit. Breakpoints fit one-off debugging; recurring rewrites are better captured as Rewrite or script rules.

### Q: Why no priority on breakpoint rules?

Breakpoints trigger "first match wins": as soon as any rule matches, it pauses, so no priority ordering is needed.

### Q: How do I clean up after debugging?

Disable or delete the rule in the breakpoint list, and resolve any leftover pending breakpoints so later requests aren't left hanging.
