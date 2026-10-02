import * as path from "node:path";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
  type LoadExtensionsResult,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

/** Bound shared by the child abort wait and the child shutdown hook. */
export const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Tools that headless children must not receive. Everything else stays enabled. */
export const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_send",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "remote_spawn",
  "remote_send",
  "remote_wait",
  "remote_cancel",
  "remote_check",
  "remote_list",
  "workflow",
  "ask_user",
] as const;

/** Fresh SDK options avoid turning the denylist into an accidental allowlist.
 * Workflow children have no read-only profile, so this stays a denylist; the
 * subagents profiles that DO narrow their surface are enforced with a real
 * `tools` allowlist instead (see subagents/src/profile.ts). */
export function childToolPolicy() {
  return { excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES] };
}

/**
 * Extensions that must not run inside a child session, matched against the
 * extension's resolved path.
 *
 * A child is an execution unit: it does not need memory workers, proactive
 * compaction, dashboards or naming, and those costs multiply by the number of
 * concurrent children. Herdr workers get the same treatment through the
 * launcher env (`PI_OBSERVATIONAL_MEMORY_PASSIVE`, see
 * subagents/src/backends/herdr-worker.ts); in-process children share this
 * process, so filtering the child's resource loader is the only lever.
 */
export const CHILD_EXCLUDED_EXTENSION_PATHS = [
  "pi-observational-memory",
  "observational-memory",
  // DonSeTch eagerly starts a process-wide transport/daemon on session_start
  // and tears it down on session_shutdown. In-process SDK children share the
  // parent process, so a child dispose could cross-kill the transport the
  // parent still uses. Exclude it from EVERY in-process child (not just
  // narrowed ones); the parent keeps its own web tools, and native-MCP
  // children still get the full supported surface from `childNativeExtensionFactories`.
  "donsetch",
] as const;

export function withoutChildExcludedExtensions(
  base: LoadExtensionsResult,
  extraExcludedPaths: readonly string[] = [],
): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.filter((extension) => {
      const resolved = String(extension.resolvedPath ?? extension.path ?? "");
      // Match a whole path segment so `pi-observational-memory-extra` is not
      // caught by the `pi-observational-memory` rule.
      const segments = resolved.split(/[\\/]/);
      return ![...CHILD_EXCLUDED_EXTENSION_PATHS, ...extraExcludedPaths].some(
        (needle) => segments.includes(needle),
      );
    }),
  };
}

/**
 * Pi's native SDK extensions: `codemode`, `tool_search`, and MCP. The CLI
 * loads them as built-in extensions, but an SDK session — every in-process
 * child — must add them explicitly (docs/sdk.md).
 *
 * `codemode` and `tool_search` register inactive; the MCP extension activates
 * them when a server with `codemode`/`deferred` exposure connects. MCP reads
 * `mcp.json` from the agent directory and, only when the child's project is
 * trusted, from the child project.
 */
export function childNativeExtensionFactories(): InlineExtension[] {
  return [
    createCodemodeExtension(),
    createToolSearchExtension(),
    createMcpExtension(),
  ];
}

export interface ChildResourceOptions {
  cwd: string;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
  agentDir?: string;
  /**
   * Add Pi's native SDK extensions (`codemode`, `tool_search`, MCP).
   *
   * Only enable this for a child that keeps the default full tool surface.
   * A narrowed child (an explicit `tools` allowlist, such as a read-only
   * profile) must not register these at all: `codemode`/`deferred` tools stay
   * callable through scripts regardless of the active set, and connecting MCP
   * servers spawns processes the profile did not ask for. Excluding the names
   * from the active set is not enough — the session-level `tools`/`excludeTools`
   * options are what remove a tool from the callable registry.
   */
  nativeBuiltins?: boolean;
  /** Omit session hooks for optional services a narrowed child cannot use. */
  excludedExtensionPaths?: readonly string[];
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    // Children keep tools and project instructions, but not extensions that
    // only exist to serve an interactive parent session.
    extensionsOverride: (base) =>
      withoutChildExcludedExtensions(base, options.excludedExtensionPaths),
    ...(options.nativeBuiltins
      ? { extensionFactories: childNativeExtensionFactories() }
      : {}),
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
  });
  await loader.reload();
  return { loader, settingsManager };
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveStandaloneChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
  agentDir?: string;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(options.agentDir ?? getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

/** Start child extension session hooks/resources in headless print mode. */
export async function bindChildSessionExtensions(
  session: Pick<AgentSession, "bindExtensions">,
) {
  await session.bindExtensions({ mode: "print" });
}

interface ChildExtensionRunner {
  hasHandlers(eventType: string): boolean;
  emit(event: SessionShutdownEvent): Promise<unknown>;
}

export interface DisposableChildSession {
  readonly extensionRunner: ChildExtensionRunner;
  dispose(): void;
}

const childShutdowns = new WeakMap<object, Promise<void>>();

export function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Emit child session_shutdown once, then dispose once. Hook failures and a
 * bounded hook deadline never prevent disposal.
 */
export function shutdownAndDisposeChildSession(
  session: DisposableChildSession,
  options: { timeoutMs?: number } = {},
) {
  const existing = childShutdowns.get(session);
  if (existing) return existing;

  const shutdown = (async () => {
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await waitBounded(
          session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS,
        );
      }
    } catch {
      // Extension runner inspection/emission is best-effort during teardown.
    } finally {
      try {
        session.dispose();
      } catch {
        // Disposal is terminal and must remain idempotent for callers.
      }
    }
  })();

  childShutdowns.set(session, shutdown);
  return shutdown;
}
