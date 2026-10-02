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
const AUTH_FILE_NAME = "auth.json";
const SETTINGS_FILE_NAME = "settings.json";
const ACCOUNTS_DIRECTORY_NAME = "codex-accounts";
const SNAPSHOT_VERSION = 2;
const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claim namespace used by OpenAI's OAuth access tokens.
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/**
 * Providers `/codex` can snapshot, in selection priority order. The modern
 * `openai` provider ("Sign in with ChatGPT") wins over the legacy
 * `openai-codex` provider when both hold a credential.
 */
export const SUPPORTED_PROVIDERS = ["openai", "openai-codex"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const PROVIDER_LABELS: Record<SupportedProvider, string> = {
  openai: "OpenAI (ChatGPT)",
  "openai-codex": "OpenAI Codex (legacy)",
};

export function providerLabel(provider: SupportedProvider) {
  return PROVIDER_LABELS[provider];
}

export function isSupportedProvider(
  value: unknown,
): value is SupportedProvider {
  return (
    typeof value === "string" &&
    (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Deterministic selection when more than one supported provider is logged in:
 * the modern `openai` ("Sign in with ChatGPT") provider always wins over the
 * legacy `openai-codex` provider. `list()` still marks every saved account of
 * every logged-in provider as current, so both logins remain usable.
 */
export function selectCurrentProvider(
  providers: Iterable<SupportedProvider>,
): SupportedProvider | undefined {
  const present = new Set(providers);
  return SUPPORTED_PROVIDERS.find((provider) => present.has(provider));
}

type CredentialRecord = {
  type?: unknown;
  accountId?: unknown;
  access?: unknown;
} & Record<string, unknown>;

/** Provider-specific, non-secret metadata kept alongside a saved credential. */
export type SnapshotMetadata = {
  /**
   * Global installation device ID (`settings.json`) captured when an `openai`
   * account was saved. OpenAI's ChatGPT login binds tokens to this host ID.
   */
  deviceId?: string;
};

/** A saved account snapshot after normalization (legacy files upgrade in memory). */
export type SavedAccount = {
  provider: SupportedProvider;
  credential: CredentialRecord;
  metadata: SnapshotMetadata;
  /** True when the file used the pre-1.0 raw-credential format. */
  legacy: boolean;
};

export type CodexAccount = {
  name: string;
  active: boolean;
  provider: SupportedProvider;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntries(contents: Buffer, path: string) {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`Pi auth store is not valid JSON: ${path}`);
  }

  if (!isRecord(value)) {
    throw new Error(`Pi auth store must contain a JSON object: ${path}`);
  }

  return value;
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

/**
 * The stored OAuth credential for one supported provider, if any. The modern
 * `openai` provider also accepts API keys; those are not ChatGPT accounts and
 * are deliberately ignored by save/list/switch.
 */
function providerCredential(
  entries: Record<string, unknown>,
  provider: SupportedProvider,
) {
  const entry = entries[provider];
  return isRecord(entry) && entry.type === "oauth"
    ? (entry as CredentialRecord)
    : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const value: unknown = JSON.parse(decoded);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable account identity used to detect the current account across token
 * refreshes. Legacy `openai-codex` credentials carry an `accountId`; the new
 * `openai` ChatGPT credential does not, so fall back to the OAuth access
 * token's `https://api.openai.com/auth` claim (or its `sub`).
 */
function credentialIdentity(credential: CredentialRecord) {
  if (typeof credential.accountId === "string" && credential.accountId) {
    return `account:${credential.accountId}`;
  }

  if (typeof credential.access === "string" && credential.access) {
    const payload = decodeJwtPayload(credential.access);
    const auth = payload?.[JWT_CLAIM_PATH];
    const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
    if (typeof accountId === "string" && accountId) {
      return `account:${accountId}`;
    }
    const subject = payload?.sub;
    if (typeof subject === "string" && subject) return `subject:${subject}`;
  }

  return undefined;
}

function credentialsMatch(first: CredentialRecord, second: CredentialRecord) {
  const firstIdentity = credentialIdentity(first);
  const secondIdentity = credentialIdentity(second);
  if (firstIdentity && secondIdentity) return firstIdentity === secondIdentity;
  return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * Normalize a snapshot file. Pre-1.0 files stored the raw `openai-codex`
 * credential; v2 files wrap the credential with its provider and any
 * provider-specific metadata.
 */
function normalizeSnapshot(
  value: Record<string, unknown>,
  path: string,
): SavedAccount {
  if (value.version !== undefined || value.provider !== undefined) {
    if (!isSupportedProvider(value.provider)) {
      throw new Error(
        `Saved account has unsupported provider "${String(value.provider)}": ${path}`,
      );
    }
    if (!isRecord(value.credential)) {
      throw new Error(`Saved account is missing its credential: ${path}`);
    }
    const metadata = isRecord(value.metadata) ? value.metadata : {};
    const deviceId =
      typeof metadata.deviceId === "string" &&
      DEVICE_ID_PATTERN.test(metadata.deviceId)
        ? metadata.deviceId
        : undefined;
    return {
      provider: value.provider,
      credential: value.credential as CredentialRecord,
      metadata: deviceId ? { deviceId } : {},
      legacy: false,
    };
  }

  if (typeof value.type === "string") {
    return {
      provider: "openai-codex",
      credential: value as CredentialRecord,
      metadata: {},
      legacy: true,
    };
  }

  throw new Error(`Saved account is not a recognised snapshot: ${path}`);
}

function serializeSnapshot(account: SavedAccount) {
  // Keep legacy `openai-codex` snapshots in the pre-1.0 raw format so files
  // stay byte-compatible with older tooling and with accounts saved before
  // the `openai` provider existed.
  if (
    account.provider === "openai-codex" &&
    Object.keys(account.metadata).length === 0
  ) {
    return `${JSON.stringify(account.credential, null, 2)}\n`;
  }

  return `${JSON.stringify(
    {
      version: SNAPSHOT_VERSION,
      provider: account.provider,
      ...(Object.keys(account.metadata).length > 0
        ? { metadata: account.metadata }
        : {}),
      credential: account.credential,
    },
    null,
    2,
  )}\n`;
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
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
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

  private get settingsPath() {
    return join(this.agentDir, SETTINGS_FILE_NAME);
  }

  private get accountsDirectory() {
    return join(this.agentDir, ACCOUNTS_DIRECTORY_NAME);
  }

  private accountPath(name: string) {
    return join(this.accountsDirectory, `${validateAccountName(name)}.json`);
  }

  /** auth.json entries, or undefined when the file does not exist yet. */
  private async readAuthEntries() {
    try {
      const { entries } = await readEntries(this.authPath);
      return entries;
    } catch (error) {
      if (error instanceof AuthStoreNotFoundError) return undefined;
      throw error;
    }
  }

  /** Every supported provider that currently has a stored credential. */
  private async currentCredentials() {
    const entries = await this.readAuthEntries();
    const found = new Map<SupportedProvider, CredentialRecord>();
    if (!entries) return found;

    for (const provider of SUPPORTED_PROVIDERS) {
      const credential = providerCredential(entries, provider);
      if (credential) found.set(provider, credential);
    }
    return found;
  }

  /**
   * Provider of the credential `/codex save` would snapshot right now, or
   * undefined when no supported provider is logged in.
   */
  async currentProviders(): Promise<SupportedProvider[]> {
    const current = await this.currentCredentials();
    return SUPPORTED_PROVIDERS.filter((provider) => current.has(provider));
  }

  /**
   * Provider `/codex save` snapshots when several are logged in. See
   * {@link selectCurrentProvider} for the precedence rule.
   */
  async currentProvider(): Promise<SupportedProvider | undefined> {
    return selectCurrentProvider(await this.currentProviders());
  }

  /**
   * Credential currently logged in for `provider`, or the highest-priority
   * supported provider when none is given. Undefined when the auth store does
   * not exist. Parse/storage errors propagate.
   */
  async currentCredential(provider?: SupportedProvider) {
    const current = await this.currentCredentials();
    const selected = provider ?? selectCurrentProvider(current.keys());
    return selected ? current.get(selected) : undefined;
  }

  async hasCurrentCredentials() {
    return (await this.currentProvider()) !== undefined;
  }

  /**
   * Global installation device ID from `settings.json`. OpenAI's ChatGPT login
   * sends it as the agent host ID, so `openai` snapshots record it as
   * provider-specific metadata. Best effort: missing or malformed settings are
   * never an error here.
   */
  async globalDeviceId(): Promise<string | undefined> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.settingsPath, "utf8"),
      );
      if (
        isRecord(parsed) &&
        typeof parsed.deviceId === "string" &&
        DEVICE_ID_PATTERN.test(parsed.deviceId)
      ) {
        return parsed.deviceId;
      }
    } catch {
      // settings.json is optional metadata for this extension.
    }
    return undefined;
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

  /**
   * Snapshot the current credential under `name`. Returns the provider that
   * was saved so callers can report it.
   */
  async save(name: string, options: { overwrite?: boolean } = {}) {
    const path = this.accountPath(name);
    if (!options.overwrite && (await this.hasAccount(name))) {
      throw new Error(`Codex account "${name}" already exists.`);
    }

    const current = await this.currentCredentials();
    const provider = selectCurrentProvider(current.keys());
    if (!provider) {
      throw new Error(
        `Pi has no OpenAI credentials yet. Run /login (provider: ${SUPPORTED_PROVIDERS.map(
          providerLabel,
        ).join(" or ")}) first.`,
      );
    }

    const metadata: SnapshotMetadata = {};
    if (provider === "openai") {
      const deviceId = await this.globalDeviceId();
      if (deviceId) metadata.deviceId = deviceId;
    }

    await atomicWrite(
      path,
      Buffer.from(
        serializeSnapshot({
          provider,
          credential: current.get(provider) as CredentialRecord,
          metadata,
          legacy: false,
        }),
        "utf8",
      ),
    );

    return provider;
  }

  private async savedNames() {
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

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter((name) => ACCOUNT_NAME_PATTERN.test(name))
      .sort((left, right) => left.localeCompare(right));
  }

  /** Read and normalize one saved account snapshot. */
  async readSavedAccount(name: string): Promise<SavedAccount> {
    const path = this.accountPath(name);
    const { contents } = await readEntries(path);
    return normalizeSnapshot(parseEntries(contents, path), path);
  }

  async list() {
    const names = await this.savedNames();
    const current = await this.currentCredentials().catch(
      () => new Map<SupportedProvider, CredentialRecord>(),
    );

    return Promise.all(
      names.map(async (name): Promise<CodexAccount> => {
        const saved = await this.readSavedAccount(name).catch(() => undefined);
        if (!saved) return { name, active: false, provider: "openai-codex" };

        const activeCredential = current.get(saved.provider);
        return {
          name,
          active:
            activeCredential !== undefined &&
            credentialsMatch(activeCredential, saved.credential),
          provider: saved.provider,
        };
      }),
    );
  }

  /**
   * Name of an already-saved account, of the same provider, whose credential
   * matches the CURRENT credential, excluding `targetName` (typically the name
   * being saved). Returns undefined when no saved account matches.
   */
  async findCurrentIdentityName(targetName?: string) {
    const current = await this.currentCredentials().catch(
      () => new Map<SupportedProvider, CredentialRecord>(),
    );
    if (current.size === 0) return undefined;

    for (const name of await this.savedNames()) {
      if (name === targetName) continue;
      const saved = await this.readSavedAccount(name).catch(() => undefined);
      if (!saved) continue;

      const activeCredential = current.get(saved.provider);
      if (
        activeCredential !== undefined &&
        credentialsMatch(activeCredential, saved.credential)
      ) {
        return name;
      }
    }
    return undefined;
  }

  /**
   * Switch Pi to the saved account, writing only that account's provider entry
   * so credentials for the other provider (e.g. a legacy `openai-codex`
   * login) stay intact. Returns the provider that was switched.
   */
  async switchTo(name: string): Promise<SupportedProvider> {
    const saved = await this.readSavedAccount(name);

    await withAuthStoreLock(this.authPath, async () => {
      const { contents } = await readEntries(this.authPath).catch(() => ({
        contents: Buffer.from("{}", "utf8"),
      }));
      const entries = parseEntries(contents, this.authPath);
      entries[saved.provider] = saved.credential;
      await atomicWrite(
        this.authPath,
        Buffer.from(`${JSON.stringify(entries, null, 2)}\n`, "utf8"),
      );
    });

    return saved.provider;
  }
}
