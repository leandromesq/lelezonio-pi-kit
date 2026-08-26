#!/usr/bin/env node
/**
 * Zero-dependency worker launcher for Herdr worker panes.
 *
 * Herdr panes run exactly `node <launcher> <spec.json>` — nothing else is
 * ever put on the pane command line, so PowerShell/cmd/Start-Process quoting
 * can never mangle a worker's real argv (live-proven: quoted `--name
 * '[spike · pi] native'` was fragmented into positional prompt fragments).
 *
 * The spec file is written by the backend (extensions/subagents) with the
 * worker's RAW argv — JSON keeps spaces, unicode, apostrophes, and quotes
 * byte-exact. This program just spawns it with inherited stdio, so the
 * worker TUI owns the pane's terminal:
 *
 *   {
 *     "command": "C:\\Program Files\\nodejs\\node.exe",
 *     "args": ["C:\\...\\dist\\bundle\\cli.js", "--session-dir", "..."],
 *     "cwd": "C:\\work\\proj",
 *     "env": { "PI_SUBAGENT": "1" }            // merged over the pane's env
 *   }
 *
 * The spec is deleted right after it is read ("clean specs when safe"): the
 * pane command line never depends on the file outliving the launch, and
 * half-written specs cannot leak into session storage. The backend deletes
 * leftovers on scope close as a backstop.
 *
 * No npm packages, no imports beyond node builtins — runs on any plain node.
 */

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

const specPath = process.argv[2];
if (!specPath) {
  console.error("worker-launcher: usage: node worker-launcher.mjs <spec.json>");
  process.exit(2);
}

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, "utf8"));
} catch (error) {
  console.error(
    `worker-launcher: cannot read launch spec ${specPath}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(2);
}
// The spec did its job; never leave it behind.
try {
  unlinkSync(specPath);
} catch {
  // Already gone — fine.
}

const command = spec && typeof spec.command === "string" ? spec.command : "";
if (!command) {
  console.error("worker-launcher: spec.command must be a non-empty string");
  process.exit(2);
}
const args = Array.isArray(spec.args)
  ? spec.args.filter((a) => typeof a === "string")
  : [];
const cwd = typeof spec.cwd === "string" ? spec.cwd : undefined;
const extraEnv = spec.env && typeof spec.env === "object" ? spec.env : {};
const env = { ...process.env, ...extraEnv };

const child = spawn(command, args, {
  cwd,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(
    `worker-launcher: failed to spawn ${command}: ${error.message}`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise the terminating signal so pane supervision sees the same
    // failure the child saw (SIGTERM/SIGINT are emulated on Windows).
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
    return;
  }
  process.exit(code ?? 1);
});
