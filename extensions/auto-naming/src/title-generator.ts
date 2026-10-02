import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { redactSensitiveText } from "../../shared/sensitive-text.ts";
import type { NamingConfig } from "./config.ts";
import { TITLE_MAX_LENGTH } from "./constants.ts";
import { buildTitlePrompt, TITLE_SYSTEM_PROMPT } from "./prompt.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTerminalSequences(value: string) {
  return (
    value
      .replace(
        // Strip ANSI/OSC sequences before persisting model output in session metadata.
        // eslint-disable-next-line no-control-regex
        /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g,
        "",
      )
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}

export function normalizeTitle(value: string, maxLength = TITLE_MAX_LENGTH) {
  const cleaned = stripTerminalSequences(redactSensitiveText(value))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^title\s*:\s*/i, "")
    .replace(/^[`"'“”]+|[`"'“”]+$/g, "")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

export function fallbackTitle(prompt: string) {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0] ?? "";
  const withoutMarker = firstLine
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .trim();
  return normalizeTitle(withoutMarker) ?? "coding task";
}

function candidateTexts(text: string) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return candidates;
}

export function parseTitleResponse(text: string) {
  for (const candidate of candidateTexts(text)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (!isRecord(value) || typeof value.title !== "string") continue;
      const title = normalizeTitle(value.title);
      if (title) return title;
    } catch {
      // Try the next common model-output shape before failing.
    }
  }
  throw new Error("The title model did not return valid title JSON.");
}

function assistantText(content: AssistantMessage["content"]) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function reasoningOptions(reasoning: NamingConfig["reasoning"]) {
  return reasoning === "off" ? {} : { reasoning };
}

export async function generateTaskTitle(options: {
  readonly modelRegistry?: ModelRegistry;
  readonly config: NamingConfig;
  readonly prompt: string;
  readonly hint?: string;
  readonly fallback?: string;
  readonly signal?: AbortSignal;
}) {
  // A caller-supplied name is already useful. Never put authentication or a
  // cosmetic model request on the worker launch path just to rewrite it.
  const explicitTitle = normalizeTitle(options.hint ?? "");
  if (explicitTitle) return explicitTitle;
  const fallback =
    normalizeTitle(options.fallback ?? "") ?? fallbackTitle(options.prompt);
  if (!options.config.enabled || !options.modelRegistry) return fallback;

  try {
    const model = options.modelRegistry.find(
      options.config.provider,
      options.config.model,
    );
    if (!model) return fallback;

    // Provider-neutral request through the session's ModelRuntime facade:
    // request-time authentication (API keys, OAuth, headers, base URL) is
    // resolved internally, replacing the former
    // getApiKeyAndHeaders + compat completeSimple pair. Errors surface as a
    // stopReason of "error"/"aborted" (or a thrown setup failure), all of
    // which fall back exactly as before.
    const response = await options.modelRegistry
      .streamSimple(
        model,
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildTitlePrompt({
                prompt: redactSensitiveText(options.prompt),
                hint: options.hint
                  ? redactSensitiveText(options.hint)
                  : undefined,
              }),
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens: 80,
          maxRetries: 0,
          signal: options.signal,
          timeoutMs: 8_000,
          ...reasoningOptions(options.config.reasoning),
        },
      )
      .result();

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return fallback;
    }
    return parseTitleResponse(assistantText(response.content));
  } catch {
    return fallback;
  }
}
