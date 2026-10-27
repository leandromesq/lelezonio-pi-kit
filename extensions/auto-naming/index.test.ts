import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import autoNamingExtension, { hasUserMessage } from "./index.ts";

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

test("custom-message runs do not attempt automatic naming", () => {
  let beforeStart: ((event: unknown, ctx: unknown) => void) | undefined;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      if (event === "before_agent_start") beforeStart = handler;
    },
    registerCommand: () => {},
    getSessionName: () => {
      throw new Error("custom messages must not enter the naming flow");
    },
  } as unknown as ExtensionAPI;
  autoNamingExtension(api);
  assert.ok(beforeStart);
  beforeStart(
    {
      type: "before_agent_start",
      messageType: "custom",
      message: {
        customType: "background-result",
        content: "Done",
        display: true,
      },
    },
    { mode: "tui" },
  );
});

const userMessage = { type: "message", message: { role: "user" } } as const;
const assistantMessage = {
  type: "message",
  message: { role: "assistant" },
} as const;

function ctxFor(options: {
  branch: readonly unknown[];
  allEntries: readonly unknown[];
}) {
  return {
    sessionManager: {
      getBranch: () => options.branch,
      getEntries: () => options.allEntries,
    },
  } as unknown as ExtensionContext;
}

test("hasUserMessage reads the active branch, not every persisted entry", () => {
  assert.equal(
    hasUserMessage(
      ctxFor({ branch: [userMessage], allEntries: [userMessage] }),
    ),
    true,
  );
  assert.equal(
    hasUserMessage(
      ctxFor({ branch: [assistantMessage], allEntries: [userMessage] }),
    ),
    false,
    "a user message on an abandoned branch must not suppress naming",
  );
  assert.equal(
    hasUserMessage(ctxFor({ branch: [], allEntries: [userMessage] })),
    false,
  );
});

test("hasUserMessage never falls back to getEntries", () => {
  const ctx = {
    sessionManager: {
      getBranch: () => [],
      getEntries: () => {
        throw new Error("hasUserMessage must use getBranch");
      },
    },
  } as unknown as ExtensionContext;

  assert.equal(hasUserMessage(ctx), false);
});
