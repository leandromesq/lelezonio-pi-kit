import type { SshTransport } from "./transport.ts";

export type HerdrAgentStatus =
  "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrAgent {
  readonly agent: string;
  readonly agent_status: HerdrAgentStatus;
  readonly cwd: string;
  readonly name?: string;
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly state_change_seq: number;
  readonly agent_session?: {
    readonly value: string;
  };
}

interface StartResult {
  readonly workspaceId: string;
  readonly paneId: string;
  readonly agent: HerdrAgent;
  readonly prompted: { readonly agent: HerdrAgent };
}

export class HerdrClient {
  private readonly transport: SshTransport;

  constructor(transport: SshTransport) {
    this.transport = transport;
  }

  ping(signal?: AbortSignal) {
    return this.transport.request<{
      protocol: number;
      ok: boolean;
      status: string;
    }>({ action: "ping" }, { signal });
  }

  async start(options: {
    name: string;
    cwd: string;
    prompt: string;
    signal?: AbortSignal;
  }) {
    return this.transport.request<StartResult>(
      {
        action: "start",
        name: options.name,
        cwd: options.cwd,
        prompt: options.prompt,
      },
      { signal: options.signal, timeoutMs: 180_000 },
    );
  }

  async list(signal?: AbortSignal) {
    const result = await this.transport.request<{ agents: HerdrAgent[] }>(
      { action: "list" },
      { signal },
    );
    return result.agents;
  }

  async get(target: string, signal?: AbortSignal) {
    const result = await this.transport.request<{ agent: HerdrAgent }>(
      { action: "get", target },
      { signal },
    );
    return result.agent;
  }

  async read(target: string, lines = 300, signal?: AbortSignal) {
    const result = await this.transport.request<{ text: string }>(
      { action: "read", target, lines },
      { signal },
    );
    return result.text;
  }

  async result(target: string, signal?: AbortSignal) {
    return this.transport.request<{ text: string; sessionPath: string }>(
      { action: "result", target },
      { signal },
    );
  }

  pathInfo(remotePath: string, signal?: AbortSignal) {
    return this.transport.request<{
      exists: boolean;
      isGitRepository: boolean;
    }>({ action: "path_info", path: remotePath }, { signal });
  }

  cloneProject(
    options: {
      origin: string;
      projectsRoot: string;
      destination: string;
    },
    signal?: AbortSignal,
  ) {
    return this.transport.request<{ path: string; output: string }>(
      { action: "clone", ...options },
      { signal, timeoutMs: 330_000 },
    );
  }

  prompt(target: string, text: string, signal?: AbortSignal) {
    return this.transport.request<{ agent: HerdrAgent }>(
      { action: "prompt", target, text },
      { signal },
    );
  }

  cancel(target: string, signal?: AbortSignal) {
    return this.transport.request({ action: "cancel", target }, { signal });
  }

  close(workspaceId: string, signal?: AbortSignal) {
    return this.transport.request({ action: "close", workspaceId }, { signal });
  }
}
