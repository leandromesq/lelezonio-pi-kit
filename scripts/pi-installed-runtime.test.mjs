/**
 * Installed-runtime smoke tests. Proves the shared child-session security
 * tests run against the *installed* Pi runtime, not this repository's pinned
 * devDependency (detection in `pi-installed-runtime-resolve.mjs`, SDK
 * redirect in `pi-installed-runtime-loader.mjs`).
 *
 *   - runtime missing, `PI_INSTALLED_RUNTIME_REQUIRED` unset: skip explicitly
 *   - runtime missing, `PI_INSTALLED_RUNTIME_REQUIRED=1`: fail
 *   - `PI_INSTALLED_RUNTIME_PATH` invalid: always fail
 *
 * The child runs offline against a temporary agent dir with credentials
 * stripped, bounded by `PI_INSTALLED_RUNTIME_TIMEOUT_MS` (default 60000 ms;
 * non-positive/non-finite values fall back to the default).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  findInstalledRuntime,
  InstalledRuntimeOverrideError,
  OVERRIDE_ENV,
  PI_PACKAGE_NAME,
  packageRootFromPath,
} from "./pi-installed-runtime-resolve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const loaderPath = path.join(here, "pi-installed-runtime-loader.mjs");
const childTestFile = path.join(
  projectRoot,
  "extensions",
  "shared",
  "child-session.test.ts",
);
const REQUIRED_ENV = "PI_INSTALLED_RUNTIME_REQUIRED";
const TIMEOUT_ENV = "PI_INSTALLED_RUNTIME_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 60_000;
const PER_TEST_TIMEOUT_MS = 30_000;
const CLI_TAIL = path.join(
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const CREDENTIAL_KEY = /(API_KEY|_TOKEN|_SECRET|SECRET_KEY|ACCESS_KEY)/i;

/** Full test names; each doubles as its `--test-name-pattern`. */
const SMOKE_TESTS = [
  "child denylist keeps extension and workflow structured tools available",
  "native builtins are opt-in and register codemode plus tool_search",
  "narrowed SDK children load codemode alone; full children keep MCP",
  "script exposure never escapes the exclusion or allowlist",
  "codemode executes allowlisted reads and denies every other surface",
  "a narrowed child starts no configured MCP server process",
];

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2 ** 31 - 1
    ? parsed
    : fallback;
}

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-installed-runtime-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Minimal valid installed-Pi layout; the CLI file is not needed. */
async function writeFakePiPackage(packageRoot, version = "9.9.9") {
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: PI_PACKAGE_NAME,
      version,
      type: "module",
      main: "./dist/index.js",
    }),
  );
  await writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n");
}

async function writePiShim(shimPath, relativeCli) {
  await mkdir(path.dirname(shimPath), { recursive: true });
  await writeFile(
    shimPath,
    `#!/bin/sh\nexec node "$basedir/${relativeCli}" "$@"\n`,
  );
}

function packageUnder(directory) {
  return path.join(
    directory,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
}

function tapNames(output, status) {
  const pattern = new RegExp(`^${status} \\d+ - (.+)$`, "gm");
  return [...output.matchAll(pattern)].map((match) => match[1].trim());
}

function sanitizeChildEnv(overrides) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (
      CREDENTIAL_KEY.test(key) ||
      /^(AWS_|PI_SESSION_|NODE_TEST_)/.test(key) // NODE_TEST_* blocks nested --test
    ) {
      delete env[key];
    }
  }
  return env;
}

test("resolver rejects bad input and never picks the local .bin", async () => {
  await withTempDir(async (directory) => {
    const packageRoot = packageUnder(path.join(directory, "a"));
    await writeFakePiPackage(packageRoot);
    const index = path.join(packageRoot, "dist", "index.js");
    for (const candidate of [packageRoot, index]) {
      assert.equal(packageRootFromPath(candidate), packageRoot);
    }

    for (const value of [path.join(directory, "missing"), directory]) {
      assert.throws(
        () =>
          findInstalledRuntime({
            env: { [OVERRIDE_ENV]: value },
            projectRoot: directory,
          }),
        InstalledRuntimeOverrideError,
      );
    }
    const overridden = findInstalledRuntime({
      env: { [OVERRIDE_ENV]: packageRoot },
      projectRoot: directory,
    });
    assert.deepEqual(
      [overridden.ok, overridden.source, overridden.index],
      [true, "override", index],
    );

    // PATH: npm run prepends the local .bin, so detection must skip it and
    // continue to the real installation.
    const projectDir = path.join(directory, "project");
    const localRoot = packageUnder(projectDir);
    await writeFakePiPackage(localRoot, "1.0.0");
    const localBin = path.join(projectDir, "node_modules", ".bin");
    await writePiShim(path.join(localBin, "pi"), `../${CLI_TAIL}`);

    const installDir = path.join(directory, "install");
    await writeFakePiPackage(packageUnder(installDir), "7.7.7");
    const installedBin = path.join(installDir, "bin");
    const installedShim = path.join(installedBin, "pi");
    await writePiShim(installedShim, `../node_modules/${CLI_TAIL}`);

    const both = findInstalledRuntime({
      env: { PATH: [localBin, installedBin].join(":") },
      platform: "linux",
      projectRoot: projectDir,
    });
    assert.deepEqual(
      [both.ok, both.version, both.source],
      [true, "7.7.7", `path:${installedShim}`],
    );

    const localOnly = findInstalledRuntime({
      env: { PATH: localBin },
      platform: "linux",
      projectRoot: projectDir,
    });
    assert.equal(localOnly.ok, false);
    assert.match(localOnly.reason, /project-local/i);
    assert.deepEqual(localOnly.localCandidates, [localRoot]);

    // An installed package without an SDK must not be mistaken for absence.
    const sdklessPrefix = path.join(directory, "sdkless");
    const sdklessRoot = packageUnder(sdklessPrefix);
    await mkdir(sdklessRoot, { recursive: true });
    await writeFile(
      path.join(sdklessRoot, "package.json"),
      JSON.stringify({ name: PI_PACKAGE_NAME, main: "./missing.js" }),
    );
    await writePiShim(
      path.join(sdklessPrefix, "pi"),
      `node_modules/${CLI_TAIL}`,
    );
    const sdkless = findInstalledRuntime({
      env: { PATH: sdklessPrefix },
      platform: "linux",
      projectRoot: projectDir,
    });
    assert.equal(sdkless.ok, false);
    assert.match(sdkless.reason, /no importable SDK entry/);

    // The loader fails clearly when it has no entry to redirect to.
    const missing = spawnSync(
      process.execPath,
      ["--import", loaderPath, "--input-type=module", "--eval", ""],
      {
        encoding: "utf8",
        env: { ...process.env, PI_INSTALLED_RUNTIME_INDEX: "" },
      },
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /PI_INSTALLED_RUNTIME_INDEX/);
  });
});

test("timeout parsing rejects non-positive values", () => {
  for (const bad of ["0", "-5", "not-a-number", "Infinity", "0.5", "1e20"]) {
    assert.equal(positiveTimeout(bad, 1000), 1000);
  }
  assert.equal(positiveTimeout("2500", 1000), 2500);
});

test("installed Pi runtime runs the selected child-session security tests", async (t) => {
  let resolution;
  try {
    resolution = findInstalledRuntime({ projectRoot });
  } catch (error) {
    assert.fail(
      error instanceof InstalledRuntimeOverrideError
        ? `${OVERRIDE_ENV} is invalid: ${error.message}`
        : String(error?.stack ?? error),
    );
  }

  if (!resolution.ok) {
    const message =
      `installed Pi runtime unavailable: ${resolution.reason}; ` +
      `searched ${resolution.searched.join(", ")}. Set ${OVERRIDE_ENV} to a ` +
      "full npm/symlink installation, or install Pi globally.";
    if ((process.env[REQUIRED_ENV] ?? "") === "1") assert.fail(message);
    t.skip(message);
    return;
  }

  // An explicit override is trusted; auto-detection must never land on the
  // repository's own dependency.
  if (!resolution.explicit) {
    assert.equal(
      resolution.packageRoot.startsWith(
        path.join(projectRoot, "node_modules") + path.sep,
      ),
      false,
      `refusing to smoke-test the local dependency at ${resolution.packageRoot}`,
    );
  }
  t.diagnostic(
    `installed runtime: ${resolution.source} ${resolution.version} ${resolution.index}`,
  );

  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-installed-agent-"));
  const proofFile = path.join(agentDir, "runtime-proof.jsonl");
  await writeFile(proofFile, "");
  try {
    const args = [
      "--import",
      loaderPath,
      "--experimental-strip-types",
      "--test",
      "--test-reporter=tap",
      "--test-concurrency=1",
      `--test-timeout=${PER_TEST_TIMEOUT_MS}`,
      ...SMOKE_TESTS.map((name) => `--test-name-pattern=${name}`),
      childTestFile,
    ];
    const result = spawnSync(process.execPath, args, {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: positiveTimeout(process.env[TIMEOUT_ENV], DEFAULT_TIMEOUT_MS),
      maxBuffer: 32 * 1024 * 1024,
      env: sanitizeChildEnv({
        PI_INSTALLED_RUNTIME_INDEX: resolution.index,
        PI_INSTALLED_RUNTIME_VERSION: resolution.version,
        PI_INSTALLED_RUNTIME_PROOF_FILE: proofFile,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_CODING_AGENT_DIR: agentDir,
      }),
    });

    const stdout = result.stdout ?? "";
    const context =
      `\n# node ${args.join(" ")}\n` +
      `# resolution: ${resolution.source} ${resolution.version} ${resolution.index}` +
      `\n--- stdout ---\n${stdout}\n--- stderr ---\n${result.stderr ?? ""}`;
    assert.equal(result.error, undefined, `smoke run failed${context}`);
    assert.equal(result.status, 0, `smoke run exited non-zero${context}`);

    // Proof: every worker bound the SDK to the installed entry.
    const records = (await readFile(proofFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(records.length > 0, true, `no proof emitted${context}`);
    for (const record of records) {
      assert.deepEqual(
        [record.index, record.version, record.resolved],
        [
          resolution.index,
          resolution.version,
          pathToFileURL(resolution.index).href,
        ],
        context,
      );
    }

    // Proof: exactly the selected tests ran and passed.
    const passed = tapNames(stdout, "ok");
    const failed = tapNames(stdout, "not ok");
    for (const name of SMOKE_TESTS) {
      assert.equal(passed.includes(name), true, `missing ${name}${context}`);
      assert.equal(failed.includes(name), false, `failed ${name}${context}`);
    }
    assert.equal(passed.length, SMOKE_TESTS.length, context);
    assert.match(stdout, /^# fail 0$/m, context);
    assert.match(stdout, /^# skipped 0$/m, context);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
