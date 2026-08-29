import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseCodexCommand } from "./index.ts";
import {
  CodexAccountStore,
  resolveAgentDir,
  validateAccountName,
} from "./src/account-store.ts";

const PROVIDER = "openai-codex";

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

function authStore(openaiCodex?: unknown) {
  return {
    "opencode-go": { type: "api_key", key: "opencode-key" },
    ...(openaiCodex !== undefined ? { [PROVIDER]: openaiCodex } : {}),
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

test("saves, lists, and switches the Pi OpenAI Codex credential", async () => {
  await withAgentDir(async ({ dir, store }) => {
    const personal = credential("personal-id", "personal-token");
    const work = credential("work-id", "work-token");

    await writeAuth(dir, authStore(personal));
    await store.save("personal");
    await writeAuth(dir, authStore(work));
    await store.save("work");

    assert.deepEqual(await store.list(), [
      { name: "personal", active: false },
      { name: "work", active: true },
    ]);

    await store.switchTo("personal");
    const entries = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
    // The switch replaces only the OpenAI Codex entry and keeps other
    // providers (e.g. opencode-go) intact.
    assert.deepEqual(entries[PROVIDER], personal);
    assert.deepEqual(entries["opencode-go"], {
      type: "api_key",
      key: "opencode-key",
    });
    assert.deepEqual(await store.list(), [
      { name: "personal", active: true },
      { name: "work", active: false },
    ]);
  });
});

test("recognizes the current account after Pi refreshes its tokens", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(dir, authStore(credential("same-account", "old-token")));
    await store.save("primary");
    await writeAuth(dir, authStore(credential("same-account", "new-token")));

    assert.deepEqual(await store.list(), [{ name: "primary", active: true }]);
  });
});

test("save requires Pi credentials first and valid auth.json", async () => {
  await withAgentDir(async ({ dir, store }) => {
    // No openai-codex entry in the store.
    await writeAuth(dir, { "opencode-go": { type: "api_key", key: "k" } });
    await assert.rejects(
      () => store.save("orphan"),
      /\/login \(provider: OpenAI Codex\) first/,
    );

    await writeFile(join(dir, "auth.json"), "not-json", "utf8");
    await assert.rejects(() => store.save("broken"), /not valid JSON/);
  });
});

test("requires explicit overwrite", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(dir, authStore(credential("first", "token")));
    await store.save("primary");
    await assert.rejects(() => store.save("primary"), /already exists/);

    // Overwrite path replaces the stored snapshot.
    await writeAuth(dir, authStore(credential("second", "other-token")));
    await store.save("primary", { overwrite: true });
    assert.deepEqual(await store.list(), [{ name: "primary", active: true }]);
  });
});

test("switchTo creates the auth.json when it does not exist yet", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(dir, authStore(credential("primary-id", "token")));
    await store.save("primary");
    await rm(join(dir, "auth.json"));
    await store.switchTo("primary");
    const entries = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
    assert.equal(entries[PROVIDER].accountId, "primary-id");
  });
});

test("removes saved accounts without touching the current login", async () => {
  await withAgentDir(async ({ dir, store }) => {
    await writeAuth(dir, authStore(credential("personal-id", "personal")));
    await store.save("personal");
    await writeAuth(dir, authStore(credential("work-id", "work")));
    await store.save("work");

    await store.remove("personal");
    assert.deepEqual(await store.list(), [{ name: "work", active: true }]);

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
    await writeAuth(dir, authStore(credential("same-account", "token-a")));
    await store.save("work");
    await writeAuth(dir, authStore(credential("other-account", "token-b")));
    await store.save("personal");

    // Current is "personal" (other-account). Called from its own name it is
    // excluded, and work holds a different identity -> nothing matches.
    assert.equal(await store.findCurrentIdentityName("personal"), undefined);
    // Without exclusion the current identity resolves to its own account.
    assert.equal(await store.findCurrentIdentityName(), "personal");

    // Re-save the SAME identity under a new name -> match.
    await writeAuth(dir, authStore(credential("same-account", "token-a")));
    assert.equal(await store.findCurrentIdentityName("backup"), "work");
    // Excluding the matching name hides it.
    assert.equal(await store.findCurrentIdentityName("work"), undefined);

    // No accounts directory at all -> undefined.
    const empty = new CodexAccountStore(join(dir, "does-not-exist"));
    assert.equal(await empty.findCurrentIdentityName(), undefined);
  });
});
