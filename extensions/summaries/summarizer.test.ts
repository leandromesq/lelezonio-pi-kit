import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SummaryConfig } from "./src/config.ts";
import {
  parseRecapResponse,
  reasoningOptions,
  summarizeRun,
} from "./src/summarizer.ts";
import { SUMMARY_SYSTEM_PROMPT } from "./src/prompt.ts";

test("system prompt mandates Brazilian Portuguese for recap and next", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /Brazilian Portuguese \(pt-BR\)/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /recap and next/);
});

test("omits reasoning when configured off", () => {
  assert.deepEqual(reasoningOptions("off"), {});
  assert.deepEqual(reasoningOptions("medium"), { reasoning: "medium" });
});

test("parses strict recap JSON", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"Updated config and ran focused tests.","next":"Review the diff."}',
    ),
    {
      recap: "Updated config and ran focused tests.",
      next: "Review the diff.",
    },
  );
});

test("defensively extracts fenced or surrounded JSON and normalizes Next", () => {
  assert.deepEqual(
    parseRecapResponse(
      'Result follows:\n```json\n{"recap":"- Added the extension\\n- Tests pass","next":"Next: Reload Pi."}\n```',
    ),
    {
      recap: "- Added the extension\n- Tests pass",
      next: "Reload Pi.",
    },
  );
});

test("repairs common near-valid JSON without evaluating model text", () => {
  assert.deepEqual(
    parseRecapResponse(
      "Here is the result:\n{recap: 'A simple change is done', next: \"Review it\",}",
    ),
    {
      recap: "A simple change is done",
      next: "Review it",
    },
  );
  assert.deepEqual(
    parseRecapResponse('{"recap":"Updated config","next":"Run tests"'),
    { recap: "Updated config", next: "Run tests" },
  );
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"line one\nline two","next":"Check the diff"}',
    ),
    { recap: "line one\nline two", next: "Check the diff" },
  );
});

test("rejects malformed or incomplete output", () => {
  assert.throws(() => parseRecapResponse("not json"), /valid recap JSON/);
  assert.throws(
    () => parseRecapResponse('{"recap":"missing next"}'),
    /valid recap JSON/,
  );
  assert.throws(
    () =>
      parseRecapResponse(
        '{"recap":"done","next":"nothing","extra":"not allowed"}',
      ),
    /valid recap JSON/,
  );
});

test("strips terminal control sequences from recap fields", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"Updated \\u001b[31mconfig\\u001b[0m.","next":"Review it.\\u0007"}',
    ),
    { recap: "Updated config.", next: "Review it." },
  );
});

function testConfig(provider: string, model: string): SummaryConfig {
  return { provider, model, reasoning: "off" };
}

function testRegistry(registration: ReturnType<typeof registerFauxProvider>) {
  return {
    find: () => registration.getModel(),
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: "test-key",
    }),
  } as unknown as ModelRegistry;
}

function registerSummaryFaux(
  options: Parameters<typeof registerFauxProvider>[0] = {},
) {
  return registerFauxProvider({
    api: `summary-test-${Math.random().toString(36).slice(2)}`,
    provider: "summary-test",
    models: [{ id: "model", reasoning: false }],
    ...options,
  });
}

test("uses pi-ai structured tool arguments without a repair retry", async () => {
  const registration = registerSummaryFaux();
  registration.setResponses([
    fauxAssistantMessage(
      fauxToolCall("record_run_recap", { recap: "Feito.", next: "Revisar." }),
      { stopReason: "toolUse" },
    ),
  ]);
  try {
    assert.deepEqual(
      await summarizeRun({
        modelRegistry: testRegistry(registration),
        config: testConfig("summary-test", "model"),
        transcript: "A safe transcript.",
        signal: new AbortController().signal,
      }),
      { recap: "Feito.", next: "Revisar." },
    );
    assert.equal(registration.state.callCount, 1);
  } finally {
    registration.unregister();
  }
});

test("makes one concise corrective retry after invalid structured output", async () => {
  const registration = registerSummaryFaux();
  registration.setResponses([
    fauxAssistantMessage('{"recap":"done","next":42}'),
    fauxAssistantMessage(
      fauxToolCall("record_run_recap", {
        recap: "Corrigido.",
        next: "Revisar.",
      }),
      { stopReason: "toolUse" },
    ),
  ]);
  try {
    const result = await summarizeRun({
      modelRegistry: testRegistry(registration),
      config: testConfig("summary-test", "model"),
      transcript: "A safe transcript.",
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { recap: "Corrigido.", next: "Revisar." });
    assert.equal(registration.state.callCount, 2);
  } finally {
    registration.unregister();
  }
});

test("does not retry cancellation or timeout", async () => {
  const registration = registerSummaryFaux({ tokensPerSecond: 100 });
  registration.setResponses([fauxAssistantMessage("x".repeat(100))]);
  const controller = new AbortController();
  const cancelled = summarizeRun({
    modelRegistry: testRegistry(registration),
    config: testConfig("summary-test", "model"),
    transcript: "A safe transcript.",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(cancelled, /cancelled/);
    assert.equal(registration.state.callCount, 1);
  } finally {
    registration.unregister();
  }

  const timedOut = registerSummaryFaux({ tokensPerSecond: 100 });
  timedOut.setResponses([fauxAssistantMessage("x".repeat(100))]);
  try {
    await assert.rejects(
      summarizeRun({
        modelRegistry: testRegistry(timedOut),
        config: testConfig("summary-test", "model"),
        transcript: "A safe transcript.",
        signal: new AbortController().signal,
        timeoutMs: 5,
      }),
      /timed out/,
    );
    assert.equal(timedOut.state.callCount, 1);
  } finally {
    timedOut.unregister();
  }
});

test("invalid-output diagnostics omit model response content", async () => {
  const registration = registerSummaryFaux();
  registration.setResponses([
    fauxAssistantMessage('{"recap":"secret transcript text","next":false}'),
    fauxAssistantMessage('{"recap":"still invalid","next":false}'),
  ]);
  try {
    await assert.rejects(
      summarizeRun({
        modelRegistry: testRegistry(registration),
        config: testConfig("summary-test", "model"),
        transcript: "private transcript",
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof Error &&
        /after 2 attempts/.test(error.message) &&
        !error.message.includes("secret transcript"),
    );
  } finally {
    registration.unregister();
  }
});
