import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const commandName = "git";
const MAX_SNAPSHOT_CHARS = 30_000;

const YEET_PROMPT = `Commit and push the current repository changes.

Steps:
1. Add all unstaged changes with \`git add -A\`.
2. Inspect the staged changes and write a concise commit message that accurately summarizes them.
3. Commit the changes with that message.
4. Push the commit to the current branch's remote.
   - If the current branch does not have an upstream remote branch, create one by pushing with upstream tracking.
   - If this repository has no git remotes configured, do not push.
5. After pushing, output the remote URL for what was pushed if the repository has a remote.
   - If the current branch is \`main\`, output the normal remote repository URL.
   - If the current branch is not \`main\`, output a URL to create a pull request from the pushed branch into \`main\`.
   - Convert SSH git remotes like \`git@github.com:owner/repo.git\` to HTTPS URLs when printing.

Keep the commit message concise.`;

type ExecSnapshot = {
  command: string;
  stdout: string;
  stderr: string;
  code: number | null;
};

function truncateSnapshot(value: string, maxChars = MAX_SNAPSHOT_CHARS) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars; agent should inspect with git commands if needed]`;
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char) || ";|&(){}[]<>\n".includes(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) words.push(current);
  return words;
}

function isGhExecutable(word: string | undefined) {
  return word === "gh" || word === "gh.exe";
}

function findGhPrCreateArgs(command: string): string[] | undefined {
  const words = shellWords(command);
  for (let index = 0; index < words.length - 2; index += 1) {
    if (
      isGhExecutable(words[index]) &&
      words[index + 1] === "pr" &&
      words[index + 2] === "create"
    ) {
      return words.slice(index + 3);
    }
  }
  return undefined;
}

export function extractBaseBranch(command: string) {
  const args = findGhPrCreateArgs(command);
  if (!args) return undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--base" || arg === "-B") return args[index + 1];
    if (arg.startsWith("--base=")) return arg.slice("--base=".length);
  }

  return undefined;
}

function hasGhPrCreate(command: string) {
  return findGhPrCreateArgs(command) !== undefined;
}

export function normalizeBranchArg(args: string) {
  const branch = args.trim();
  if (!branch)
    return {
      ok: false as const,
      error: `Usage: /${commandName} <target-branch>`,
    };
  if (/\s/.test(branch)) {
    return {
      ok: false as const,
      error: `/${commandName} accepts exactly one target branch argument. Example: /${commandName} main`,
    };
  }
  return { ok: true as const, branch };
}

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeout = 10_000,
) {
  const result = await pi.exec("git", args, { cwd, timeout });
  return {
    command: `git ${args.join(" ")}`,
    stdout: truncateSnapshot(result.stdout.trimEnd()),
    stderr: truncateSnapshot(result.stderr.trimEnd()),
    code: result.code,
  };
}

function formatSnapshot(snapshot: ExecSnapshot) {
  const stderr = snapshot.stderr ? `\nstderr:\n${snapshot.stderr}` : "";
  return `### ${snapshot.command} (exit ${snapshot.code ?? "unknown"})\n\nstdout:\n${snapshot.stdout || "<empty>"}${stderr}`;
}

export function buildWorkflowPrompt(input: {
  targetBranch: string;
  currentBranch: string;
  isDirty: boolean;
  snapshots: ExecSnapshot[];
}) {
  const targetBranchJson = JSON.stringify(input.targetBranch);
  const currentBranchJson = JSON.stringify(
    input.currentBranch || "<detached HEAD>",
  );

  return `Run the GitHub pull request workflow for this repository.

Target branch: ${targetBranchJson}
Current branch: ${currentBranchJson}
Working tree has uncommitted changes: ${input.isDirty ? "yes" : "no"}

Hard safety rules:
- The target branch is required and has been provided as ${targetBranchJson}. Never create a pull request without an explicit target branch.
- Every \`gh pr create\` command MUST include \`--base ${input.targetBranch}\`. If you cannot use that exact base branch, stop and ask me.
- Do not push or create a PR until I approve the PR description.
- If there are uncommitted changes, do not stage, commit, stash, reset, rebase, merge, or otherwise mutate the repo until you show the full commit plan and I approve it.
- Ask before resolving conflicts whenever the intended resolution is not obvious. Never blindly choose ours/theirs for user-authored code.

Required flow:
1. Review the git snapshots below. If more detail is needed, run additional read-only git commands first.
2. If there are uncommitted changes:
   - Ask whether I want you to commit them before the PR.
   - Group uncommitted changes into logical commits by concern and layer.
   - Generate commit messages using the better-commits style, e.g. \`feat: subject\`, \`fix: subject\`, \`refactor: subject\`, \`docs: subject\`, \`test: subject\`, \`chore: subject\`.
   - Show the full plan with files/hunks per commit and wait for my approval before touching anything.
   - Execute approved commits one by one, staging only the intended files/hunks for each commit.
   - If I decline committing dirty changes, explain that uncommitted changes cannot be included in a GitHub PR; ask whether to abort, stash, or continue with only existing commits.
3. If no commit step is needed, skip directly to PR preparation.
4. Ensure the branch can merge cleanly with ${targetBranchJson} before creating the PR. Fetch/update remote refs as needed. If conflicts occur during merge/rebase/cherry-pick:
   - Stop and show \`git status\` plus conflicted files.
   - Explain the conflict in plain language.
   - Ask for my decision when resolution is not obvious.
   - After resolving, run appropriate verification and continue the interrupted operation only with approval when needed.
5. Generate a PR title and description from the commit history/diff against ${targetBranchJson}. Include summary, testing/verification, and notable risks.
6. Show the PR title/body and wait for my approval.
7. Push the current branch, setting upstream if needed.
8. Create the PR with \`gh pr create --base ${input.targetBranch}\` (and explicit head/title/body). Report the PR URL.

Initial git snapshots:

${input.snapshots.map(formatSnapshot).join("\n\n")}`;
}

export default function gitPrExtension(pi: ExtensionAPI) {
  const targetBranchByRepo = new Map<string, string>();

  pi.registerCommand("yeet", {
    description: "Add, commit, and push the current repo changes",
    handler: async (args, ctx) => {
      const prompt = args?.trim()
        ? `${YEET_PROMPT}\n\nAdditional instructions from the user:\n${args.trim()}`
        : YEET_PROMPT;

      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /yeet as a follow-up", "info");
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (!hasGhPrCreate(command)) return;

    const baseBranch = extractBaseBranch(command);
    if (!baseBranch) {
      return {
        block: true,
        reason: `Blocked gh pr create: include an explicit --base <target-branch>. Prefer /${commandName} <target-branch>.`,
      };
    }

    const repoRoot = await git(
      pi,
      ctx.cwd,
      ["rev-parse", "--show-toplevel"],
      5_000,
    ).catch(() => undefined);
    const repoKey = repoRoot?.code === 0 ? repoRoot.stdout.trim() : ctx.cwd;
    const expectedBranch = targetBranchByRepo.get(repoKey);
    if (!expectedBranch || baseBranch === expectedBranch) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked gh pr create: base branch ${baseBranch} differs from /${commandName} target ${expectedBranch}.`,
      };
    }

    const ok = await ctx.ui.confirm(
      "PR target branch differs",
      `This command creates a PR against ${baseBranch}, but the last /${commandName} target for this repo was ${expectedBranch}. Allow it?`,
    );

    if (!ok) {
      return {
        block: true,
        reason: `Blocked gh pr create: base branch ${baseBranch} was not approved.`,
      };
    }
  });

  pi.registerCommand(commandName, {
    description:
      "Plan commits, push, and create a GitHub PR: /git <target-branch>",
    handler: async (args, ctx) => {
      const parsed = normalizeBranchArg(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }

      await ctx.waitForIdle();

      const repoCheck = await git(
        pi,
        ctx.cwd,
        ["rev-parse", "--show-toplevel"],
        5_000,
      );
      if (repoCheck.code !== 0) {
        ctx.ui.notify(
          repoCheck.stderr || "Not inside a git repository",
          "error",
        );
        return;
      }

      const targetBranch = parsed.branch;
      const repoKey = repoCheck.stdout.trim() || ctx.cwd;
      targetBranchByRepo.set(repoKey, targetBranch);

      const [
        statusShort,
        statusBranch,
        diffStat,
        diff,
        stagedDiff,
        recentLog,
        currentBranch,
      ] = await Promise.all([
        git(
          pi,
          ctx.cwd,
          ["status", "--porcelain=v1", "--untracked-files=all"],
          10_000,
        ),
        git(
          pi,
          ctx.cwd,
          ["status", "--short", "--branch", "--untracked-files=all"],
          10_000,
        ),
        git(pi, ctx.cwd, ["diff", "--stat"], 10_000),
        git(pi, ctx.cwd, ["diff", "--"], 10_000),
        git(pi, ctx.cwd, ["diff", "--cached", "--"], 10_000),
        git(
          pi,
          ctx.cwd,
          ["log", "--oneline", "--decorate", "--max-count=30"],
          10_000,
        ),
        git(pi, ctx.cwd, ["branch", "--show-current"], 5_000),
      ]);

      const prompt = buildWorkflowPrompt({
        targetBranch,
        currentBranch: currentBranch.stdout.trim(),
        isDirty: statusShort.stdout.trim().length > 0,
        snapshots: [statusBranch, diffStat, diff, stagedDiff, recentLog],
      });

      pi.sendUserMessage(prompt);
    },
  });
}
