import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildFallbackRecap,
  createRunBoundary,
  getRunEntries,
  isRunInterrupted,
  serializeRunTranscript,
  TRANSCRIPT_MAX_BYTES,
} from "./src/transcript.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(
  id: string,
  message: Extract<SessionEntry, { type: "message" }>["message"],
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message,
  };
}

test("run boundaries replace stale starts and settle exactly once", () => {
  const boundary = createRunBoundary();
  boundary.begin("before-run");
  boundary.begin("new-top-level-run");

  assert.deepEqual(boundary.settle(), {
    baselineLeafId: "new-top-level-run",
  });
  assert.equal(boundary.settle(), undefined);
});

test("run slicing starts after the before_agent_start leaf", () => {
  const entries = [
    entry("old", { role: "user", content: "old", timestamp: 0 }),
    entry("new", { role: "user", content: "new", timestamp: 1 }),
  ];
  assert.deepEqual(
    getRunEntries(entries, "old").map((item) => item.id),
    ["new"],
  );
  assert.deepEqual(getRunEntries(entries, "missing"), []);
});

test("transcript omits thinking, images, and recap entries while redacting tool data", () => {
  const entries: SessionEntry[] = [
    entry("user", {
      role: "user",
      content: [
        { type: "text", text: "Update the client" },
        { type: "image", data: "base64-image-bytes", mimeType: "image/png" },
      ],
      timestamp: 0,
    }),
    entry("assistant", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: {
            command:
              "curl -H 'Authorization: Bearer very-secret-token' https://example.test",
            apiKey: "sk-super-secret-value",
            payload: "x".repeat(10_000),
          },
        },
        { type: "text", text: "Updated the client." },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    }),
    entry("result", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "token=another-secret\nfinished" }],
      isError: false,
      timestamp: 2,
    }),
    {
      type: "custom",
      id: "old-recap",
      parentId: "result",
      timestamp: new Date(0).toISOString(),
      customType: "summary-recap",
      data: { recap: "old recap" },
    },
  ];

  const transcript = serializeRunTranscript(entries);
  assert.match(transcript, /Update the client/);
  assert.match(transcript, /TOOL CALL bash/);
  assert.match(transcript, /Updated the client/);
  assert.doesNotMatch(transcript, /hidden chain of thought/);
  assert.doesNotMatch(transcript, /base64-image-bytes/);
  assert.doesNotMatch(transcript, /very-secret-token/);
  assert.doesNotMatch(transcript, /another-secret/);
  assert.doesNotMatch(transcript, /old recap/);
  assert.match(transcript, /\[REDACTED\]/);
  assert.match(transcript, /tool arguments capped/);
});

test("fallback recap is written in Brazilian Portuguese", () => {
  const recap = buildFallbackRecap([
    entry("assistant", {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
        { type: "text", text: "Done." },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "toolUse",
      timestamp: 0,
    }),
  ]);
  assert.match(recap.recap, /^A execução do agente principal foi concluída\./);
  assert.match(recap.recap, /1 chamada de ferramenta em bash\./);
  assert.match(recap.recap, /Done\.$/);
  assert.equal(
    recap.next,
    "Revise o trabalho concluído acima e continue se ainda houver algo pendente.",
  );
});

type AssistantMessageShape = Extract<
  SessionEntry,
  { type: "message" }
>["message"] & { role: "assistant" };

function assistant(
  id: string,
  stopReason: "stop" | "aborted" | "error",
  overrides: Partial<
    Pick<AssistantMessageShape, "content" | "timestamp" | "errorMessage">
  > = {},
): SessionEntry {
  return entry(id, {
    role: "assistant",
    content: [{ type: "text", text: "worked" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    usage,
    stopReason,
    timestamp: 0,
    ...overrides,
  });
}

function user(id: string): SessionEntry {
  return entry(id, { role: "user", content: "go", timestamp: 0 });
}

test("interrupted runs end with an aborted final assistant message", () => {
  // Abort mid-stream: partial content plus the aborted marker pi persists.
  assert.equal(
    isRunInterrupted([
      user("u"),
      assistant("a", "aborted", {
        content: [{ type: "text", text: "partial answer" }],
        timestamp: 1,
      }),
    ]),
    true,
  );
  // Abort during teardown/shutdown: failure message with empty content.
  assert.equal(
    isRunInterrupted([user("u"), assistant("a", "aborted", { content: [] })]),
    true,
  );
});

test("interrupted detection ignores trailing bookkeeping entries", () => {
  const run: SessionEntry[] = [
    user("u"),
    assistant("a", "aborted"),
    {
      type: "model_change",
      id: "m",
      parentId: "a",
      timestamp: "",
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
    },
    {
      type: "custom",
      id: "c",
      parentId: "m",
      timestamp: "",
      customType: "other-extension",
      data: {},
    },
  ];
  assert.equal(isRunInterrupted(run), true);
});

test("normal, errored, and recovered runs are not interruptions", () => {
  // Normal completion.
  assert.equal(isRunInterrupted([user("u"), assistant("a", "stop")]), false);
  // Generic errors (stopReason "error") are NOT aborts: summaries must survive.
  assert.equal(
    isRunInterrupted([
      user("u"),
      assistant("a", "error", { errorMessage: "provider 500" }),
    ]),
    false,
  );
  // A tool abort mid-run followed by a completed turn: the run settled fine.
  assert.equal(
    isRunInterrupted([
      user("u"),
      assistant("a", "aborted", { errorMessage: "Operation aborted" }),
      entry("tr", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "killed" }],
        isError: true,
        timestamp: 0,
      }),
      assistant("final", "stop"),
    ]),
    false,
  );
});

test("interrupted detection is false without any assistant message", () => {
  assert.equal(isRunInterrupted([]), false);
  assert.equal(
    isRunInterrupted([
      user("u"),
      entry("tr", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "out" }],
        isError: false,
        timestamp: 0,
      }),
    ]),
    false,
  );
});

test("transcript enforces per-result and total byte caps", () => {
  const entries = Array.from({ length: 20 }, (_, index) =>
    entry(`result-${index}`, {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "bash",
      content: [{ type: "text", text: `${index}:${"x".repeat(10_000)}` }],
      isError: false,
      timestamp: index,
    }),
  );

  const transcript = serializeRunTranscript(entries);
  assert.ok(Buffer.byteLength(transcript, "utf8") <= TRANSCRIPT_MAX_BYTES);
  assert.match(transcript, /transcript capped/);
  assert.match(transcript, /tool result capped/);
});
