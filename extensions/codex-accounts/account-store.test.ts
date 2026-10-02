import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseCodexCommand } from "./index.ts";
import {
  CodexAccountStore,
  SUPPORTED_PROVIDERS,
  providerLabel,
  resolveAgentDir,
  selectCurrentProvider,
  validateAccountName,
} from "./src/account-store.ts";

const CODEX_PROVIDER = "openai-codex";
const OPENAI_PROVIDER = "openai";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEVICE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function credential(accountId: string, accessToken: string, extra = {}) {
  return {
    type: "oauth",
    accountId,
    access: accessToken,
    refresh: `refresh-${accountId}`,
    expires: 1_800_000_000_000,
    ...extra,
  };
}

function encodeSegment(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** A JWT whose `https://api.openai.com/auth` claim carries the account id. */
function chatGptAccess(accountId: string, marker: string) {
  return [
    encodeSegment({ alg: "none", typ: "JWT" }),
    encodeSegment({
      sub: `user-${accountId}`,
      jti: marker,
      [JWT_CLAIM_PATH]: { chatgpt_account_id: accountId },
    }),
    "signature",
  ].join(".");
}

/**
 * The modern `openai` ChatGPT credential: no `accountId` field, identity lives
 * in the access-token JWT claim.
 */
function openaiCredential(accountId: string, marker: string) {
  return {
    type: "oauth",
    access: chatGptAccess(accountId, marker),
    refresh: `refresh-${accountId}-${marker}`,
    expires: 1_800_000_000_000,
    clientId: "client-issued-by-openai",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ],
  };
}

function authStore(entries: Record<string, unknown> = {}) {
  return {
    "opencode-go": { type: "api_key", key: "opencode-key" },
    ...entries,
  };
}

async function withAgentDir(
  run: (input: { dir: string; store: CodexAccountStore }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "codex-accounts-"));
  try {
    await run({ dir, store: new CodexAccountStore(dir) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeAuth(dir: string, value: unknown) {
  await writeFile(join(dir, "auth.json"), JSON.stringify(value), "utf8");
}

async function writeSettings(dir: string, value: unknown) {
  await writeFile(join(dir, "settings.json"), JSON.stringify(value), "utf8");
}

async function readAuth(dir: string) {
  return JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
}

async function writeSnapshot(dir: string, name: string, value: unknown) {
  const accountsDir = join(dir, "codex-accounts");
  await mkdir(accountsDir, { recursive: true });
  await writeFile(
    join(accountsDir, `${name}.json`),
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
    "utf8",
  );
}

async function readSnapshot(dir: string, name: string) {
  return JSON.parse(
    await readFile(join(dir, "codex-accounts", `${name}.json`), "utf8"),
  );
}

test("resolves PI_CODING_AGENT_DIR before the default ~/.pi/agent", () => {
  assert.equal(
    resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom/pi" }, "/users/example"),
    resolve("/custom/pi"),
  );
  assert.equal(
    resolveAgentDir({ PI_CODING_AGENT_DIR: "" }, "/users/example"),
    join("/users/example", ".pi", "agent"),
  );
});

test("parses the supported command forms", () => {
  assert.deepEqual(parseCodexCommand(""), { action: "select" });
  assert.deepEqual(parseCodexCommand(" save work "), {
    action: "save",
    name: "work",
  });
  assert.deepEqual(parseCodexCommand("remove work"), {
    action: "remove",
    name: "work",
  });
  assert.throws(() => parseCodexCommand("work"), /Usage/);
  assert.throws(() => parseCodexCommand("save two names"), /Usage/);
  assert.throws(() => parseCodexCommand("remove"), /Usage/);
  assert.throws(() => parseCodexCommand("delete work"), /Usage/);
});

test("rejects account names that could escape the account directory", () => {
  assert.equal(
    validateAccountName("work-2_personal.test"),
    "work-2_personal.test",
  );
  assert.throws(() => validateAccountName("../auth"), /Account names/);
  assert.throws(() => validateAccountName("name with spaces"), /Account names/);
});

test("knows the supported providers and their labels", () => {
  assert.deepEqual([...SUPPORTED_PROVIDERS], [OPENAI_PROVIDER, CODEX_PROVIDER]);
  assert.equal(providerLabel(OPENAI_PROVIDER), "OpenAI (ChatGPT)");
  assert.equal(providerLabel(CODEX_PROVIDER), "OpenAI Codex (legacy)");
});

test("saves, lists, and switches the Pi OpenAI Codex credential", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const personal = credential("personal-id", "personal-token");
    const work = credential("work-id", "work-token");

    await writeAuth(dir, authStore({ [CODEX_PROVIDER]: personal }));
    assert.equal(await store.save("personal"), CODEX_PROVIDER);
    await writeAuth(dir, authStore({ [CODEX_PROVIDER]: work }));
    assert.equal(await store.save("work"), CODEX_PROVIDER);

    assert.deepEqual(await store.list(), [
      { name: "personal", active: false, provider: CODEX_PROVIDER },
      { name: "work", active: true, provider: CODEX_PROVIDER },
    ]);

    assert.equal(await store.switchTo("personal"), CODEX_PROVIDER);
    const entries = await readAuth(dir);
    // The switch replaces only the OpenAI Codex entry and keeps other
    // providers (e.g. opencode-go) intact.
    assert.deepEqual(entries[CODEX_PROVIDER], personal);
    assert.deepEqual(entries["opencode-go"], {
      type: "api_key",
      key: "opencode-key",
    });
    assert.deepEqual(await store.list(), [
      { name: "personal", active: true, provider: CODEX_PROVIDER },
      { name: "work", active: false, provider: CODEX_PROVIDER },
    ]);
  });
});

test("recognizes the current account after Pi refreshes its tokens", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(
      dir,
      authStore({
        [CODEX_PROVIDER]: credential("same-account", "old-token"),
      }),
    );
    await store.save("primary");
    await writeAuth(
      dir,
      authStore({
        [CODEX_PROVIDER]: credential("same-account", "new-token"),
      }),
    );

    assert.deepEqual(await store.list(), [
      { name: "primary", active: true, provider: CODEX_PROVIDER },
    ]);
  });
});

test("save requires Pi credentials first and valid auth.json", async () => {
  await withAgentDir(async ({ dir, store }) => {
    // No supported provider entry in the store.
    await writeAuth(dir, { "opencode-go": { type: "api_key", key: "k" } });
    await assert.rejects(
      () => store.save("orphan"),
      /Run \/login \(provider: OpenAI \(ChatGPT\) or OpenAI Codex \(legacy\)\) first/,
    );

    await writeFile(join(dir, "auth.json"), "not-json", "utf8");
    await assert.rejects(() => store.save("broken"), /not valid JSON/);
  });
});

test("ignores OpenAI API keys, which are not ChatGPT accounts", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const gpt = openaiCredential("gpt-account", "saved");
    await writeSnapshot(dir, "gpt", {
      version: 2,
      provider: OPENAI_PROVIDER,
      credential: gpt,
    });

    // An api_key entry on the openai provider is not a ChatGPT login.
    await writeAuth(dir, {
      [OPENAI_PROVIDER]: { type: "api_key", key: "sk-live" },
    });
    assert.equal(await store.hasCurrentCredentials(), false);
    assert.equal(await store.currentProvider(), undefined);
    assert.deepEqual(await store.list(), [
      { name: "gpt", active: false, provider: OPENAI_PROVIDER },
    ]);
    await assert.rejects(() => store.save("api-key"), /Run \/login/);
  });
});

test("requires explicit overwrite", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("first", "token") }),
    );
    await store.save("primary");
    await assert.rejects(() => store.save("primary"), /already exists/);

    // Overwrite path replaces the stored snapshot.
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("second", "other-token") }),
    );
    await store.save("primary", { overwrite: true });
    assert.deepEqual(await store.list(), [
      { name: "primary", active: true, provider: CODEX_PROVIDER },
    ]);
  });
});

test("switchTo creates the auth.json when it does not exist yet", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("primary-id", "token") }),
    );
    await store.save("primary");
    await rm(join(dir, "auth.json"));
    await store.switchTo("primary");
    const entries = await readAuth(dir);
    assert.equal(entries[CODEX_PROVIDER].accountId, "primary-id");
  });
});

test("removes saved accounts without touching the current login", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("personal-id", "personal") }),
    );
    await store.save("personal");
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("work-id", "work") }),
    );
    await store.save("work");

    await store.remove("personal");
    assert.deepEqual(await store.list(), [
      { name: "work", active: true, provider: CODEX_PROVIDER },
    ]);

    // Removing a missing account reports it.
    await assert.rejects(
      () => store.remove("personal"),
      /No saved Codex account/,
    );
    // Removing the active account snapshot leaves the current login intact.
    await store.remove("work");
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.currentCredential())?.accountId, "work-id");
  });
});

test("detects a duplicate identity saved under another name", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("same-account", "token-a") }),
    );
    await store.save("work");
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("other-account", "token-b") }),
    );
    await store.save("personal");

    // Current is "personal" (other-account). Called from its own name it is
    // excluded, and work holds a different identity -> nothing matches.
    assert.equal(await store.findCurrentIdentityName("personal"), undefined);
    // Without exclusion the current identity resolves to its own account.
    assert.equal(await store.findCurrentIdentityName(), "personal");

    // Re-save the SAME identity under a new name -> match.
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("same-account", "token-a") }),
    );
    assert.equal(await store.findCurrentIdentityName("backup"), "work");
    // Excluding the matching name hides it.
    assert.equal(await store.findCurrentIdentityName("work"), undefined);

    // No accounts directory at all -> undefined.
    const empty = new CodexAccountStore(join(dir, "does-not-exist"));
    assert.equal(await empty.findCurrentIdentityName(), undefined);
  });
});

// --- Migration and back-compat fixtures -------------------------------------

test("migrates a pre-1.0 raw snapshot to the legacy openai-codex provider", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const legacy = credential("legacy-id", "legacy-token");
    await writeSnapshot(dir, "legacy", legacy);

    const saved = await store.readSavedAccount("legacy");
    assert.equal(saved.provider, CODEX_PROVIDER);
    assert.equal(saved.legacy, true);
    assert.deepEqual(saved.credential, legacy);
    assert.deepEqual(saved.metadata, {});

    // Listing reports the legacy provider even when it is not logged in.
    await writeAuth(dir, authStore());
    assert.deepEqual(await store.list(), [
      { name: "legacy", active: false, provider: CODEX_PROVIDER },
    ]);

    // Switching a legacy snapshot writes the openai-codex entry.
    assert.equal(await store.switchTo("legacy"), CODEX_PROVIDER);
    assert.deepEqual((await readAuth(dir))[CODEX_PROVIDER], legacy);
  });
});

test("new openai-codex snapshots stay in the pre-1.0 raw format", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const codex = credential("codex-id", "codex-token");
    await writeAuth(dir, authStore({ [CODEX_PROVIDER]: codex }));
    await store.save("codex");

    const raw = await readSnapshot(dir, "codex");
    assert.equal(raw.version, undefined);
    assert.equal(raw.provider, undefined);
    assert.equal(raw.credential, undefined);
    assert.deepEqual(raw, codex);
  });
});

test("saves the openai ChatGPT credential with provider and deviceId metadata", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeSettings(dir, { deviceId: DEVICE_ID, theme: "dark" });
    const gpt = openaiCredential("gpt-account", "save");
    await writeAuth(dir, authStore({ [OPENAI_PROVIDER]: gpt }));

    assert.equal(await store.save("gpt"), OPENAI_PROVIDER);

    const snapshot = await readSnapshot(dir, "gpt");
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.provider, OPENAI_PROVIDER);
    assert.deepEqual(snapshot.metadata, { deviceId: DEVICE_ID });
    assert.deepEqual(snapshot.credential, gpt);
    assert.equal(await store.globalDeviceId(), DEVICE_ID);
  });
});

test("omits deviceId metadata when settings.json is missing or invalid", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const gpt = openaiCredential("gpt-account", "save");
    await writeAuth(dir, authStore({ [OPENAI_PROVIDER]: gpt }));
    await store.save("no-settings");
    let snapshot = await readSnapshot(dir, "no-settings");
    assert.equal(snapshot.metadata, undefined);
    assert.equal(await store.globalDeviceId(), undefined);

    await writeSettings(dir, { deviceId: "not-a-uuid" });
    await store.save("no-settings", { overwrite: true });
    snapshot = await readSnapshot(dir, "no-settings");
    assert.equal(snapshot.metadata, undefined);

    await writeFile(join(dir, "settings.json"), "not-json", "utf8");
    assert.equal(await store.globalDeviceId(), undefined);
  });
});

test("loads a v2 openai snapshot and switches only its provider entry", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const gpt = openaiCredential("gpt-account", "saved");
    const codex = credential("codex-id", "codex-token");
    await writeSnapshot(dir, "gpt", {
      version: 2,
      provider: OPENAI_PROVIDER,
      metadata: { deviceId: DEVICE_ID },
      credential: gpt,
    });

    // A legacy openai-codex login must survive the switch untouched.
    await writeAuth(dir, authStore({ [CODEX_PROVIDER]: codex }));
    assert.deepEqual(await store.list(), [
      { name: "gpt", active: false, provider: OPENAI_PROVIDER },
    ]);

    assert.equal(await store.switchTo("gpt"), OPENAI_PROVIDER);
    const entries = await readAuth(dir);
    assert.deepEqual(entries[OPENAI_PROVIDER], gpt);
    assert.deepEqual(entries[CODEX_PROVIDER], codex);
  });
});

test("marks an openai account active across access-token refreshes via the JWT claim", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(
      dir,
      authStore({
        [OPENAI_PROVIDER]: openaiCredential("chatgpt-account", "first"),
      }),
    );
    await store.save("primary");

    // Pi refreshed the tokens: access/refresh/expires changed, identity did not.
    await writeAuth(
      dir,
      authStore({
        [OPENAI_PROVIDER]: openaiCredential("chatgpt-account", "second"),
      }),
    );
    assert.deepEqual(await store.list(), [
      { name: "primary", active: true, provider: OPENAI_PROVIDER },
    ]);
  });
});

test("keeps identity checks scoped to the snapshot's provider", async () => {
  await withAgentDir(async ({ dir, store }) => {
    // Same account id, but the snapshot is a legacy openai-codex credential
    // while the live login is the new openai provider.
    await writeSnapshot(
      dir,
      "legacy",
      credential("shared-account", "codex-token"),
    );
    await writeAuth(
      dir,
      authStore({
        [OPENAI_PROVIDER]: openaiCredential("shared-account", "live"),
      }),
    );

    assert.deepEqual(await store.list(), [
      { name: "legacy", active: false, provider: CODEX_PROVIDER },
    ]);
    assert.equal(await store.findCurrentIdentityName(), undefined);

    // Switch the live login to the matching legacy provider -> identity match.
    await writeAuth(
      dir,
      authStore({ [CODEX_PROVIDER]: credential("shared-account", "live") }),
    );
    assert.deepEqual(await store.list(), [
      { name: "legacy", active: true, provider: CODEX_PROVIDER },
    ]);
    assert.equal(await store.findCurrentIdentityName(), "legacy");
  });
});

test("prefers openai over openai-codex when both are logged in", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const gpt = openaiCredential("gpt-account", "live");
    const codex = credential("codex-id", "codex-token");
    await writeAuth(
      dir,
      authStore({ [OPENAI_PROVIDER]: gpt, [CODEX_PROVIDER]: codex }),
    );

    assert.equal(await store.currentProvider(), OPENAI_PROVIDER);
    assert.deepEqual(await store.currentProviders(), [
      OPENAI_PROVIDER,
      CODEX_PROVIDER,
    ]);
    assert.equal(
      selectCurrentProvider([CODEX_PROVIDER, OPENAI_PROVIDER]),
      OPENAI_PROVIDER,
    );
    assert.deepEqual(await store.currentCredential(), gpt);
    assert.deepEqual(await store.currentCredential(CODEX_PROVIDER), codex);

    assert.equal(await store.save("dual"), OPENAI_PROVIDER);
    const snapshot = await readSnapshot(dir, "dual");
    assert.equal(snapshot.provider, OPENAI_PROVIDER);

    // Switching back restores openai without disturbing the codex login.
    await writeAuth(
      dir,
      authStore({
        [OPENAI_PROVIDER]: openaiCredential("gpt-account", "stale"),
        [CODEX_PROVIDER]: codex,
      }),
    );
    await store.switchTo("dual");
    const entries = await readAuth(dir);
    assert.deepEqual(entries[OPENAI_PROVIDER], gpt);
    assert.deepEqual(entries[CODEX_PROVIDER], codex);
  });
});

test("marks both logins current when openai and openai-codex snapshots coexist", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const gpt = openaiCredential("gpt-account", "live");
    const codex = credential("codex-id", "codex-token");

    // One saved snapshot per provider (the legacy one imported from disk).
    await writeSnapshot(dir, "legacy", codex);
    await writeAuth(dir, authStore({ [OPENAI_PROVIDER]: gpt }));
    await store.save("gpt");

    // Both providers are now logged in, each with its own saved snapshot.
    await writeAuth(
      dir,
      authStore({ [OPENAI_PROVIDER]: gpt, [CODEX_PROVIDER]: codex }),
    );
    assert.deepEqual(await store.list(), [
      { name: "gpt", active: true, provider: OPENAI_PROVIDER },
      { name: "legacy", active: true, provider: CODEX_PROVIDER },
    ]);

    // Switching one provider leaves the other login and snapshot active.
    await store.switchTo("legacy");
    const entries = await readAuth(dir);
    assert.deepEqual(entries[OPENAI_PROVIDER], gpt);
    assert.deepEqual(entries[CODEX_PROVIDER], codex);
    assert.deepEqual(await store.list(), [
      { name: "gpt", active: true, provider: OPENAI_PROVIDER },
      { name: "legacy", active: true, provider: CODEX_PROVIDER },
    ]);
  });
});

test("rejects v2 snapshots with an unsupported provider", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeSnapshot(dir, "weird", {
      version: 2,
      provider: "anthropic",
      credential: { type: "oauth", access: "a", refresh: "r", expires: 1 },
    });

    await assert.rejects(
      () => store.switchTo("weird"),
      /unsupported provider "anthropic"/,
    );
  });
});
