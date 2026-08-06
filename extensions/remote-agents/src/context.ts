import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { redactSensitiveText } from "../../shared/sensitive-text.ts";

export { redactSensitiveText };

const CONTEXT_MAX_CHARS = 28 * 1024;
const INSTRUCTIONS_MAX_CHARS = 64 * 1024;

function textContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        "text" in part &&
        part.type === "text" &&
        typeof part.text === "string"
      );
    })
    .map((part) => part.text)
    .join("\n");
}

function entryText(entry: SessionEntry) {
  if (entry.type === "compaction")
    return `Earlier context summary: ${entry.summary}`;
  if (entry.type === "branch_summary")
    return `Branch summary: ${entry.summary}`;
  if (entry.type !== "message") return "";
  const message = entry.message;
  switch (message.role) {
    case "user": {
      const text = textContent(message.content);
      return text ? `User: ${text}` : "";
    }
    case "assistant": {
      const text = textContent(message.content);
      return text ? `Assistant: ${text}` : "";
    }
    case "compactionSummary":
      return `Earlier context summary: ${message.summary}`;
    case "branchSummary":
      return `Branch summary: ${message.summary}`;
    case "custom": {
      const text = textContent(message.content);
      return text ? `Context: ${text}` : "";
    }
    case "bashExecution":
    case "toolResult":
      return "";
  }
}

export function buildRemotePrompt(options: {
  instructions: string;
  title: string;
  localCwd: string;
  remoteCwd: string;
  project?: { readonly name: string; readonly root: string };
  context: ExtensionContext;
}) {
  const instructions = options.instructions.trim();
  if (instructions.length > INSTRUCTIONS_MAX_CHARS) {
    throw new Error("Remote instructions exceed the 64 KiB limit");
  }
  const sections = options.context.sessionManager
    .buildContextEntries()
    .map(entryText)
    .filter(Boolean);
  let conversation = redactSensitiveText(sections.join("\n\n"));
  if (conversation.length > CONTEXT_MAX_CHARS) {
    conversation = `[Earlier conversation omitted to stay within the remote handoff limit.]\n\n${conversation.slice(-CONTEXT_MAX_CHARS)}`;
  }

  return `# Remote task: ${options.title}

## Instructions
${redactSensitiveText(instructions)}

## Project
- Parent working directory: ${options.localCwd}
- Remote working directory: ${options.remoteCwd}
${options.project ? `- Git project: ${options.project.name}\n- Remote project root: ${options.project.root}\n` : "- No local Git project was detected; this is a projectless workspace.\n"}- Run all work in the remote working directory.

## Relevant parent-session context
${conversation || "No earlier conversation context is available."}

## Completion contract
- Work autonomously until the requested task is complete or genuinely blocked.
- Follow the remote checkout's AGENTS.md and applicable skills.
- Run the repository's available check, format, lint, and test commands for changes you make.
- Do not push, merge, deploy, expose services, or copy secrets unless the task explicitly authorizes it.
- End with a concise report of work performed, files changed, checks run, and unresolved issues.
`;
}

export function deriveTitle(instructions: string) {
  const firstLine = instructions.trim().split(/\r?\n/, 1)[0] || "remote task";
  return firstLine.replace(/^#+\s*/, "").slice(0, 72);
}
