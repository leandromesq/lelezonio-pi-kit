/**
 * Redirects `@earendil-works/pi-coding-agent` to a specific installed entry
 * module, so `node --import` makes the shared child-session tests bind to the
 * runtime the user installed instead of the local devDependency.
 *
 *   PI_INSTALLED_RUNTIME_INDEX        installed dist/index.js (required)
 *   PI_INSTALLED_RUNTIME_VERSION      version string for the proof (optional)
 *   PI_INSTALLED_RUNTIME_PROOF_FILE   JSONL proof records (optional)
 *
 * The loader verifies its redirect with `import.meta.resolve` and emits proof
 * to stderr plus, when requested, `{version,index,resolved}` JSONL records.
 */

import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const index = process.env.PI_INSTALLED_RUNTIME_INDEX;
if (!index) {
  throw new Error(
    "pi-installed-runtime-loader: PI_INSTALLED_RUNTIME_INDEX must point at " +
      "the installed @earendil-works/pi-coding-agent entry module",
  );
}
const indexUrl = pathToFileURL(path.resolve(index)).href;
const version = process.env.PI_INSTALLED_RUNTIME_VERSION || null;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === PI_PACKAGE_NAME) {
      return { url: indexUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const resolved = import.meta.resolve(PI_PACKAGE_NAME);
if (resolved !== indexUrl) {
  throw new Error(
    "pi-installed-runtime-loader: redirect did not take effect " +
      `(resolved ${resolved}, expected ${indexUrl})`,
  );
}

const proofFile = process.env.PI_INSTALLED_RUNTIME_PROOF_FILE;
if (proofFile) {
  try {
    appendFileSync(
      proofFile,
      `${JSON.stringify({ version, index, resolved })}\n`,
    );
  } catch {
    // Proof is best-effort; the parent reports a missing file clearly.
  }
}

process.stderr.write(
  `# pi-installed-runtime: ${PI_PACKAGE_NAME}@${version ?? "unknown"}\n` +
    `# pi-installed-runtime-index: ${index}\n` +
    `# pi-installed-runtime-resolve: ${resolved}\n`,
);
