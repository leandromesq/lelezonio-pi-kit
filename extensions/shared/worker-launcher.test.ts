/**
 * End-to-end tests for the zero-dependency worker launcher: a real
 * `node worker-launcher.mjs <spec.json>` process spawning a probe program.
 * Proves raw argv round-trips byte-exact (spaces, unicode, apostrophes,
 * embedded quotes), env (incl. PI_SUBAGENT=1), cwd, exit-code forwarding,
 * and spec self-cleaning — the release blockers live spikes exposed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(
  new URL("./worker-launcher.mjs", import.meta.url),
);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "worker-launcher-test-"));
}

/** Probe script: writes argv (after the out path) + env + cwd to a file. */
function writeProbe(dir: string): string {
  const probe = path.join(dir, "argv-probe.mjs");
  fs.writeFileSync(
    probe,
    [
      "import * as fs from 'node:fs';",
      "import * as path from 'node:path';",
      "const out = process.argv[2];",
      "const data = {",
      "  argv: process.argv.slice(3),",
      "  cwd: process.cwd(),",
      "  subagent: process.env.PI_SUBAGENT ?? null,",
      "  custom: process.env.HERDR_WORKER_LAUNCHER_PROBE ?? null,",
      "};",
      "fs.writeFileSync(out, JSON.stringify(data));",
      "fs.writeFileSync(path.join(path.dirname(out), 'cwd.txt'), process.cwd());",
    ].join("\n"),
    "utf8",
  );
  return probe;
}

function writeSpec(
  dir: string,
  spec: { command: string; args: unknown[]; cwd?: string; env?: object },
): string {
  const specPath = path.join(dir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");
  return specPath;
}

test("raw argv round-trips byte-exact: spaces, unicode, apostrophes, quotes", () => {
  const dir = tempDir();
  const probe = writeProbe(dir);
  const out = path.join(dir, "out.json");
  const tricky = [
    "--name",
    "[spike · pi] native",
    "--session-dir",
    "C:\\sub agents\\sa-3",
    "日本語 プロンプト",
    "O'Neil's path",
    'a "quoted" arg',
  ];
  const specPath = writeSpec(dir, {
    command: process.execPath,
    args: [probe, out, ...tricky],
  });

  const result = spawnSync(process.execPath, [LAUNCHER, specPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(fs.readFileSync(out, "utf8"));
  // process.argv.slice(3) must be EXACTLY the tricky argv — no re-quoting,
  // no PowerShell re-parsing, no fragmentation.
  assert.deepEqual(data.argv, tricky);
});

test("env merge: PI_SUBAGENT=1 reaches the child; cwd is honored", () => {
  const dir = tempDir();
  const probe = writeProbe(dir);
  const out = path.join(dir, "out.json");
  const childCwd = path.join(dir, "nested dir");
  fs.mkdirSync(childCwd, { recursive: true });
  const specPath = writeSpec(dir, {
    command: process.execPath,
    args: [probe, out],
    cwd: childCwd,
    env: { PI_SUBAGENT: "1", HERDR_WORKER_LAUNCHER_PROBE: "yes" },
  });

  const result = spawnSync(process.execPath, [LAUNCHER, specPath], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PI_SUBAGENT: undefined },
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(data.subagent, "1");
  assert.equal(data.custom, "yes");
  assert.equal(fs.readFileSync(path.join(dir, "cwd.txt"), "utf8"), childCwd);
});

test("the spec file is deleted after a successful launch", () => {
  const dir = tempDir();
  const probe = writeProbe(dir);
  const out = path.join(dir, "out.json");
  const specPath = writeSpec(dir, {
    command: process.execPath,
    args: [probe, out],
  });
  const result = spawnSync(process.execPath, [LAUNCHER, specPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(specPath), false, "spec must be self-cleaned");
});

test("exit codes forward: a failing child exits with its code", () => {
  const dir = tempDir();
  const specPath = writeSpec(dir, {
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
  });
  const result = spawnSync(process.execPath, [LAUNCHER, specPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 3);
});

test("missing/unreadable spec exits 2 with a diagnostic", () => {
  const result = spawnSync(process.execPath, [LAUNCHER, "nope.json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read launch spec/);

  const dir = tempDir();
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json", "utf8");
  const broken = spawnSync(process.execPath, [LAUNCHER, bad], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /cannot read launch spec/);
});

test("no argv at all exits 2 with usage", () => {
  const result = spawnSync(process.execPath, [LAUNCHER], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node worker-launcher/);
});
