# Sessions Guide

Sessions is AIProxy's core page: every HTTP / HTTPS / WebSocket flow that goes through the proxy shows up here, auto-grouped by host and path. You can inspect, filter, search, compare, and export them in real time.

## Where to find it

1. Open AIProxy
2. Click **Sessions** in the left nav (the home page, route `/`)

The page has two panes: the session browser (tree list + filters) on the left, and the inspector workspace for the selected session on the right.

## Session containers

The page supports multiple **session container** tabs. Each container keeps its own session set and filter state, so you can separate different scenarios (e.g. "Login flow", "Checkout debugging").

- Use the **New Session Container** button at the top to add a container
- The ✕ on the active tab closes the current container (the ✕ appears once more than one container exists); you can't close a background tab directly — switch to it first

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

### Multi-select & keyboard navigation

`Ctrl/Cmd`+click adds a session to the selection, `Shift`+click selects a visual range; `↑`/`↓` move the selection, `Home`/`End` jump to the first/last row, `Esc` clears it. With rows selected, a batch bar appears offering Export (HAR), Save responses, Delete (with confirmation), and Clear. Selection applies to the sessions visible under the current filter.

### Filter & search

- **Search box** (below the tree): matches any field — URL / host, path, method, status code, MIME type, protocol
- **Focus / Ignore chips**: focused and ignored hosts render as removable chips above the list (an active throttle as a warning chip); a category with many hosts collapses into one summary chip whose popover lists each host individually
- **Throttled / All Sessions**: toggle at the top to show only requests affected by [throttling](./throttling.md)
- **Clear Session**: clears all sessions in the current container; tick "clear without asking again" in the confirm dialog to skip it from then on (re-enable the confirmation in Settings → Notifications & confirmations)

### Focus & ignore

Right-click a host group or a single request to:

- **Add Focus / Remove Focus**: pin a host as a "focused" host to look at it alone
- **Ignore / Stop Ignoring**: silence a host (e.g. noisy analytics) so it no longer appears

## Inspector workspace

With a session selected, the right side splits into **Request** and **Response** areas. `Ctrl/Cmd + F` opens a per-pane search bar (match case / whole word / regular expression) over request/response content.

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
- **Request actions**: Compose (load into [Compose](./compose.md)), Repeat, Save to Collection, Export Request
- **Create rule**: Rewrite / Throttling Rule / Map Local are pre-filled from the request; **Breakpoints…** opens the Breakpoint tab without seeding a rule
- **SSL decryption**: Enable/Disable SSL Decryption for this host — an excluded host is relayed blind (no MITM); a running proxy restarts to apply
- **Host management**: Add/Remove Focus, Ignore/Stop Ignoring
- **Clear others**: keep only the current session

Right-clicking a host group also lets you **Export Host**, or Focus / Ignore that host. Path folder nodes offer **Save All Files…** (see [Import & export](#import--export)).

## Import & export

AIProxy supports the **HAR** format:

- **Export**: choose a scope — All Sessions / Filtered Sessions / Selected Domain / Selected Session — and export a `.har` file
- **Import**: load a HAR file into the current workspace to keep viewing, filtering, and re-exporting

### Save captured files to disk

Right-click any path-folder node or host group → **Save All Files…**: choose how name conflicts are handled ("keep only the last request" vs "save every request", suffixed `name (1).ext`), pick a target folder, and response bodies are written mirroring the URL path below the host — extensions are inferred from MIME when missing; WebSocket and body-less requests are skipped. A snackbar reports saved / skipped / failed counts.

## Performance

The session list uses virtual scrolling (only visible rows render), so even thousands of sessions scroll smoothly. WebSocket messages are kept in memory up to about 10,000 entries and trimmed automatically beyond that.

## FAQ

### Q: Why do some sessions show only "Pending"?

The request has been sent but the response hasn't come back yet (or the connection hung), so the status is "Pending". After about two minutes without a response, a pending row flips to status 504 (Gateway Timeout) so it doesn't stay pending forever. A cancelled request shows "Cancelled".

### Q: Can I look at just one endpoint?

Yes. Type a path keyword in the search box, or **Add Focus** on that endpoint's host and narrow further with the filter box. You can also right-click a request to create a targeted rule.

### Q: The body shows as truncated?

A single body is truncated past 20 MB. If a JSON payload is too large to render as a tree, switch to **JSON Text** or **Raw**.

### Q: Do Compose requests show up here?

Yes. Requests sent from [Compose](./compose.md) are inserted into the list as sessions, so you can inspect and compare them like any captured traffic.

### Q: How do I replay a captured request over and over?

Right-click the request → **Save to Collection** (persist it into [Collections](./collections-and-environments.md)), or **Compose** (load it into Compose to resend directly).
