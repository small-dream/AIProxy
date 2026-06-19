# Sessions Guide

Sessions is AIProxy's core page: every HTTP / HTTPS / WebSocket flow that goes through the proxy shows up here, auto-grouped by host and path. You can inspect, filter, search, compare, and export them in real time.

## Where to find it

1. Open AIProxy
2. Click **Sessions** in the left nav (the home page, route `/`)

The page has two panes: the session browser (tree list + filters) on the left, and the inspector workspace for the selected session on the right.

## Session containers

The page supports multiple **session container** tabs. Each container keeps its own session set and filter state, so you can separate different scenarios (e.g. "Login flow", "Checkout debugging").

- Use the **New Session Container** button at the top to add a container
- Each container tab can be closed independently
- The container currently recording traffic shows a **Live** indicator

> Containers are also the unit of [session comparison](./session-compare.md): you can diff two containers to compare their calling behavior.

## Session browser

### Grouping

Sessions are grouped first by **Host**, then expanded into a tree by **Path**. This keeps hundreds of requests navigable by site.

- Requests not belonging to any focused host go into the **Unfocused** group
- Requests with a missing hostname show as `<unknown>`

### Per-row display

Each row shows:

- **HTTP method** (GET / POST / …)
- **Path** (with the query suffix)
- **Resource-type icon**: auto-detected from the response, e.g. JSON, JavaScript, CSS, HTML, image, text, WebSocket, file — color-coded
- **Status**: "Pending" while in flight, the status code once complete; failed / cancelled requests have their own indicators

### Filter & search

- **Filter box**: filter by host keyword
- **Search box**: search by host or path keyword
- **Throttled / All Sessions**: toggle at the top to show only requests affected by [throttling](./throttling.md)
- **Clear Session**: clears all sessions in the current container

### Focus & ignore

Right-click a host group or a single request to:

- **Add Focus / Remove Focus**: pin a host as a "focused" host to look at it alone
- **Ignore / Stop Ignoring**: silence a host (e.g. noisy analytics) so it no longer appears

## Inspector workspace

With a session selected, the right side splits into **Request** and **Response** areas.

### Request tabs

| Tab | Content |
|---|---|
| Query | URL query parameters as key/value pairs |
| Form | Form fields (when a form is detected) |
| Body | Request body, searchable |
| Headers | Request headers as key/value pairs |
| Raw | Raw HTTP request text |

### Response tabs

Tabs appear dynamically based on the response type:

| Tab | Content |
|---|---|
| Overview | Status code, Content-Type, client address, timing, size, connection info, a timing waterfall |
| Headers | Response headers |
| JSON | Tree viewer (collapsible, searchable) |
| JSON Text | Pretty-printed JSON text, searchable |
| Text | Plain text, searchable |
| Raw | Raw response text |
| Preview | Inline preview for images and other media |
| Messages | WebSocket message inspector (see the [WebSocket guide](./websocket-inspector.md)) |
| Automation | Trace of matched [Rewrite](./rewrite-rules.md) / [script](./script-rules.md) / [throttle](./throttling.md) rules |
| Trailers | HTTP trailers (when present) |

### Body size limit

A single body is captured up to **20 MB** and truncated past that (both the list and the inspector warn you). When a JSON payload is too large for the tree view, switch to **JSON Text** or **Raw**.

## Right-click actions

Right-clicking a session offers actions grouped roughly as:

- **Copy**: Copy URL / Copy Request / Copy cURL / Copy Response
- **Compare**: Set as Compare Base / Compare with Base — for [session comparison](./session-compare.md)
- **Save / Export**: Save Response, Export Request, Save to [Collection](./collections-and-environments.md)
- **Request actions**: Compose (load into [Compose](./compose.md)), Repeat, Save to Collection
- **Create rule**: create a Rewrite / throttling / breakpoint / mapping rule based on that request
- **Host management**: Add/Remove Focus, Ignore/Stop Ignoring
- **Clear others**: keep only the current session

Right-clicking a host group also lets you **Export Host**, or Focus / Ignore that host.

## Import & export

AIProxy supports the **HAR** format:

- **Export**: choose a scope — All Sessions / Filtered Sessions / Selected Domain / Selected Session — and export a `.har` file
- **Import**: load a HAR file into the current workspace to keep viewing, filtering, and re-exporting

## Performance

The session list uses virtual scrolling (only visible rows render), so even thousands of sessions scroll smoothly. WebSocket messages are kept in memory up to about 10,000 entries and trimmed automatically beyond that.

## FAQ

### Q: Why do some sessions show only "Pending"?

The request has been sent but the response hasn't come back yet (or the connection hung), so the status is "Pending". A cancelled request shows "Cancelled".

### Q: Can I look at just one endpoint?

Yes. Type a path keyword in the search box, or **Add Focus** on that endpoint's host and narrow further with the filter box. You can also right-click a request to create a targeted rule.

### Q: The body shows as truncated?

A single body is truncated past 20 MB. If a JSON payload is too large to render as a tree, switch to **JSON Text** or **Raw**.

### Q: Do Compose requests show up here?

Yes. Requests sent from [Compose](./compose.md) are inserted into the list as sessions, so you can inspect and compare them like any captured traffic.

### Q: How do I replay a captured request over and over?

Right-click the request → **Save to Collection** (persist it into [Collections](./collections-and-environments.md)), or **Compose** (load it into Compose to resend directly).
