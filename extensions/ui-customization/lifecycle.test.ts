import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import uiCustomization from "./index.ts";

test("preserves the native header while installing and restoring the dashboard", () => {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => void
  >();
  const calls: string[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      handlers.set(name, handler);
    },
    events: { on: () => () => {}, emit() {} },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/work/project",
    mode: "tui",
    ui: {
      setHeader() {
        calls.push("header");
      },
      setFooter(value: unknown) {
        calls.push(value ? "footer" : "restore-footer");
      },
      setEditorComponent(value: unknown) {
        calls.push(value ? "editor" : "restore-editor");
      },
      setTitle() {
        calls.push("title");
      },
    },
  } as unknown as ExtensionContext;
  uiCustomization(pi);
  handlers.get("session_start")!({}, ctx);
  handlers.get("session_shutdown")!({}, ctx);
  assert.deepEqual(calls, [
    "footer",
    "editor",
    "title",
    "restore-editor",
    "restore-footer",
  ]);
});
