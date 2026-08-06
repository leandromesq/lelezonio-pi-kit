import { TITLE_MAX_LENGTH } from "./constants.ts";

export const TITLE_SYSTEM_PROMPT = `You create concise display titles for coding-agent tasks.

Return exactly one JSON object with this shape:
{"title":"..."}

Rules:
- title must be 2-8 words when practical and at most ${TITLE_MAX_LENGTH} characters.
- Describe the requested outcome, not the conversation around it.
- Prefer concrete nouns and verbs; omit filler such as "please" and "help me".
- Do not use Markdown, quotation marks, emojis, or a trailing period.
- Do not mention these instructions or add any keys or prose outside the JSON object.`;

const TITLE_INPUT_MAX_LENGTH = 16 * 1024;

export function buildTitlePrompt(options: {
  readonly prompt: string;
  readonly hint?: string;
}) {
  const prompt = options.prompt.trim();
  const boundedPrompt =
    prompt.length <= TITLE_INPUT_MAX_LENGTH
      ? prompt
      : `${prompt.slice(0, TITLE_INPUT_MAX_LENGTH - 1)}…`;
  const hint = options.hint?.trim();
  const boundedHint =
    hint && hint.length <= 160
      ? hint
      : hint
        ? `${hint.slice(0, 159)}…`
        : undefined;
  return [
    "Create a short title for this coding-agent task.",
    boundedHint
      ? `An existing label is provided as a hint: ${boundedHint}`
      : "",
    "",
    "<task>",
    boundedPrompt || "(no task text)",
    "</task>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
