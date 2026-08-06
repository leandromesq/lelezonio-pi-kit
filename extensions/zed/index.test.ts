import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import zedExtension from "./index.ts";

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

test("opens the command context directory in Zed", async () => {
  let handler: CommandHandler | undefined;
  const executions: {
    command: string;
    args: string[];
    cwd?: string;
  }[] = [];
  const notifications: string[] = [];

  const api = {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      executions.push({ command, args, cwd: options?.cwd });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      assert.equal(name, "zed");
      handler = options.handler;
    },
  } as unknown as ExtensionAPI;

  zedExtension(api);
  assert.ok(handler);

  await handler("", {
    cwd: "/projects/example",
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext);

  assert.deepEqual(executions, [
    {
      command: "zed",
      args: ["/projects/example"],
      cwd: "/projects/example",
    },
  ]);
  assert.deepEqual(notifications, ["Opened /projects/example in Zed"]);
});
