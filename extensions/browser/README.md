# pi browser extension

Playwright-driven headless Chromium that pi can drive directly. Lets the
agent debug a live SPA the same way a human would in devtools: navigate, run
JS, inspect localStorage, watch the console and network, fill forms, click.

Modeled on the upstream [`pi-config` browser extension](https://github.com/amosblomqvist/pi-config/tree/main/extensions/browser),
updated for pi 0.84.3 extension APIs and hardened for bounded memory,
lifecycle cleanup, and Windows.

## Why it exists

When a frontend bug reduces to "what's in localStorage?" or "what
`Authorization` header did supabase-js attach?", the agent currently has to
ask the user to paste console output and curls. With this extension it can
answer those questions itself.

## Install

```bash
cd ~/.pi/agent/extensions/browser
npm install
node node_modules/playwright-core/cli.js install chromium   # one-time ~150MB
```

Then `/reload` inside pi (or restart). The new tools (`browser_goto`,
`browser_eval`, …) are registered automatically because the folder is under
`~/.pi/agent/extensions/`; they remain inactive until `/browser on`.

Works on Windows, macOS, and Linux. The one-time browser download goes to
Playwright's standard location (`%LOCALAPPDATA%\ms-playwright` on Windows).

## Default off, opt in per session

The browser tools collectively cost ~800 tokens in the system prompt
(snippets + guidelines) but are only useful in the small minority of
sessions that involve a live SPA. They're therefore registered but
**inactive** by default: invisible to the agent, not callable, no prompt
snippets or guidelines emitted.

Flip them on when you need them:

```
/browser on        # enable
/browser           # status
/browser off       # disable and close the headless browser
```

The enable bit persists for the current session via a custom session entry,
so `/reload` and pi restart keep it on. `/new` resets to off. Disabling also
tears down the Chromium context (`browser_close` semantics) so no background
browser is left running.

## Tools

(Only callable while `/browser on`.)

| Tool                 | Purpose                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_goto`       | Navigate to a URL. Returns `{ status, finalUrl }`.                                                                                              |
| `browser_eval`       | Run JS in the page. Expression, function source, or already-called IIFE — all three work. Return value must be JSON-serializable.               |
| `browser_console`    | Drain buffered console + pageerror entries (filterable).                                                                                        |
| `browser_network`    | Drain buffered network requests. Terse (`status method url`) by default; `verbose: true` and/or `includeHeaders: [...]` inline curated headers. |
| `browser_fill`       | Type a value into an input matched by selector.                                                                                                 |
| `browser_click`      | Click an element (CSS, `text=...`, `role=...`).                                                                                                 |
| `browser_screenshot` | Save a PNG to a temp file and return its path; pi can `read` it to view.                                                                        |
| `browser_close`      | Close the persistent context.                                                                                                                   |

All page-touching tools serialize through a single internal queue, so it's
safe to fire several `browser_*` calls in one batch — they run in submission
order against the shared Page instead of racing each other (a naive `goto`

- `eval` batch would hit "Execution context was destroyed" mid-navigation).

The `/browser` command controls the gate (`on` / `off` / bare for status;
`enable`, `disable`, `close`, `kill` are aliases).

## State

- Browser state (cookies, localStorage, IndexedDB) persists to
  `~/.pi/agent/extensions/browser/.profile` via
  `chromium.launchPersistentContext`. Login sessions survive across pi turns
  and pi restarts. The directory is git-ignored (contains credentials).
- Console + network events are captured into in-memory ring buffers (max
  1000 entries each). `browser_console` and `browser_network` drain them by
  default (clear-on-read — subsequent calls observe a fresh activity window).
- The persistent context is closed in `session_shutdown`, so `/new` or pi
  exit cleans up; screenshots live in a per-run temp dir that is removed on
  shutdown too. The user-data dir on disk is left in place.

## Bounded memory

Every capture path is capped so a noisy page can't grow the extension's
memory without limit:

- ring buffers: 1000 entries max (oldest evicted)
- console/pageerror text: 2000 chars per entry
- URLs: 1024 chars per entry
- captured header maps: 64 fields per request, 512 chars per value
- `browser_eval` output text: 50,000 chars (truncation marker appended)

## Knobs

| Env var              | Default                                   | Effect                                                                                |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `PI_BROWSER_HEADFUL` | unset                                     | If set, launch a visible Chromium window. Useful when debugging the extension itself. |
| `PI_BROWSER_PROFILE` | `~/.pi/agent/extensions/browser/.profile` | Override the persistent user-data dir. Set to a tempdir for ephemeral sessions.       |

## Network output: terse by default, headers on opt-in

`browser_network` keeps the default text payload minimal — one line per
request, `status method url` — because a single SPA page load fires 30–100
subresource requests and inlining headers on all of them would drown the
agent's context window in noise.

When you want headers (the auth-debugging use case), opt in:

- `verbose: true` — inline a curated set of request/response headers on each
  returned row. The curated set is small on purpose:

  ```
  authorization, apikey, content-type, x-client-info, accept-profile,
  content-profile, prefer, location, www-authenticate, retry-after
  ```

- `includeHeaders: ["cookie", "cache-control", ...]` — extend the curated
  set for this call only (case-insensitive). Implies `verbose: true`.

All headers are captured into the in-memory ring buffer regardless;
`verbose` / `includeHeaders` control both the rendered text and which
allow-listed headers are persisted in Pi's session file. Without header
opt-in, session details contain only request metadata. Best paired with
`urlFilter` / `status` so sensitive headers only appear on the rows you care
about.

## Differences from upstream

- **pi 0.84.3 API conformance**: `AgentToolResult` no longer has `isError`;
  errors are reported by throwing (pi wraps them into flagged results).
- **eval hardening**: the wrapper puts the source on its own lines so a
  trailing `// comment` can't break the page; circular/BigInt results
  stringify instead of throwing; output is capped.
- **bounded capture** (see above): upstream stored unbounded header maps and
  leaked one temp dir per screenshot.
- **lifecycle**: `teardown()` runs through the serialization queue (no race
  with in-flight ops), buffers reset on close, screenshot temp dir is
  removed on shutdown.
- **testable structure**: pure logic lives in `src/` (buffer, eval, headers,
  format, gate) with unit tests; a real-browser integration test is opt-in
  via `PI_BROWSER_TEST_LAUNCH=1`.

## Development

```bash
npm run check   # tsc --noEmit (repo-root tsconfig, strict)
npm test        # unit tests (no browser needed)
PI_BROWSER_TEST_LAUNCH=1 npm test   # + real-Chromium integration test
```

The integration test starts a local HTTP server, drives a real headless
Chromium through launch → goto → eval → fill/click → console/network capture
→ screenshot → teardown → relaunch, and verifies the persistent profile
survives a close/relaunch cycle.

## Caveats and known limits

- `playwright-core` ships without browser binaries; the one-time install
  step above is required per machine.
- The page object is a singleton — no tab/window management.
- `browser_eval` evaluates the source once and, if the result is a function,
  calls it. So expressions (`localStorage.length`), function values
  (`() => doStuff()`), and already-called IIFEs (`(() => 42)()`) all do what
  you'd expect. Note: top-level `return` and multi-statement bodies aren't
  valid expressions — wrap them in `(() => { ... })()`.
- For DOM nodes, return primitive properties (`.outerHTML`, `.textContent`,
  `.value`) rather than the node itself; Playwright serializes nodes as the
  opaque sentinel `"ref: <Node>"`.
- `browser_eval` returns `undefined` as the text `undefined` after
  serialization. Wrap expressions that intentionally return nothing in a
  function returning a sentinel if you care.
- `browser_click`: CSS attribute selectors match HTML attributes, not DOM
  properties. `button[type=submit]` will NOT match `<button>Submit</button>`
  even though that button's `.type === "submit"` by default. Prefer
  `text=Submit` or `role=button[name=Submit]`.
- `browser_network` shows `ERR net::ERR_ABORTED` for fetches whose body was
  never consumed (e.g. `await fetch(url)` without `.text()` / `.json()`).
  Chromium cancels the body stream and Playwright reports `requestfailed`
  even though the JS side saw a successful response. Consume the body for a
  clean status row.
- AV/security software (e.g. ESET) can interfere with headless Chromium's
  networking or make browser shutdown take several seconds; if pages hang at
  `browser_goto`, add the Chromium binary under Playwright's browser directory
  to the AV's allowlist.
- No download / file-upload helpers yet.
- OTP / 2FA: the extension has no mail integration. A human still has to
  paste the code into `browser_fill`.
