import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoNamingExtension from "./index.ts";

test("registers the session hook and title model command", () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const api = {
    on: (event: string) => events.add(event),
    registerCommand: (name: string) => commands.add(name),
  } as unknown as ExtensionAPI;

  autoNamingExtension(api);

  assert.deepEqual(
    events,
    new Set(["session_start", "session_shutdown", "before_agent_start"]),
  );
  assert.deepEqual(commands, new Set(["title-model", "title-naming"]));
});
