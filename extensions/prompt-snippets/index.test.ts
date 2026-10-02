import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import promptSnippetsExtension, { buildSnippetWidgetLine } from "./index.ts";

test("registers the snippets command, alt+s shortcut, and lifecycle hooks", () => {
  const events = new Set<string>();
  const shortcuts = new Set<string>();
  const commands = new Set<string>();
  const api = {
    on: (event: string) => events.add(event),
    registerShortcut: (name: string) => shortcuts.add(name),
    registerCommand: (name: string) => commands.add(name),
  } as unknown as ExtensionAPI;

  promptSnippetsExtension(api);

  assert.deepEqual(events, new Set(["session_start", "input"]));
  assert.deepEqual(shortcuts, new Set(["alt+s"]));
  assert.deepEqual(commands, new Set(["snippets"]));
});

test("widget line keeps both groups on one line when it fits", () => {
  assert.equal(
    buildSnippetWidgetLine(["concise", "tests"], ["commit"], 80),
    "↑ concise · tests  ↓ commit",
  );
  assert.equal(buildSnippetWidgetLine(["only"], [], 80), "↑ only");
  assert.equal(buildSnippetWidgetLine([], ["only"], 80), "↓ only");
  assert.equal(buildSnippetWidgetLine([], [], 80), "");
});

test("widget line stays within the width and reports hidden snippets as +N", () => {
  const prepends = ["alpha", "beta", "gamma"];
  const appends = ["delta", "epsilon"];

  for (const width of [8, 12, 20, 30]) {
    const line = buildSnippetWidgetLine(prepends, appends, width);
    assert.ok(
      visibleWidth(line) <= width,
      `line ${JSON.stringify(line)} exceeds width ${width}`,
    );
    assert.doesNotMatch(line, /\n/);
  }

  const narrow = buildSnippetWidgetLine(prepends, appends, 14);
  assert.match(narrow, /\+\d+$/);
});
