import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeTerminalText,
  showChangedFiles,
} from "./src/changed-files-view.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

test("changed-files overlay honors rebound selection and close actions", async () => {
  let closed = false;
  await showChangedFiles(
    {
      mode: "tui",
      ui: {
        custom: async (factory: any) => {
          const keybindings = {
            matches: (data: string, action: string) =>
              data === `rebound:${action}`,
            getKeys: (action: string) => [`bound:${action}`],
          };
          const component = factory(
            { terminal: { rows: 30 }, requestRender() {} },
            {
              fg: (_color: string, text: string) => text,
              bg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            keybindings,
            () => {
              closed = true;
            },
          );
          component.handleInput("rebound:tui.select.down");
          let lines = component.render(100);
          assert.ok(lines.some((line: string) => line.includes("second")));
          assert.ok(lines.every((line: string) => visibleWidth(line) <= 100));
          component.handleInput("rebound:tui.select.confirm");
          component.handleInput("rebound:tui.select.cancel");
          assert.equal(closed, false, "cancel in diff returns to files");
          component.handleInput("rebound:tui.select.cancel");
          assert.equal(closed, true);
        },
      },
    } as unknown as ExtensionContext,
    [
      {
        path: "first",
        name: "first",
        additions: 1,
        deletions: 0,
        diff: ["+first"],
      },
      {
        path: "second",
        name: "second",
        additions: 1,
        deletions: 0,
        diff: ["+second"],
      },
    ],
  );
});

test("repository text cannot inject terminal control sequences", () => {
  const input =
    "before\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[31mred\u001b[0m\u0001";
  assert.equal(sanitizeTerminalText(input), "beforeafterred");
});

test("diff text keeps tabs for the renderer's own column expansion", () => {
  assert.equal(sanitizeTerminalText("a\tb"), "a\tb");
});
