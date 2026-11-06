# Browser bridge protocol (v1)

The MV3 extension connects to `ws://127.0.0.1:37891/extension`.
Only one browser connection is used at a time. Server -> extension:

```json
{"id":"uuid","method":"tabs","params":{}}
```

Extension -> server: `{"id":"uuid","result":...}` or
`{"id":"uuid","error":"human-readable error"}`. Keepalive messages
`{"type":"ping"}` / `{"type":"pong"}` have no id. Send ping every 20s.
Requests have a 30s timeout. Do not retry mutations automatically.

Commands:

* `tabs {}` -> array of `{id,windowId,title,url,active,status}`.
* `open {url}` -> tab summary; only http(s) URLs.
* `activate {tabId}` -> tab summary, activate tab and focus window.
* `close {tabId}` -> `{closed:true}`.
* `navigate {tabId,url}` -> tab summary; only http(s) URLs.
* `snapshot {tabId,maxChars?}` -> `{url,title,text,elements,truncated}`.
  maxChars defaults to 20000, max 100000. elements include at most 300 visible
  actionable elements: `{selector,tag,role,name,type,value?}`. CSS selectors
  should resolve to the same element and require no DOM mutation. Do not read
  password values. Text and elements are from the main document, not all frames.
* `find {tabId,name,role?}` -> `{elements,truncated}`. Case-insensitive substring
  of the accessible name, optional exact lowercase role, main document only.
  Returns up to 10 actionable elements in document order without field values.
* `click {tabId,selector?,x?,y?,button?,clickCount?}` -> `{clicked:true}`.
  Use selector OR viewport CSS coordinates x/y. Scroll selector into view,
  check visibility and uniqueness, use CDP Input.dispatchMouseEvent for trusted
  input. button left/right/middle default left, clickCount default 1 (or 2).
* `type {tabId,text,selector?,clear?}` -> `{typed:true}`. Focus selector if
  provided, otherwise use focused element. clear default false. Use trusted
  CDP input; if clearing use Ctrl+A / Backspace; do not echo entered values.
* `press {tabId,key,modifiers?}` -> `{pressed:true}`. key: Enter, Tab, Escape,
  Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space,
  or single character. modifiers array of Alt, Control, Meta, Shift.
* `scroll {tabId,deltaY,deltaX?,x?,y?}` -> `{scrolled:true}` using mouseWheel
  so nested scroll containers work. x/y default viewport center.
* `screenshot {tabId}` -> `{data:base64,mimeType:"image/png"}` via CDP.
* `evaluate {tabId,expression}` -> JSON-serializable result from JS expression,
  await promises, surface exceptions. Powerful advanced escape hatch.
* `cdp {tabId,method,params?}` -> raw CDP result for advanced controls / frames.
* `wait`, `read_region`, `read_table`, `read_form`, `fill_form`, `select`, `set_checked`, `inspect`
  accept an optional CDP `frameId`, as do `snapshot` and `find`. Obtain IDs with `frames {tabId}`.
* `hover`, `drag`, `history` operate on a tab. `upload_file` accepts explicit local paths
  for a unique file input. `wait_download` identifies downloads by ID or a recent filename/URL filter.
* `diff {tabId,snapshotId?}` compares bounded captures in memory. A first call creates the baseline.

MCP tools named `sheets_*` run on the local server using Google OAuth and the Sheets v4 REST API.
They do not use this WebSocket protocol. MCP discovery returns their complete schemas and input limits.

Extension serializes commands per tab to avoid overlapping input actions.
No confirmation UI or site-specific permission scenarios. Extension popup
shows connected/disconnected state and a reconnect button, endpoint is fixed.
Connection retries with short backoff and chrome.alarms recovery after worker
suspension; close an old socket before replacing it. Handle debugger detach.

MCP server maps these to `browser_*` tools (tabs -> browser_tabs, etc.).
HTTP MCP endpoint: `http://127.0.0.1:37891/mcp`. GET /health is a small status
object. Listen only on IPv4 loopback. Reject non-local browser request origins.
No stored credentials, pairing workflow or cloud service.
