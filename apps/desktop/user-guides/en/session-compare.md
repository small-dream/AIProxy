# Session Compare Guide

Compare lets you diff two requests or two groups of requests side by side, to quickly spot differences in params, headers, body, response, or calling behavior — and can generate an AI summary of the diff.

## Two compare modes

| Mode | What's compared | Focus |
|---|---|---|
| **Request Compare** | Two individual requests | Differences in params, headers, body, response, timing |
| **Session Compare** | Two groups of requests (session containers) | Request frequency, call counts, endpoint coverage, call order |

## Where to find it

1. Click **Compare** in the left nav

The page has the diff workbench on the left and a collapsible AI-summary panel on the right.

> You can also use right-click **Set as Compare Base** / **Compare with Base** in [Sessions](./sessions.md) to quickly send requests into Request Compare.

## Request Compare

### Pick two requests

Use the **Left Request / Right Request** dropdowns to pick one session each from the captured set. Selections sync to URL params, so you can share or save a compare state.

### Diff dimensions

Selected requests are diffed item by item:

| Dimension | Content |
|---|---|
| Summary | Method, URL, status, duration, size, protocol, MIME |
| Query | URL query-param differences |
| Request Headers | Request-header differences |
| Request Body | Request-body differences |
| Response Headers | Response-header differences |
| Response Body | Response-body differences |
| Timing | DNS / connect / TLS / send / wait / read per-stage durations |

Each dimension shows a count above (added / removed / changed / unchanged) and the left/right values of each difference below.

### Body diff

- The body is collapsed by default; click **Compute body diff** to expand
- JSON goes through **semantic diff** (recursive compare by field path, marking added / removed / changed)
- Non-JSON content goes through **line-level text diff**
- Very large bodies are truncated (~256 KB) with a truncation notice

## Session Compare

### Pick two groups

Use the **Left Session / Right Session** dropdowns to pick a **session container** each (create them on the Sessions page via "New Session Container"). Optionally select specific domains to filter further.

### Diff dimensions

| Dimension | Content |
|---|---|
| Overview | Total requests, success/failure counts, domain count, total bytes, status distribution, duration stats |
| Domains | Per-domain request count, share, delta |
| Endpoints | Per-endpoint call count, avg duration, status distribution, change type |
| Timeline | Per-time-bucket request distribution on both sides |
| Sequence | Endpoint call-order comparison, added/missing endpoints, duplicate-call stats |

Good for questions like "did these two operations differ in endpoints, order, or frequency".

## AI diff summary

The right **AI Summary** panel can send the current diff to an AI for a Markdown summary.

### Prerequisite

Configure an **OpenAI-compatible** model in **Settings**:

- API Key
- Base URL
- Model name
- (optional) Temperature, timeout

When unconfigured, the panel prompts and offers a **Configure AI Model** button to jump to Settings.

### Usage

1. Pick compare objects and wait for the diff to compute
2. Click **Generate Summary**
3. The generated Markdown summary renders in the panel

### Privacy & redaction

- Click **Preview AI Payload** before sending to review the full input JSON
- Sensitive fields (token, password, etc.) are auto-redacted
- Whether to include body content in the AI input is controlled by a toggle; redaction happens locally before upload

## FAQ

### Q: The AI-summary button is grayed out?

You need to configure an AI model in Settings (API Key / Base URL / model) first, and wait for the diff to finish computing.

### Q: Why is the body collapsed by default in Request Compare?

Body diff is heavier, so it's collapsed to speed up the first render. Click **Compute body diff** when you need it.

### Q: I can't pick containers in Session Compare?

You need at least two containers created on the Sessions page via **New Session Container**, with each scenario's traffic captured into its own container.

### Q: The body diff is incomplete for large bodies?

Bodies are truncated past ~256 KB. For a full compare, reduce the request body size or focus on key fields.

### Q: Can I share a compare state?

Yes. Request Compare's left/right selections sync to URL params; copying the current URL reproduces the same compare config.
