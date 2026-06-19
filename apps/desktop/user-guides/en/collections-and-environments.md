# API Collections & Environments Guide

Collections let you save, group, and reuse common HTTP requests without retyping them. Combined with environment variables, you can switch between Dev / Staging / Prod without changing the requests themselves.

Comparable to Postman's Collection feature, AIProxy's unique advantage is that you can **save requests to a collection directly from captured traffic**.

## Typical uses

- **API debugging**: save a project's common APIs as a collection and debug them repeatedly
- **Multi-environment switching**: switch the same set of requests between dev / test / prod in one click
- **Team collaboration**: export a collection config to share with teammates
- **Reuse from captures**: save captured requests straight into a collection, skipping manual construction

## Where to find it

1. Open AIProxy
2. Click **Collections** in the left nav

## Page layout

The Collections page uses a three-pane layout:

- **Left pane**: collection / folder tree + an environment selector at the bottom
- **Middle pane**: the request list within the selected collection
- **Right pane**: request editor (URL, Headers, Body) + response preview

## Create collections & folders

### Create a top-level collection

1. Click the **New Folder** icon at the top of the left pane
2. Enter a collection name, e.g. `User API`
3. Click **Add**

### Create a subfolder

1. Hover over a collection / folder
2. Click the **+** icon that appears on the right
3. Enter the folder name
4. Click **Add**

Folders support unlimited nesting for organizing large API sets.

## Rearrange the tree by drag & drop

Both folders and request items support dragging to reorganize.

### How

1. In the left tree, press and hold a folder or item and move it slightly (>4 px) to start dragging
2. While dragging, other rows show blue hints:
   - A thin blue line at a row's top/bottom edge → drop to **insert at that position** (same level, before/after)
   - A full blue highlight on the row → drop **into that folder** (as its child)
3. Drag an item to the middle of a folder → move it into that folder
4. Drag a folder to the middle of another → become its child; drag to its top/bottom edge → become a sibling

If you hover over the middle of a collapsed folder for more than half a second, the folder auto-expands so you can reach nested levels.

### Limits

- **You cannot move a folder into its own descendant** (no cycles); no drop indicator appears in that case
- **Request items can't be siblings of folders** (items live inside folders); dragging to a folder's top/bottom edge shows no indicator
- When the tree is empty, the first root folder is still created via the **+** button at the top-left

### Failure feedback

If the server rejects the move (e.g. a system error or concurrency conflict), the UI rolls back to the pre-drag state and shows a toast.

## Save requests to a collection

### Create a request on the Collections page

1. Click the **+** icon at the top of the middle pane
2. The right pane clears the editor into new-request mode
3. Fill in Method, URL, Headers, Body
4. Enter a request name at the top (e.g. `GET User detail`)
5. Click **Save as New**

### Save from captured traffic (highlight feature)

1. Open the **Sessions** page
2. Find the request to save
3. Right-click it → **Save to Collection**
4. Pick the target collection in the dialog
5. Optionally rename the request and confirm

The system auto-detects the method, URL, headers, and body, and infers a suitable body type (JSON / FormData / URL-encoded).

## Edit and send requests in a collection

1. Click a collection in the left pane; the middle pane lists its requests
2. Click a request to load its detail in the right pane
3. Edit URL, Headers, or Body
4. Click **Send**
5. The response appears in the lower half of the right pane

### Update a saved request

After editing, click **Update** to overwrite the original. To keep the original and save a copy, click **Save as New**.

## Environment variables

Environment variables let you avoid editing URL, token, and other values one by one when switching environments (dev / test / prod).

### Variable syntax

Wrap the variable name in double braces inside URL, Headers, or Body:

```
https://{{baseUrl}}/api/users
Authorization: Bearer {{token}}
```

### Create an environment

1. At the bottom of the Collections left pane, click the **gear** icon next to the environment selector
2. In the environment-management dialog, click **New Environment**
3. Enter a name, e.g. `Development`

### Add variables

1. Click the environment to edit on the left of the dialog
2. A variable-editing table appears on the right
3. Click **Add Variable** to add a row
4. Fill in Key and Value
5. After editing, the system auto-saves after 500 ms

| Column | Description |
|---|---|
| Enabled toggle | Whether the variable is active |
| Key | The variable name; referenced in requests as `{{key}}` |
| Value | The variable value; replaces `{{key}}` when sending |
| Delete | Delete the variable |

### Switch environments

1. In the environment selector at the bottom of the Collections left pane
2. Pick the environment to use
3. When sending a request, that environment's variable values are used

Choosing **No Environment** means no environment variables are used (global variables still apply).

### Global variables

Global variables are bound to no environment and apply under all environments.

Use cases:

- Cross-environment values (e.g. `apiVersion = v1`)
- A fallback for environment variables

**Precedence**: environment variables > global variables. If both define the same name, the environment value wins.

### Disable a variable

Toggle the switch on the left of a variable row to disable it. When disabled:

- It no longer participates in substitution
- The corresponding `{{key}}` in requests is left as-is

## Variable substitution scope

Substitution applies to:

- URL: `https://{{baseUrl}}/api/users`
- Header values: `Authorization: Bearer {{token}}`
- Header names: supported (rarely used)
- Raw Body: `{ "userId": "{{userId}}" }`
- FormData field names and values
- URL-encoded field names and values

Unmatched variables (e.g. `{{missing}}` not defined in the environment) are left as-is, with no error.

## Environment-selection persistence

The currently selected environment is saved automatically and restored on the next launch.

## FAQ

### Q: Why wasn't a variable replaced after sending?

Check:

1. Whether the environment selector has the right environment
2. Whether the variable is **enabled** (the left toggle is on)
3. Whether the variable Key exactly matches the `{{key}}` in the request (case-sensitive)
4. For a global variable, confirm it exists and is enabled under "Global Variables"

### Q: When an environment and a global share a name, which wins?

The environment variable wins. If the current environment defines `baseUrl`, that value is used even if a global `baseUrl` exists.

### Q: Can I disable an environment but keep globals?

Yes. Switch the selector to **No Environment**; only global variables apply then.

### Q: Does deleting an environment delete its variables?

Yes. Deleting an environment cascades to delete all its variables; this is irreversible.

### Q: What value types are supported?

All variable values are strings. Numbers, booleans, etc. are stored as strings (e.g. `"true"`, `"123"`) and substituted as strings at send time.

### Q: Are FormData and URL-encoded variables substituted?

Yes. You can use `{{variable}}` syntax in both field names and values of FormData and URL-encoded bodies.

### Q: Can I send a request saved from a capture directly?

Yes. A request saved from Sessions via right-click can be sent directly from the Collections page; the active environment's variables are substituted automatically.
