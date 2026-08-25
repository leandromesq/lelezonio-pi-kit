import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexSpawnCommand } from "./src/backends/codex.ts";

test("Codex executables and POSIX shims spawn directly", () => {
  assert.deepEqual(codexSpawnCommand("/usr/local/bin/codex", "linux"), {
    command: "/usr/local/bin/codex",
    args: ["app-server", "--stdio"],
  });
  assert.deepEqual(codexSpawnCommand("C:\\tools\\codex.exe", "win32"), {
    command: "C:\\tools\\codex.exe",
    args: ["app-server", "--stdio"],
  });
});

test("Windows npm shims spawn through ComSpec", () => {
  assert.deepEqual(
    codexSpawnCommand(
      "C:\\Program Files\\nodejs\\codex.cmd",
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\codex.cmd" app-server --stdio"',
      ],
      windowsVerbatimArguments: true,
    },
  );
});

test(
  "Windows ComSpec launches a .cmd shim from a path containing spaces",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi codex spawn "));
    const shim = join(directory, "codex test.cmd");
    writeFileSync(shim, "@echo off\r\necho %*\r\n", "ascii");

    try {
      const launch = codexSpawnCommand(shim);
      const result = await new Promise<{ code: number | null; stdout: string }>(
        (resolve, reject) => {
          const child = spawn(launch.command, launch.args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            windowsVerbatimArguments: launch.windowsVerbatimArguments,
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.once("error", reject);
          child.once("close", (code) => {
            if (code !== 0) {
              reject(new Error(`shim exited ${code}: ${stderr.trim()}`));
              return;
            }
            resolve({ code, stdout });
          });
        },
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout, /app-server --stdio/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
