import type { SpawnTask } from "../domain.ts";

export type CodexSandbox = "danger-full-access" | "read-only";
export type CodexApprovalPolicy = "never";

export interface CodexExecutionPolicy {
  readonly sandbox: CodexSandbox;
  readonly approvalPolicy: CodexApprovalPolicy;
}

/**
 * Autonomous Codex children cannot answer approval prompts. Trusted projects
 * retain full workspace behavior; untrusted projects fail closed to read-only
 * so repository-controlled instructions cannot modify the host. A read-only
 * profile forces read-only regardless of trust.
 */
export function codexExecutionPolicy(
  projectTrusted: boolean,
  options: { readonly readOnly?: boolean } = {},
): CodexExecutionPolicy {
  const sandbox: CodexSandbox =
    options.readOnly || !projectTrusted ? "read-only" : "danger-full-access";
  return { sandbox, approvalPolicy: "never" };
}

export function codexPolicyForTask(
  task: Pick<SpawnTask, "parent">,
): CodexExecutionPolicy {
  return codexExecutionPolicy(task.parent.projectTrusted, {
    readOnly: task.parent.toolPolicy?.readOnly,
  });
}

export function codexPolicyCliArgs(
  task: Pick<SpawnTask, "parent">,
): ReadonlyArray<string> {
  const policy = codexPolicyForTask(task);
  return ["-s", policy.sandbox, "-a", policy.approvalPolicy];
}
