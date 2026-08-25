/**
 * Integration test: the real BrowserRuntime against real Chromium.
 *
 * Exercises launch → navigation → eval → fill/click → console + network
 * capture → screenshot → teardown → relaunch, plus persistent-profile
 * survival across a teardown/relaunch cycle (the core Windows-relevant
 * lifecycle claims of the extension).
 *
 * Skipped by default because it requires the Chromium binary (installed via
 * `node node_modules/playwright-core/cli.js install chromium`). Run with:
 *   PI_BROWSER_TEST_LAUNCH=1 npm test
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { wrapEvalSource } from "./src/eval.ts";
import { BrowserRuntime, VIEWPORT } from "./src/runtime.ts";

const RUN = process.env.PI_BROWSER_TEST_LAUNCH === "1";

const HTML = `<!doctype html><html><head><title>browser ext test</title></head><body>
<input id="q" />
<button id="go" onclick="document.getElementById('out').textContent = 'result:' + document.getElementById('q').value">Go</button>
<p id="out"></p>
<button id="fetchApi">Fetch</button>
<script>
  console.log("page logged");
  document.getElementById('fetchApi').addEventListener('click', async () => {
    const r = await fetch('/api/data');
    document.getElementById('out').textContent = await r.text();
  });
</script>
</body></html>`;

/** Poll `probe` until truthy or the deadline passes. */
async function waitFor(
  probe: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

test(
  "drive a real headless Chromium: goto/eval/fill/click/console/network/screenshot + persistent profile",
  { skip: !RUN, timeout: 120_000 },
  async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/data")) {
        res.setHeader("x-test", "1");
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(HTML);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const profileDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-browser-test-"),
    );
    const runtime = new BrowserRuntime({ profileDir, headless: true });

    async function gotoBase(): Promise<void> {
      await runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        const response = await page.goto(baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        assert.equal(response?.status(), 200);
        assert.ok(page.url().startsWith(baseUrl));
      });
    }

    try {
      assert.equal(VIEWPORT.width, 1280); // sane default viewport

      // launch + navigate
      await gotoBase();
      assert.ok(runtime.isOpen);

      // eval: plain expression + function source
      await runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        assert.equal(await page.evaluate(wrapEvalSource("1 + 1")), 2);
        assert.equal(
          await page.evaluate(wrapEvalSource("() => document.title")),
          "browser ext test",
        );
      });

      // fill + click drive the page's own JS
      await runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        await page.fill("#q", "hello");
        await page.click("#go");
        assert.equal(
          await page.evaluate(
            wrapEvalSource("document.querySelector('#out').textContent"),
          ),
          "result:hello",
        );
      });

      // console capture (page console.log fires during the initial load)
      await waitFor(
        () =>
          runtime.consoleEntries.some((e) => e.text.includes("page logged")),
        "console entry 'page logged'",
      );

      // network capture: click the fetch button, then look for the /api/data row
      await runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        await page.click("#fetchApi");
      });
      await waitFor(
        () =>
          runtime.netEntries.some(
            (e) => e.url.includes("/api/data") && e.status === 200,
          ),
        "network row for 200 GET /api/data",
      );
      const netRow = runtime.netEntries.find((e) =>
        e.url.includes("/api/data"),
      );
      assert.equal(netRow?.method, "GET");
      // Header capture verification: response headers are surfaced as sent;
      // host/request-header key casing varies by platform, so assert on a
      // header we control (x-test) on both sides.
      assert.equal(netRow?.responseHeaders?.["x-test"], "1");

      // screenshot: writes a real PNG
      const shot = await runtime.captureScreenshot(false);
      const png = fs.readFileSync(shot);
      assert.deepEqual(
        [...png.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );

      // drain semantics
      runtime.clearConsole();
      runtime.clearNet();
      assert.equal(runtime.consoleEntries.length, 0);
      assert.equal(runtime.netEntries.length, 0);

      // persistent profile: write localStorage, tear down, relaunch, read back
      await runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        await page.evaluate(
          "localStorage.setItem('pi-browser-test', 'persisted')",
        );
      });
      await runtime.serialize(() => runtime.teardown());
      assert.equal(runtime.isOpen, false);
      assert.equal(runtime.consoleEntries.length, 0); // buffers dropped on teardown

      await gotoBase();
      await runtime.serialize(async () => {
        const page = await runtime.ensurePage();
        assert.equal(
          await page.evaluate("localStorage.getItem('pi-browser-test')"),
          "persisted",
        );
      });

      // teardown is idempotent and the runtime stays usable after it
      await runtime.serialize(() => runtime.teardown());
      await runtime.serialize(() => runtime.teardown());
      assert.equal(runtime.isOpen, false);
    } finally {
      // Race teardown against a timer: a flaky browser close (e.g. AV
      // interference) must never hang the whole suite.
      await Promise.race([
        runtime.serialize(() => runtime.teardown()),
        new Promise((r) => setTimeout(r, 30_000)),
      ]);
      fs.rmSync(profileDir, { recursive: true, force: true });
      server.close();
    }
  },
);
