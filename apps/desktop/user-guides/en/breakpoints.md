# Breakpoints Guide

Breakpoints let you **pause** traffic right before a request is sent or a response is returned, temporarily inspect or edit request/response fields, then decide to forward, drop, or replace it with a mock. They fit locating issues, manual packet-tweaking, and temporary mocking.

## What it's for

A breakpoint is a "manual intervention" tool: on a hit it **blocks** the request and waits for you to act in the intercept panel. That differs from [Rewrite](./rewrite-rules.md) / [scripts](./script-rules.md), which auto-rewrite — those run automatically, while a breakpoint needs you to handle each hit.

> A pending hit does not hang forever: it auto-forwards **without changes after 5 minutes** — the countdown chip in the intercept panel shows the time left. Remember to delete or disable breakpoint rules after debugging.

## Where to find it

1. Click **Rules** in the left nav
2. Click the **Breakpoint** tab at the top

Breakpoints use the same inline workbench as the other rule types: rule search, the rule list, and creation actions on the left, with the selected rule edited on the right. The creation area offers:

- **New Breakpoint Rule**: append a blank draft to the end of the list and edit its match conditions on the right
- **Break on all requests**: immediately add an enabled catch-all rule for the request stage
- **Break on all responses**: immediately add an enabled catch-all rule for the response stage

Each catch-all button is disabled while a matching rule already exists — to stop intercepting everything again, disable or delete that rule in the list. When the list is empty, the same creation actions appear in the empty state.

For fine control, click **New Breakpoint Rule**, confirm the enabled state in the identity row, fill in URL Pattern, Match Type, HTTP Methods, and Match Stage, then click **Save** in the fixed editor footer.

## Breakpoint rule fields

Breakpoint rules are leaner than other rule types — **no rule name, no priority**: a hit triggers immediately, handled "first match wins":

| Field | Description | Default |
|---|---|---|
| Enabled | Whether it's active | on |
| URL Pattern | URL match pattern; must be non-empty (use `*` to match everything — that's what the quick buttons create) | — |
| Match Type | How the URL Pattern is matched | `Contains` (substring) |
| HTTP Methods | Match only these methods; empty = all | empty (all methods) |
| Match Stage | Hit stage: request or response | request |

Match Type options are `Contains` (substring, default) / `Wildcard` / `Exact` / `Regex`, with the same meaning as [Rewrite's Match Type](./rewrite-rules.md#match-conditions).

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

**Forward** and **Mock Response** validate JSON bodies: if a body you edited (or the mock body) no longer parses as JSON, the action is blocked with an "Invalid JSON" message until you fix it. **Drop** is never blocked, and untouched or non-JSON bodies pass through unvalidated.

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

## Managing breakpoint rules

- Breakpoint rules are included in the Rules-page [import / export](./rewrite-rules.md#import--export-rules) file; imported breakpoint rules are appended disabled with fresh ids.
- List order is match order: the first matching rule triggers the breakpoint. Drag the row handle or use `Alt + ↑` / `Alt + ↓` (`⌥` on macOS) to reorder the selected rule.
- Search only filters visible rules. Reordering within search results keeps hidden rules in their original slots.
- The row checkboxes support batch enable, disable, and delete; both single and batch deletion ask for confirmation.
- Switching rules or tabs, or leaving the page, asks first when a draft has unsaved changes. `Ctrl/Cmd + S` saves the current draft.
- New, duplicated, and imported rules are appended to the end of the list rather than taking an earlier rule's position.

## FAQ

### Q: After a hit the request hangs with no response?

A breakpoint needs you to act: the panel releases on Forward / Drop / Mock, or auto-forwards without changes when the 5-minute countdown reaches zero. If the panel is closed, the Rules nav badge still shows pending breakpoints.

### Q: How is a breakpoint different from Rewrite / scripts?

Rewrite and scripts rewrite **automatically**, running silently on a hit; a breakpoint intervenes **manually**, requiring an action each hit. Breakpoints fit one-off debugging; recurring rewrites are better captured as Rewrite or script rules.

### Q: Why no priority on breakpoint rules?

Breakpoints trigger "first match wins": as soon as any rule matches, it pauses, so no priority ordering is needed.

### Q: How do I clean up after debugging?

Disable or delete the rule in the breakpoint list, and resolve any leftover pending breakpoints so later requests aren't left hanging.
