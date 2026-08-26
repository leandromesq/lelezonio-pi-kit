import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const PROVIDER_ID = "openai-codex";
const AUTH_FILE_NAME = "auth.json";
const ACCOUNTS_DIRECTORY_NAME = "codex-accounts";

type CodexCredential = { type: string; accountId?: string } & Record<
  string,
  unknown
>;

export type CodexAccount = {
  name: string;
  active: boolean;
};

/** Pi's agent dir: $PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function resolveAgentDir(
  environment = process.env,
  userHome = homedir(),
) {
  const envDir = environment.PI_CODING_AGENT_DIR?.trim();
  return envDir ? resolve(envDir) : join(userHome, ".pi", "agent");
}

export function validateAccountName(name: string) {
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new Error(
      "Account names must be 1-64 characters and use only letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return name;
}

function parseEntries(contents: Buffer, path: string) {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`Pi auth store is not valid JSON: ${path}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Pi auth store must contain a JSON object: ${path}`);
  }

  return value as Record<string, unknown>;
}

async function readEntries(path: string) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AuthStoreNotFoundError(path);
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error(`Pi auth store is not a regular file: ${path}`);
  }

  const contents = await readFile(path);
  return { contents, entries: parseEntries(contents, path) };
}

class AuthStoreNotFoundError extends Error {
  constructor(path: string) {
    super(`Pi auth store was not found at ${path}`);
  }
}

/** The stored credential for the OpenAI Codex provider, if any. */
function providerCredential(entries: Record<string, unknown>) {
  const entry = entries[PROVIDER_ID];
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as CodexCredential)
    : undefined;
}

function credentialIdentity(credential: CodexCredential) {
  const accountId = credential.accountId;
  return typeof accountId === "string" && accountId
    ? `account:${accountId}`
    : undefined;
}

function credentialsMatch(
  first: { credential: CodexCredential },
  second: { credential: CodexCredential },
) {
  const firstIdentity = credentialIdentity(first.credential);
  const secondIdentity = credentialIdentity(second.credential);
  if (firstIdentity && secondIdentity) return firstIdentity === secondIdentity;
  return (
    JSON.stringify(first.credential) === JSON.stringify(second.credential)
  );
}

async function atomicWrite(path: string, contents: Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Run `fn` under the same file lock Pi itself uses for auth.json writes
 * (proper-lockfile on the auth file), so a credential switch cannot interleave
 * with Pi's own login/logout/token-refresh writes.
 */
async function withAuthStoreLock<T>(
  authPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
  await writeFile(authPath, "{}", { flag: "wx", mode: 0o600 }).catch(
    (error: unknown) => {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        )
      ) {
        throw error;
      }
    },
  );

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(authPath, { realpath: false });
    return await fn();
  } finally {
    if (release) {
      await release().catch(() => undefined);
    }
  }
}

export class CodexAccountStore {
  readonly agentDir: string;

  constructor(agentDir = resolveAgentDir()) {
    this.agentDir = agentDir;
  }

  private get authPath() {
    return join(this.agentDir, AUTH_FILE_NAME);
  }

  private get accountsDirectory() {
    return join(this.agentDir, ACCOUNTS_DIRECTORY_NAME);
  }

  private accountPath(name: string) {
    return join(this.accountsDirectory, `${validateAccountName(name)}.json`);
  }

  /** Current Pi credential for the OpenAI Codex provider, or undefined when
   * no auth store exists yet. Parse/storage errors propagate. */
  async currentCredential() {
    let result;
    try {
      result = await readEntries(this.authPath);
    } catch (error) {
      if (error instanceof AuthStoreNotFoundError) return undefined;
      throw error;
    }
    return providerCredential(result.entries);
  }

  async hasCurrentCredentials() {
    return (await this.currentCredential()) !== undefined;
  }

  async hasAccount(name: string) {
    const path = this.accountPath(name);
    try {
      return (await lstat(path)).isFile();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  /** Delete a saved account snapshot. The current Pi login is untouched. */
  async remove(name: string) {
    const path = this.accountPath(name);
    try {
      const stats = await lstat(path);
      if (!stats.isFile()) {
        throw new Error(
          `Codex account "${name}" is not a regular file: ${path}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new Error(`No saved Codex account "${name}".`);
      }
      throw error;
    }
    await rm(path);
  }

  async save(name: string, options: { overwrite?: boolean } = {}) {
    const path = this.accountPath(name);
    if (!options.overwrite && (await this.hasAccount(name))) {
      throw new Error(`Codex account "${name}" already exists.`);
    }

    const credential = await this.currentCredential();
    if (!credential) {
      throw new Error(
        `Pi has no ${PROVIDER_ID} credentials yet. Run /login (provider: OpenAI Codex) first.`,
      );
    }

    await atomicWrite(
      path,
      Buffer.from(`${JSON.stringify(credential, null, 2)}\n`, "utf8"),
    );
  }

  async list() {
    let entries;
    try {
      entries = await readdir(this.accountsDirectory, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter((name) => ACCOUNT_NAME_PATTERN.test(name))
      .sort((left, right) => left.localeCompare(right));

    const activeCredential = await this.currentCredential().catch(
      () => undefined,
    );

    return Promise.all(
      names.map(async (name): Promise<CodexAccount> => {
        if (!activeCredential) return { name, active: false };

        const savedCredential = await this.readSavedCredential(name).catch(
          () => undefined,
        );
        return {
          name,
          active:
            savedCredential !== undefined &&
            credentialsMatch(
              { credential: activeCredential },
              { credential: savedCredential },
            ),
        };
      }),
    );
  }

  private async readSavedCredential(name: string) {
    const path = this.accountPath(name);
    // Each snapshot file holds exactly one Pi credential entry.
    const { contents } = await readEntries(path);
    return parseEntries(contents, path) as CodexCredential;
  }

  /** Name of an already-saved account whose credential matches the CURRENT
   * pi credential, excluding `targetName` (typically the name being saved).
   * Returns undefined when the current identity is not saved anywhere. */
  async findCurrentIdentityName(targetName?: string) {
    const activeCredential = await this.currentCredential().catch(
      () => undefined,
    );
    if (!activeCredential) return undefined;

    let entries;
    try {
      entries = await readdir(this.accountsDirectory, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }

    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter((name) => ACCOUNT_NAME_PATTERN.test(name));

    for (const name of names) {
      if (name === targetName) continue;
      const savedCredential = await this.readSavedCredential(name).catch(
        () => undefined,
      );
      if (
        savedCredential !== undefined &&
        credentialsMatch(
          { credential: activeCredential },
          { credential: savedCredential },
        )
      ) {
        return name;
      }
    }
    return undefined;
  }

  /** Switch Pi's OpenAI Codex credential to the saved account. */
  async switchTo(name: string) {
    const savedCredential = await this.readSavedCredential(name);

    await withAuthStoreLock(this.authPath, async () => {
      const { contents } = await readEntries(this.authPath).catch(() => ({
        contents: Buffer.from("{}", "utf8"),
      }));
      const entries = parseEntries(contents, this.authPath);
      entries[PROVIDER_ID] = savedCredential;
      await atomicWrite(
        this.authPath,
        Buffer.from(`${JSON.stringify(entries, null, 2)}\n`, "utf8"),
      );
    });
  }
}