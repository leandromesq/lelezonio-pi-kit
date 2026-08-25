/**
 * BrowserRuntime: the single shared headless browser.
 *
 * Owns the persistent BrowserContext + Page, the console/network ring
 * buffers, the serialization queue that all page-touching tool executions
 * run through, and teardown/screenshot lifecycle.
 *
 * Concurrency: Playwright's Page is not safe to drive from concurrent
 * callers — pi fires independent tool calls in the same batch in parallel,
 * which would race two `fill`s into one field or land an `eval` inside a
 * navigation teardown. Every page operation (including teardown) is
 * submitted through `serialize()` and runs in submission order.
 *
 * Lifecycle: the context is launched lazily on first use and persists across
 * calls so cookies/localStorage survive between turns. `teardown()` closes
 * it; a later `ensurePage()` simply relaunches on the same profile dir, so
 * `/browser off` followed by `/browser on` works.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
} from "playwright-core";
import { boundConsoleText, boundPush, boundUrl } from "./buffer.ts";
import { boundHeaders } from "./headers.ts";
import type { ConsoleEntry, NetEntry } from "./types.ts";

export interface BrowserRuntimeOptions {
  /** Persistent user-data dir (cookies, localStorage, IndexedDB). */
  profileDir: string;
  /** Launch without a visible window unless the user opted into headful. */
  headless: boolean;
}

/** Default viewport for the persistent context. */
export const VIEWPORT = { width: 1280, height: 800 };

export class BrowserRuntime {
  private readonly options: BrowserRuntimeOptions;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private hasLaunched = false;
  private queue: Promise<unknown> = Promise.resolve();
  private screenshotDir: string | null = null;

  private readonly consoleBuf: ConsoleEntry[] = [];
  private readonly netBuf: NetEntry[] = [];

  constructor(options: BrowserRuntimeOptions) {
    // stored as a field rather than a parameter property: node's
    // --experimental-strip-types test runner rejects parameter properties
    this.options = options;
  }

  /* ---- observation buffers ------------------------------------------ */

  /** Copy of the console/pageerror ring buffer. */
  get consoleEntries(): readonly ConsoleEntry[] {
    return this.consoleBuf;
  }

  /** Copy of the network ring buffer. */
  get netEntries(): readonly NetEntry[] {
    return this.netBuf;
  }

  /** Wipe the console/pageerror ring buffer (drain-on-read). */
  clearConsole(): void {
    this.consoleBuf.length = 0;
  }

  /** Wipe the network ring buffer (drain-on-read). */
  clearNet(): void {
    this.netBuf.length = 0;
  }

  /** True while a live page exists. */
  get isOpen(): boolean {
    return !!(this.page && !this.page.isClosed());
  }

  /** Current page URL without launching anything (for status output). */
  get currentUrl(): string | undefined {
    return this.page && !this.page.isClosed() ? this.page.url() : undefined;
  }

  /* ---- serialization -------------------------------------------------- */

  /**
   * Run `fn` after every previously submitted operation settles, preserving
   * submission order. Failures of one op never poison the queue.
   */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /* ---- launch / page --------------------------------------------------- */

  /**
   * Return the shared live page, launching the persistent context on first
   * use (or relaunching after a teardown). All callers must go through
   * `serialize()`.
   */
  async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    if (!this.context) {
      this.context = await chromium.launchPersistentContext(
        this.options.profileDir,
        {
          headless: this.options.headless,
          viewport: VIEWPORT,
        },
      );
    }
    this.hasLaunched = true;
    const page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page = page;
    this.attachListeners(page);
    return page;
  }

  private attachListeners(page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      const loc = msg.location();
      boundPush(this.consoleBuf, {
        ts: Date.now(),
        type: msg.type(),
        text: boundConsoleText(msg.text()),
        location: loc?.url ? `${loc.url}:${loc.lineNumber}` : undefined,
      });
    });
    page.on("pageerror", (err) => {
      boundPush(this.consoleBuf, {
        ts: Date.now(),
        type: "pageerror",
        text: boundConsoleText(`${err.name}: ${err.message}`),
      });
    });
    page.on("requestfinished", async (req: Request) => {
      try {
        const res: Response | null = await req.response();
        const status = res?.status();
        boundPush(this.netBuf, {
          ts: Date.now(),
          method: req.method(),
          url: boundUrl(req.url()),
          status,
          statusText: res?.statusText(),
          resourceType: req.resourceType(),
          requestHeaders: boundHeaders(req.headers()),
          responseHeaders: res ? boundHeaders(res.headers()) : undefined,
        });
      } catch {
        // request aborted while we read the response; skip this row
      }
    });
    page.on("requestfailed", (req: Request) => {
      boundPush(this.netBuf, {
        ts: Date.now(),
        method: req.method(),
        url: boundUrl(req.url()),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText,
      });
    });
  }

  /* ---- teardown --------------------------------------------------------- */

  /**
   * Close the persistent context, drop the observation buffers, and remove
   * the per-run screenshot temp dir. Idempotent and safe to call any number
   * of times. Submit via `serialize()` when ordering against in-flight page
   * operations matters (the extension always does this).
   */
  async teardown(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // best-effort: the process may already be tearing down
    }
    this.context = null;
    this.page = null;
    this.consoleBuf.length = 0;
    this.netBuf.length = 0;
    await this.removeScreenshotDir();
  }

  /** Progress indicator for the status command. */
  get hasEverLaunched(): boolean {
    return this.hasLaunched;
  }

  /* ---- screenshots ------------------------------------------------------ */

  /**
   * Return a fresh file path inside a per-run temp dir, deleting the
   * previous screenshot so repeated captures don't accumulate.
   */
  private screenshotFilePath(): string {
    const dir =
      this.screenshotDir ??
      (this.screenshotDir = fs.mkdtempSync(join(tmpdir(), "pi-browser-")));
    return join(dir, "screenshot.png");
  }

  /** Screenshot the live page to a temp file and return its path. */
  async captureScreenshot(fullPage: boolean): Promise<string> {
    const file = this.screenshotFilePath();
    await fs.promises.rm(file, { force: true });
    const page = await this.ensurePage();
    await page.screenshot({ path: file, fullPage, type: "png" });
    return file;
  }

  private async removeScreenshotDir(): Promise<void> {
    if (!this.screenshotDir) return;
    const dir = this.screenshotDir;
    this.screenshotDir = null;
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {
      // best-effort: a temp file may still be open elsewhere
    });
  }
}
