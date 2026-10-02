// Cold extension-loader benchmark only: no session_start, model calls, SSH,
// credentials, or daemon handshakes. Not a full interactive CLI benchmark.
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--child") {
  const start = performance.now();
  const { DefaultResourceLoader, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const imported = performance.now();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: resolve(fileURLToPath(new URL("..", import.meta.url))),
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
    noExtensions: true,
    additionalExtensionPaths: process.argv.slice(3),
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload({ projectTrusted: false });
  const result = loader.getExtensions();
  console.log(
    JSON.stringify({
      importMs: Math.round(imported - start),
      loadMs: Math.round(performance.now() - imported),
      extensions: result.extensions.length,
      errors: result.errors,
    }),
  );
  process.exit(result.errors.length ? 1 : 0);
} else {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const extensions = readdirSync(resolve(root, "extensions"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, "extensions", entry.name, "index.ts"))
    .filter(existsSync);
  const cases = [
    ["baseline", []],
    ["kit (without optional packages)", extensions],
    ...[
      "subagents",
      "git-info",
      "background-terminals",
      "workflows",
      "browser",
    ].map((name) => [name, [resolve(root, "extensions", name, "index.ts")]]),
  ];
  console.log(
    "Cold loader only; session_start and interactive rendering are not measured.",
  );
  for (const [label, paths] of cases) {
    const samples = [];
    for (let run = 0; run < 3; run++) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--child", ...paths],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      if (child.status !== 0)
        throw new Error(
          `${label}: ${child.error ?? child.stderr ?? "failed"}\n${child.stdout}`,
        );
      samples.push(JSON.parse(child.stdout.trim().split("\n").at(-1)));
    }
    console.log(JSON.stringify({ label, samples }));
  }
}
