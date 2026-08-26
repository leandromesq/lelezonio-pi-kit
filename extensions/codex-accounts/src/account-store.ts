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

const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const AUTH_FILE_NAME = "auth.json";
const ACCOUNTS_DIRECTORY_NAME = "accounts";

type Credentials = Record<string, unknown>;

export type CodexAccount = {
  name: string;
  active: boolean;
};

export function resolveCodexHome(
  environment = process.env,
  userHome = homedir(),
) {
  const configuredHome = environment.CODEX_HOME?.trim();
  return configuredHome ? resolve(configuredHome) : join(userHome, ".codex");
}

export function validateAccountName(name: string) {
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new Error(
      "Account names must be 1-64 characters and use only letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return name;
}

function parseCredentials(contents: Buffer, path: string) {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`Codex credentials are not valid JSON: ${path}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex credentials must contain a JSON object: ${path}`);
  }

  return value as Credentials;
}

async function readCredentials(path: string) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Codex credentials were not found at ${path}`);
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error(`Codex credentials are not a regular file: ${path}`);
  }

  const contents = await readFile(path);
  return { contents, credentials: parseCredentials(contents, path) };
}

function credentialIdentity(credentials: Credentials) {
  const tokens = credentials.tokens;
  if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
    const accountId = (tokens as Record<string, unknown>).account_id;
    if (typeof accountId === "string" && accountId) {
      return `account:${accountId}`;
    }
  }

  const apiKey = credentials.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey) return `api-key:${apiKey}`;
  return undefined;
}

function credentialsMatch(
  first: { contents: Buffer; credentials: Credentials },
  second: { contents: Buffer; credentials: Credentials },
) {
  const firstIdentity = credentialIdentity(first.credentials);
  const secondIdentity = credentialIdentity(second.credentials);
  if (firstIdentity && secondIdentity) return firstIdentity === secondIdentity;
  return first.contents.equals(second.contents);
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

export class CodexAccountStore {
  readonly codexHome: string;

  constructor(codexHome = resolveCodexHome()) {
    this.codexHome = codexHome;
  }

  private get authPath() {
    return join(this.codexHome, AUTH_FILE_NAME);
  }

  private get accountsDirectory() {
    return join(this.codexHome, ACCOUNTS_DIRECTORY_NAME);
  }

  private accountPath(name: string) {
    return join(this.accountsDirectory, `${validateAccountName(name)}.json`);
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

  async save(name: string, options: { overwrite?: boolean } = {}) {
    const path = this.accountPath(name);
    if (!options.overwrite && (await this.hasAccount(name))) {
      throw new Error(`Codex account "${name}" already exists.`);
    }

    const activeCredentials = await readCredentials(this.authPath);
    await atomicWrite(path, activeCredentials.contents);
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

    const activeCredentials = await readCredentials(this.authPath).catch(
      () => undefined,
    );

    return Promise.all(
      names.map(async (name): Promise<CodexAccount> => {
        if (!activeCredentials) return { name, active: false };

        const savedCredentials = await readCredentials(
          this.accountPath(name),
        ).catch(() => undefined);
        return {
          name,
          active:
            savedCredentials !== undefined &&
            credentialsMatch(activeCredentials, savedCredentials),
        };
      }),
    );
  }

  /** Name of an already-saved account whose credentials match the CURRENT
   * auth.json, excluding `targetName` (typically the name being saved).
   * Returns undefined when the current identity is not saved anywhere. */
  async findCurrentIdentityName(targetName?: string) {
    const activeCredentials = await readCredentials(this.authPath).catch(
      () => undefined,
    );
    if (!activeCredentials) return undefined;

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
      const savedCredentials = await readCredentials(
        this.accountPath(name),
      ).catch(() => undefined);
      if (
        savedCredentials !== undefined &&
        credentialsMatch(activeCredentials, savedCredentials)
      ) {
        return name;
      }
    }
    return undefined;
  }

  async switchTo(name: string) {
    const savedCredentials = await readCredentials(this.accountPath(name));
    await atomicWrite(this.authPath, savedCredentials.contents);
  }
}
