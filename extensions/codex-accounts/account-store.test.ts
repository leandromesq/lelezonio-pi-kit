import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseCodexCommand } from "./index.ts";
import {
  CodexAccountStore,
  resolveCodexHome,
  validateAccountName,
} from "./src/account-store.ts";

function credentials(accountId: string, accessToken: string) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      access_token: accessToken,
      refresh_token: `refresh-${accountId}`,
    },
  };
}

async function withCodexHome(
  run: (input: { home: string; store: CodexAccountStore }) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "codex-accounts-"));
  try {
    await run({ home, store: new CodexAccountStore(home) });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeCredentials(home: string, value: unknown) {
  await writeFile(join(home, "auth.json"), JSON.stringify(value), "utf8");
}

test("resolves CODEX_HOME before the default user directory", () => {
  assert.equal(
    resolveCodexHome({ CODEX_HOME: "/custom/codex" }, "/users/example"),
    resolve("/custom/codex"),
  );
  assert.equal(
    resolveCodexHome({ CODEX_HOME: "" }, "/users/example"),
    join("/users/example", ".codex"),
  );
});

test("parses the supported command forms", () => {
  assert.deepEqual(parseCodexCommand(""), { action: "select" });
  assert.deepEqual(parseCodexCommand(" save work "), {
    action: "save",
    name: "work",
  });
  assert.throws(() => parseCodexCommand("work"), /Usage/);
  assert.throws(() => parseCodexCommand("save two names"), /Usage/);
});

test("rejects account names that could escape the account directory", () => {
  assert.equal(
    validateAccountName("work-2_personal.test"),
    "work-2_personal.test",
  );
  assert.throws(() => validateAccountName("../auth"), /Account names/);
  assert.throws(() => validateAccountName("name with spaces"), /Account names/);
});

test("saves, lists, and switches Codex credentials", async () => {
  await withCodexHome(async ({ home, store }) => {
    const personal = credentials("personal-id", "personal-token");
    const work = credentials("work-id", "work-token");

    await writeCredentials(home, personal);
    await store.save("personal");
    await writeCredentials(home, work);
    await store.save("work");

    assert.deepEqual(await store.list(), [
      { name: "personal", active: false },
      { name: "work", active: true },
    ]);

    await store.switchTo("personal");
    assert.deepEqual(
      JSON.parse(await readFile(join(home, "auth.json"), "utf8")),
      personal,
    );
    assert.deepEqual(await store.list(), [
      { name: "personal", active: true },
      { name: "work", active: false },
    ]);
  });
});

test("recognizes the current account after Codex refreshes its tokens", async () => {
  await withCodexHome(async ({ home, store }) => {
    await writeCredentials(home, credentials("same-account", "old-token"));
    await store.save("primary");
    await writeCredentials(home, credentials("same-account", "new-token"));

    assert.deepEqual(await store.list(), [{ name: "primary", active: true }]);
  });
});

test("requires explicit overwrite and valid credential JSON", async () => {
  await withCodexHome(async ({ home, store }) => {
    await writeCredentials(home, credentials("first", "token"));
    await store.save("primary");
    await assert.rejects(() => store.save("primary"), /already exists/);

    await writeFile(join(home, "auth.json"), "not-json", "utf8");
    await assert.rejects(
      () => store.save("broken"),
      /credentials are not valid JSON/,
    );
  });
});

test("detects a duplicate identity saved under another name", async () => {
  await withCodexHome(async ({ home, store }) => {
    const primary = credentials("same-account", "token-a");
    const other = credentials("other-account", "token-b");

    await writeCredentials(home, primary);
    await store.save("work");
    await writeCredentials(home, other);
    await store.save("personal");

    // Current is "personal" (other-account). Called from its own name it is
    // excluded, and work holds a different identity -> nothing matches.
    assert.equal(await store.findCurrentIdentityName("personal"), undefined);
    // Without exclusion the current identity resolves to its own account.
    assert.equal(await store.findCurrentIdentityName(), "personal");

    // Re-save the SAME identity under a new name -> match.
    await writeCredentials(home, primary);
    assert.equal(await store.findCurrentIdentityName("backup"), "work");
    // Excluding the matching name hides it.
    assert.equal(await store.findCurrentIdentityName("work"), undefined);
    // No accounts directory at all -> undefined.
    const empty = new CodexAccountStore(join(home, "does-not-exist"));
    assert.equal(await empty.findCurrentIdentityName(), undefined);
  });
});
