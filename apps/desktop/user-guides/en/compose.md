# Compose Guide

Compose is AIProxy's built-in HTTP request builder, like a streamlined Postman. You can craft a request by hand and send it without leaving the desktop workspace, and see the response immediately.

## What it's for

Compose requests **connect directly to the target server** and **do not go through the proxy rules** — meaning [DNS mapping](./dns-mapping.md), [Rewrite](./rewrite-rules.md), [mapping](./map-rules.md), [scripts](./script-rules.md), [breakpoints](./breakpoints.md), and [throttling](./throttling.md) don't apply. It fits verifying an endpoint's real response directly, not testing the proxy chain.

> To test "what a request looks like after going through proxy rules", use the normal capture flow — not Compose.

## Where to find it

1. Click **Compose** in the left nav

The page is split top/bottom: the request editor on top and the response preview on the bottom, with a draggable divider.

You can also right-click a request in [Sessions](./sessions.md) → **Repeat** to jump to Compose with that request's params auto-filled.

## Build a request

### Method & URL

- **HTTP method**: GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS (default GET)
- **URL box**: enter a full URL; press **Enter** in the URL box to send directly

### Headers

Edit request headers as a key/value table; add/remove rows dynamically.

### Query params

Query params are auto-parsed from the current URL into a key/value table; edits are written back to the URL.

### Body

Pick a body type via the toggle at the top:

| Type | Description |
|---|---|
| none | No body |
| form-data | `multipart/form-data`, edited as key/value pairs (boundary and Content-Type generated automatically) |
| x-www-form-urlencoded | URL-encoded form, edited as key/value pairs |
| raw | Raw text body |

**raw** mode picks a language (which sets the Content-Type):

| Language | Content-Type |
|---|---|
| Text | `text/plain` |
| JSON | `application/json` |
| XML | `application/xml` |
| HTML | `text/html` |
| JavaScript | `application/javascript` |

> form-data currently supports text fields only — **no file upload**.

## Send & response

Click **Send** (disabled when the URL is empty or a request is in flight). The response area reuses the same inspector as Sessions, offering:

- **Overview**: status code, duration, size, client/server connection info
- **Headers**: response headers
- **JSON / JSON Text**: tree or text JSON (searchable)
- **Raw / Text**: raw or plain-text response
- **Preview**: inline preview for images and other media
- **Timing**: per-stage durations

Request failures show an error.

## Relationship with Sessions

Compose requests are **inserted into the Sessions list as sessions**, so you can revisit, search, and [compare](./session-compare.md) them like any captured traffic. So Compose is both a builder and a "send-and-record" capture method.

## Current limits

- **Does not go through proxy rules** (direct connection)
- **No environment variables** (no `{{var}}` substitution; for environment switching use [Collections](./collections-and-environments.md))
- **No save-to-collection**, **no request history**
- **No form-data file upload**
- Bodies are truncated past **20 MB**

## FAQ

### Q: Why didn't my Rewrite / DNS mapping apply to a Compose request?

Compose is a direct connection that intentionally bypasses the proxy rules. To test proxy-rule effects, browse / use the client through the system proxy and capture normally.

### Q: Do Compose requests show up in Sessions?

Yes. Each send is inserted as a session, for later inspection and comparison.

### Q: How do I send a request with environment variables?

Compose doesn't support them. Save the request to [Collections](./collections-and-environments.md) and use `{{var}}` environment variables there.

### Q: How do I quickly resend a captured request?

Right-click the request in Sessions → **Repeat**; it loads into Compose for editing and resending.

### Q: Can I save a crafted request for reuse?

Compose itself doesn't save. For persistence, use Collections: right-click a request in Sessions → **Save to Collection**, then call it from the collection anytime.
