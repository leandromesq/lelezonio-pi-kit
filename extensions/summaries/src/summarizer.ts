import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  Type,
  parseJsonWithRepair,
  parseStreamingJson,
  type Tool,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { SummaryConfig } from "./config.ts";
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from "./prompt.ts";

const RECAP_MAX_LENGTH = 2_400;
const NEXT_MAX_LENGTH = 400;
const SUMMARY_TIMEOUT_MS = 45_000;
const SUMMARY_REQUEST_TIMEOUT_MS = 20_000;
const RECAP_TOOL_NAME = "record_run_recap";

const RECAP_TOOL = {
  name: RECAP_TOOL_NAME,
  description: "Record the completed run recap and its one next step.",
  parameters: Type.Object(
    {
      recap: Type.String({
        description: "Compact recap in Brazilian Portuguese.",
      }),
      next: Type.String({
        description: "One concise next step in Brazilian Portuguese.",
      }),
    },
    { additionalProperties: false },
  ),
  // pi-ai uses this hint for provider-side constrained sampling when the
  // selected adapter/model supports it, while "prefer" preserves portability.
  constrainedSampling: { type: "json_schema", strict: "prefer" },
} satisfies Tool;

type SummaryFailureKind =
  "unavailable" | "auth" | "request" | "aborted" | "timeout" | "invalid-output";

class SummaryError extends Error {
  readonly name = "SummaryError";
  readonly kind: SummaryFailureKind;
  readonly attempts: number;

  constructor(kind: SummaryFailureKind, message: string, attempts = 0) {
    super(message);
    this.kind = kind;
    this.attempts = attempts;
  }
}

interface SummaryResponse {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
    readonly name?: string;
    readonly arguments?: Record<string, unknown>;
  }[];
  readonly stopReason: string;
}

function summaryError(kind: SummaryFailureKind, attempts = 0): SummaryError {
  const message = {
    unavailable: "The configured summary model is unavailable.",
    auth: "The summary model is not authenticated.",
    request: "The summary model request failed.",
    aborted: "The summary model request was cancelled.",
    timeout: "The summary model request timed out.",
    "invalid-output": `The summary model returned invalid structured output after ${attempts} attempt${attempts === 1 ? "" : "s"}; expected valid recap JSON.`,
  }[kind];
  return new SummaryError(kind, message, attempts);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw summaryError("aborted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanField(value: string, maxLength: number) {
  const cleaned = value
    .replace(
      // Strip ANSI/OSC sequences before rendering model output in the terminal.
      // eslint-disable-next-line no-control-regex
      /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g,
      "",
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function parseRecapValue(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "next,recap" ||
    typeof value.recap !== "string" ||
    typeof value.next !== "string"
  ) {
    return undefined;
  }

  const recap = cleanField(value.recap, RECAP_MAX_LENGTH);
  const next = cleanField(
    value.next.replace(/^next\s*:\s*/i, ""),
    NEXT_MAX_LENGTH,
  );
  if (!recap || !next) return undefined;
  return { recap, next } satisfies RunRecap;
}

function repairSingleQuotedStrings(value: string) {
  let repaired = "";
  let inDouble = false;
  let inSingle = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (inSingle) {
      if (char === "\\") {
        const next = value[index + 1];
        if (next === "'") {
          repaired += "'";
          index++;
        } else {
          repaired += `\\${next ?? "\\"}`;
          if (next !== undefined) index++;
        }
      } else if (char === "'") {
        repaired += '"';
        inSingle = false;
      } else {
        repaired += char === '"' ? '\\"' : char;
      }
      continue;
    }
    if (char === '"') {
      repaired += char;
      inDouble = !inDouble;
    } else if (char === "'" && !inDouble) {
      repaired += '"';
      inSingle = true;
    } else {
      repaired += char;
    }
  }
  return repaired;
}

function repairUnquotedKeys(value: string) {
  let repaired = "";
  let inString = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') {
      repaired += char;
      if (value[index - 1] !== "\\") inString = !inString;
      continue;
    }
    if (!inString && (char === "{" || char === ",")) {
      repaired += char;
      const rest = value.slice(index + 1);
      const match = rest.match(/^(\s*)([A-Za-z_$][\w$-]*)(\s*:)/);
      if (match) {
        repaired += `${match[1]}"${match[2]}"${match[3]}`;
        index += match[0].length;
      }
      continue;
    }
    repaired += char;
  }
  return repaired;
}

function removeTrailingCommas(value: string) {
  let repaired = "";
  let inString = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== "\\") inString = !inString;
    if (!inString && char === "," && /^\s*[}\]]/.test(value.slice(index + 1))) {
      continue;
    }
    repaired += char;
  }
  return repaired;
}

function repairCommonJson(value: string) {
  return removeTrailingCommas(
    repairUnquotedKeys(repairSingleQuotedStrings(value)),
  );
}

function objectCandidates(text: string) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }

  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    for (let index = start; index < trimmed.length; index++) {
      const char = trimmed[index];
      if (char === '"' && trimmed[index - 1] !== "\\") inString = !inString;
      if (inString) continue;
      if (char === "{") depth++;
      if (char === "}" && --depth === 0) {
        candidates.push(trimmed.slice(start, index + 1));
        break;
      }
    }
  }
  return [...new Set(candidates)];
}

function parseCandidate(candidate: string) {
  const variants = [candidate, repairCommonJson(candidate)];
  for (const variant of [...new Set(variants)]) {
    try {
      const parsed = parseRecapValue(parseJsonWithRepair(variant));
      if (parsed) return parsed;
    } catch {
      // Try pi-ai's partial JSON parser below for truncated closing syntax.
    }
    const partial = parseRecapValue(parseStreamingJson(variant));
    if (partial) return partial;
  }
  return undefined;
}

function parseRecapResponseSafe(text: string) {
  for (const candidate of objectCandidates(text)) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

export interface RunRecap {
  readonly recap: string;
  readonly next: string;
}

export function parseRecapResponse(text: string) {
  const parsed = parseRecapResponseSafe(text);
  if (parsed) return parsed;
  throw summaryError("invalid-output", 1);
}

export function reasoningOptions(reasoning: SummaryConfig["reasoning"]) {
  return reasoning === "off" ? {} : { reasoning };
}

function assistantText(content: SummaryResponse["content"]) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function parseAssistantResponse(response: SummaryResponse) {
  for (const block of response.content) {
    if (block.type !== "toolCall" || block.name !== RECAP_TOOL_NAME) continue;
    const parsed = parseRecapValue(block.arguments);
    if (parsed) return parsed;
  }
  return parseRecapResponseSafe(assistantText(response.content));
}

function forcedToolChoice(api: string) {
  switch (api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
    case "google-generative-ai":
    case "google-vertex":
      return "any";
    case "mistral-conversations":
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
    case "pi-messages":
      return "required";
    default:
      return undefined;
  }
}

async function requestSummary(
  model: Parameters<typeof completeSimple>[0],
  transcript: string,
  signal: AbortSignal,
  auth: {
    readonly apiKey?: string;
    readonly env?: Record<string, string>;
    readonly headers?: Record<string, string | null>;
  },
  reasoning: SummaryConfig["reasoning"],
  corrective: boolean,
) {
  const toolChoice = forcedToolChoice(model.api);
  const prompt = `${buildSummaryPrompt(transcript)}${
    corrective
      ? "\n\nCorrection: The previous response was not valid. Return only one recap tool call with non-empty string fields recap and next; add no commentary."
      : ""
  }`;
  const requestOptions = {
    apiKey: auth.apiKey,
    env: auth.env,
    headers: auth.headers,
    maxTokens: 1_000,
    maxRetries: 0,
    signal,
    timeoutMs: SUMMARY_REQUEST_TIMEOUT_MS,
    ...reasoningOptions(reasoning),
    ...(toolChoice ? { toolChoice } : {}),
  } as unknown as Parameters<typeof completeSimple>[2];
  return completeSimple(
    model,
    {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      tools: [RECAP_TOOL],
    },
    requestOptions,
  );
}

export async function summarizeRun(options: {
  readonly modelRegistry: ModelRegistry;
  readonly config: SummaryConfig;
  readonly transcript: string;
  readonly signal: AbortSignal;
  /** Internal test seam; production uses the fixed bounded timeout. */
  readonly timeoutMs?: number;
}) {
  throwIfAborted(options.signal);
  const timeoutMs = options.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const requestController = new AbortController();
  let timedOut = false;
  const abortRequest = () => requestController.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, timeoutMs);
  options.signal.addEventListener("abort", abortRequest, { once: true });

  try {
    const model = options.modelRegistry.find(
      options.config.provider,
      options.config.model,
    );
    if (!model) throw summaryError("unavailable");

    const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw summaryError("auth");

    for (let attempt = 1; attempt <= 2; attempt++) {
      throwIfAborted(requestController.signal);
      let response: SummaryResponse;
      try {
        response = await requestSummary(
          model,
          options.transcript,
          requestController.signal,
          auth,
          options.config.reasoning,
          attempt === 2,
        );
      } catch (cause) {
        if (requestController.signal.aborted)
          throw summaryError(timedOut ? "timeout" : "aborted");
        throw cause;
      }
      if (response.stopReason === "aborted") {
        throw summaryError(timedOut ? "timeout" : "aborted");
      }
      if (response.stopReason === "error") throw summaryError("request");

      const parsed = parseAssistantResponse(response);
      if (parsed) return parsed;
    }
    throw summaryError("invalid-output", 2);
  } catch (cause) {
    if (options.signal.aborted) throw summaryError("aborted");
    if (timedOut) throw summaryError("timeout");
    if (cause instanceof SummaryError) throw cause;
    throw summaryError("request");
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abortRequest);
  }
}
