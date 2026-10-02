import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, shell = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args]);
    return;
  }
  run("npm", args, process.platform === "win32");
}

run(process.execPath, ["--test", "scripts/native-search.test.mjs"]);
run(process.execPath, ["--test", "scripts/observational-memory.test.mjs"]);
runNpm(["--prefix", "vendor/pi-observational-memory", "test"]);
runNpm(["--prefix", "extensions/background-terminals", "test"]);

const extensionsDir = join(root, "extensions");
const tests = readdirSync(extensionsDir, { recursive: true })
  .filter(
    (file) =>
      typeof file === "string" &&
      file.endsWith(".test.ts") &&
      !file.startsWith(
        `background-terminals${process.platform === "win32" ? "\\" : "/"}`,
      ) &&
      !file.endsWith("codex.test.ts"),
  )
  .map((file) => join(extensionsDir, file));

// Bound file-level concurrency: SDK/loader tests spawn additional processes,
// and using every CPU oversubscribes Windows startup and timeout fixtures.
run(process.execPath, [
  "--test",
  "--test-concurrency=4",
  "--experimental-strip-types",
  ...tests,
]);
