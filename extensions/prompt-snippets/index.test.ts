import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import promptSnippetsExtension from "./index.ts";

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
