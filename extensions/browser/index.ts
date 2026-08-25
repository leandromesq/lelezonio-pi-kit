/**
 * Browser extension — Playwright-driven headless Chromium pi can drive.
 *
 * Exposes a small set of tools the LLM can call to debug a live web app
 * instead of asking the user to copy-paste from devtools:
 *
 *   - browser_goto        navigate
 *   - browser_eval        run JS in the page (read localStorage, decode a
 *                         JWT, inspect the DOM, fire a fetch, ...)
 *   - browser_console     drain buffered console + pageerror entries
 *   - browser_network     drain buffered network requests (status, headers)
 *   - browser_fill        type into an input
 *   - browser_click       click an element (CSS, text=..., role=...)
 *   - browser_screenshot  write a PNG to a temp file and return the path
 *   - browser_close       close the persistent browser
 *
 * Default off, opt in per session: the tools are registered but inactive
 * until `/browser on` (see src/gate.ts). The enable bit persists per session
 * through a custom session entry; `/browser off` disables and closes the
 * browser. Browser state itself (cookies, localStorage) persists to a
 * Chromium user-data dir, so login sessions survive across turns and pi
 * restarts.
 *
 * Setup:
 *   cd ~/.pi/agent/extensions/browser
 *   npm install
 *   node node_modules/playwright-core/cli.js install chromium   # one-time
 *   # then /reload in pi (or restart)
 *
 * Knobs:
 *   PI_BROWSER_HEADFUL=1  launch a visible window (debugging the extension)
 *   PI_BROWSER_PROFILE    override user-data dir (default:
 *                         ~/.pi/agent/extensions/browser/.profile)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { drainLast } from "./src/buffer.ts";
import { stringifyEvalResult, wrapEvalSource } from "./src/eval.ts";
import { renderConsoleText, renderNetworkText } from "./src/format.ts";
import {
  applyGate,
  computeEnabledFromEntries,
  ENABLED_ENTRY_TYPE,
  parseBrowserCommand,
} from "./src/gate.ts";
import { allowListFor, filterHeaders } from "./src/headers.ts";
import { BrowserRuntime } from "./src/runtime.ts";

/* ---- parameter schemas (exported for typed event listeners) ---------- */

const gotoParams = Type.Object({
  url: Type.String({ description: "URL to navigate to" }),
  waitUntil: Type.Optional(
    Type.Union([
      Type.Literal("load"),
      Type.Literal("domcontentloaded"),
      Type.Literal("networkidle"),
      Type.Literal("commit"),
    ]),
  ),
  timeoutMs: Type.Optional(Type.Number()),
});
const evalParams = Type.Object({
  expression: Type.String({
    description:
      "Expression, function source, or already-called IIFE. Function values are called once.",
  }),
});
const consoleParams = Type.Object({
  limit: Type.Optional(
    Type.Number({ description: "Max entries (default 100)" }),
  ),
  filter: Type.Optional(
    Type.String({
      description: "Only entries whose text/location contains this substring",
    }),
  ),
  clear: Type.Optional(
    Type.Boolean({
      description:
        "Clear the ENTIRE buffer after read (not just returned entries). Default true.",
    }),
  ),
});
const networkParams = Type.Object({
  limit: Type.Optional(Type.Number()),
  urlFilter: Type.Optional(
    Type.String({ description: "Substring filter on URL" }),
  ),
  status: Type.Optional(Type.Number({ description: "Exact HTTP status" })),
  verbose: Type.Optional(
    Type.Boolean({
      description:
        "Inline a curated set of request/response headers on each row. Off by default to keep context small.",
    }),
  ),
  includeHeaders: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Extra header names (case-insensitive) to surface alongside the curated default set. Implies verbose=true.",
    }),
  ),
  clear: Type.Optional(
    Type.Boolean({
      description:
        "Clear the ENTIRE buffer after read (not just returned entries). Default true.",
    }),
  ),
});
const fillParams = Type.Object({
  selector: Type.String(),
  value: Type.String(),
});
const clickParams = Type.Object({
  selector: Type.String(),
});
const screenshotParams = Type.Object({
  fullPage: Type.Optional(Type.Boolean()),
});
const closeParams = Type.Object({});

export type BrowserGotoInput = Static<typeof gotoParams>;
export type BrowserEvalInput = Static<typeof evalParams>;
export type BrowserConsoleInput = Static<typeof consoleParams>;
export type BrowserNetworkInput = Static<typeof networkParams>;
export type BrowserFillInput = Static<typeof fillParams>;
export type BrowserClickInput = Static<typeof clickParams>;
export type BrowserScreenshotInput = Static<typeof screenshotParams>;
export type BrowserCloseInput = Static<typeof closeParams>;

export default function browserExtension(pi: ExtensionAPI) {
  const profileDir =
    process.env.PI_BROWSER_PROFILE ??
    join(homedir(), ".pi", "agent", "extensions", "browser", ".profile");
  const headless = !process.env.PI_BROWSER_HEADFUL;
  const runtime = new BrowserRuntime({ profileDir, headless });

  // Default-off gate. The browser tools are registered so they show up in
  // `pi.getAllTools()` and command discovery stays normal, but they are
  // stripped from the ACTIVE set so their promptSnippet / promptGuidelines
  // drop out of the system prompt and they are not callable. `/browser on`
  // flips them back.
  //
  // We cannot call setActiveTools during the factory — the extension runtime
  // is not bound yet and pi rejects action methods during extension loading.
  // session_start is the first safe point; it also restores the persisted
  // per-session bit from custom entries.
  let enabled = false;

  function setEnabled(on: boolean): void {
    pi.setActiveTools(applyGate(pi.getActiveTools(), on));
    enabled = on;
  }

  pi.on("session_start", async (_event, ctx) => {
    const want = computeEnabledFromEntries(ctx.sessionManager.getEntries());
    setEnabled(want);
  });

  pi.on("session_shutdown", async () => {
    await runtime.serialize(() => runtime.teardown());
  });

  /* ---- tools ------------------------------------------------------------ */

  pi.registerTool({
    name: "browser_goto",
    label: "Browser Goto",
    description:
      "Navigate the persistent headless Chromium to a URL. Returns final URL and HTTP status. Cookies + localStorage persist across calls.",
    promptSnippet:
      "Open a URL in a persistent headless browser to inspect a live web app's DOM, storage, network, and console — instead of asking the user to copy from devtools",
    promptGuidelines: [
      "When debugging a frontend issue (broken auth, failed requests, missing tokens, JS errors, form not working, blank screen), prefer driving the live app with browser_goto + browser_eval + browser_console + browser_network instead of asking the user to copy-paste from devtools.",
      "When the user reports 'works in browser, fails here' or 'I tried X and it didn't work', use browser_goto to reproduce the exact flow yourself before forming a hypothesis from source alone.",
      "After making a frontend change, use browser_goto plus browser_click / browser_fill to actually exercise the fix end-to-end before declaring it done — don't rely on the user to verify.",
    ],
    parameters: gotoParams,
    async execute(_id, params) {
      return runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        const response = await page.goto(params.url, {
          waitUntil: params.waitUntil ?? "domcontentloaded",
          timeout: params.timeoutMs ?? 30_000,
        });
        const status = response?.status();
        return {
          content: [{ type: "text", text: `${status ?? "?"} ${page.url()}` }],
          details: { status, finalUrl: page.url() },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_eval",
    label: "Browser Eval",
    description:
      "Evaluate JS in the current page. Pass an expression ('localStorage.length'), a function ('() => Object.keys(localStorage)', 'async () => { ... }'), or an already-called IIFE — all three forms work. Return value must be JSON-serializable; for DOM nodes return primitive properties (.outerHTML, .textContent, .value) rather than the node itself.",
    promptSnippet:
      "Run JS in the live page to read localStorage / cookies, decode a JWT, inspect form or component state, or fire a fetch with custom headers",
    promptGuidelines: [
      "Use browser_eval to inspect runtime state (localStorage, cookies, in-page variables, JWT contents, computed styles) instead of guessing from source.",
    ],
    parameters: evalParams,
    async execute(_id, params) {
      return runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        try {
          const result = await page.evaluate(wrapEvalSource(params.expression));
          const text = stringifyEvalResult(result);
          // Persist only the bounded representation. Raw eval values may be
          // huge or contain sensitive page state, and tool details are saved
          // into Pi session files.
          return {
            content: [{ type: "text", text }],
            details: { result: text },
          };
        } catch (e) {
          // Throwing routes the message into the tool result with the error
          // flag set (pi wraps thrown errors into the result content).
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`eval error: ${msg}`);
        }
      });
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser Console",
    description:
      "Drain buffered console + pageerror entries (oldest first). With clear=true (default) the ENTIRE buffer is wiped after read, not just the entries returned — this is intentional, so subsequent calls observe a fresh window of activity rather than re-walking the same noise. Pass clear=false to peek without draining.",
    promptSnippet:
      "Read JS errors and console output captured since last drain — reach for this whenever a page seems broken without an obvious network cause",
    parameters: consoleParams,
    async execute(_id, params) {
      return runtime.serialize(async () => {
        const limit = params.limit ?? 100;
        const filter = params.filter;
        const entries = filter
          ? runtime.consoleEntries.filter(
              (e) =>
                e.text.includes(filter) || (e.location ?? "").includes(filter),
            )
          : [...runtime.consoleEntries];
        const out = drainLast(entries, limit);
        if (params.clear ?? true) runtime.clearConsole();
        return {
          content: [{ type: "text", text: renderConsoleText(out) }],
          details: { entries: out },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_network",
    label: "Browser Network",
    promptSnippet:
      "Inspect the actual HTTP requests the page made — status, method, URL, and (with verbose=true) Authorization / apikey / content-type headers. Use for 401 / 403 / CORS debugging",
    promptGuidelines: [
      "Use browser_network with verbose=true (and urlFilter to narrow scope) for any auth or CORS issue — it reveals the exact Authorization / apikey / Origin / content-type headers the browser actually sent, which is otherwise invisible from source.",
    ],
    description:
      "Drain buffered network requests. Default text output is one terse line per request ('<status> <method> <url>') to keep context small.\n\nOpt-in for headers: set verbose=true to inline a curated set of request/response headers on each returned row (authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, location, www-authenticate, retry-after). Pass includeHeaders=['cookie','cache-control',...] for more, for this call only (case-insensitive). Best paired with urlFilter / status so headers only appear on rows you care about.\n\nClear semantics: with clear=true (default) the ENTIRE buffer is wiped after read, not just the returned entries — intentional, so subsequent calls observe a fresh window rather than re-walking the same subresource noise. Pass clear=false to peek.\n\nCaveat: fetches whose body is never consumed (e.g. `await fetch(url)` without `.text()` / `.json()`) often appear as 'ERR ... net::ERR_ABORTED' even though the JS side saw success — Chromium cancels the body stream and Playwright reports requestfailed.",
    parameters: networkParams,
    async execute(_id, params) {
      return runtime.serialize(async () => {
        let entries = [...runtime.netEntries];
        if (params.urlFilter) {
          const needle = params.urlFilter;
          entries = entries.filter((e) => e.url.includes(needle));
        }
        if (params.status != null) {
          const wanted = params.status;
          entries = entries.filter((e) => e.status === wanted);
        }
        const out = drainLast(entries, params.limit ?? 100);
        if (params.clear ?? true) runtime.clearNet();

        const allow = allowListFor(params.includeHeaders);
        const showHeaders =
          params.verbose === true || (params.includeHeaders?.length ?? 0) > 0;
        // Tool details are persisted in session files. Store no headers by
        // default and only the explicitly surfaced allow-list when requested.
        const persistedEntries = out.map((entry) => ({
          ts: entry.ts,
          method: entry.method,
          url: entry.url,
          status: entry.status,
          statusText: entry.statusText,
          resourceType: entry.resourceType,
          failure: entry.failure,
          ...(showHeaders
            ? {
                requestHeaders: filterHeaders(
                  entry.requestHeaders ?? {},
                  allow,
                ),
                responseHeaders: filterHeaders(
                  entry.responseHeaders ?? {},
                  allow,
                ),
              }
            : {}),
        }));
        return {
          content: [
            {
              type: "text",
              text: renderNetworkText(out, { showHeaders, allow }),
            },
          ],
          details: { entries: persistedEntries },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description:
      "Type a value into the input matching the selector (dispatches proper input/change events, unlike a raw .value= assignment). Selector may be CSS, text=..., role=..., etc.",
    promptSnippet:
      "Type into an input on the live page — drives forms the way a user would",
    parameters: fillParams,
    async execute(_id, params) {
      return runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        await page.fill(params.selector, params.value);
        return {
          content: [{ type: "text", text: `filled ${params.selector}` }],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click the element matching the selector. CSS selectors and Playwright text= / role= selectors supported. Note: CSS attribute selectors match HTML attributes, not DOM properties — e.g. `button[type=submit]` will NOT match `<button>Submit</button>` even though that button's DOM `.type === 'submit'`. For semantic matching prefer `text=Submit` or `role=button[name=Submit]`.",
    promptSnippet:
      "Click an element on the live page — drives the app the way a user would, including form submits and SPA navigations",
    parameters: clickParams,
    async execute(_id, params) {
      return runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        await page.click(params.selector);
        return {
          content: [{ type: "text", text: `clicked ${params.selector}` }],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Save a PNG screenshot to a temp file and return its path. Use the read tool on that path to view it (separate step, so vision-token cost is paid only when you choose). The temp file is removed on session shutdown.",
    promptSnippet:
      "Capture a PNG of the current page when DOM / state inspection isn't enough and you need to see the visual",
    parameters: screenshotParams,
    async execute(_id, params) {
      return runtime.serialize(async () => {
        const file = await runtime.captureScreenshot(params.fullPage ?? false);
        return {
          content: [{ type: "text", text: file }],
          details: { path: file },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description:
      "Close the persistent browser context. Next browser_* call relaunches. Also done automatically on session shutdown.",
    promptSnippet:
      "Tear down the headless browser (rarely needed; auto-cleans on session end)",
    parameters: closeParams,
    async execute() {
      return runtime.serialize(async () => {
        await runtime.teardown();
        return {
          content: [{ type: "text", text: "browser closed" }],
          details: {},
        };
      });
    },
  });

  /* ---- /browser command -------------------------------------------------- */

  pi.registerCommand("browser", {
    description:
      "Browser tools: '/browser on' to enable, '/browser off' to disable + close the browser, bare '/browser' for status",
    handler: async (args, ctx) => {
      const cmd = parseBrowserCommand(args);
      if (cmd === "on") {
        if (enabled) {
          ctx.ui.notify("browser tools already enabled", "info");
          return;
        }
        setEnabled(true);
        pi.appendEntry(ENABLED_ENTRY_TYPE, { on: true });
        ctx.ui.notify("browser tools enabled", "info");
        return;
      }
      if (cmd === "off") {
        const wasOpen = runtime.isOpen;
        setEnabled(false);
        await runtime.serialize(() => runtime.teardown());
        pi.appendEntry(ENABLED_ENTRY_TYPE, { on: false });
        ctx.ui.notify(
          wasOpen
            ? "browser tools disabled, browser closed"
            : "browser tools disabled",
          "info",
        );
        return;
      }
      // Bare /browser — status.
      const toolState = enabled ? "enabled" : "disabled (run /browser on)";
      const pageState = runtime.isOpen ? `, open at ${runtime.currentUrl}` : "";
      ctx.ui.notify(`browser tools: ${toolState}${pageState}`, "info");
    },
  });
}
