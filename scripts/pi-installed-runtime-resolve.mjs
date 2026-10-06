/**
 * Locate the *installed* Pi runtime (the `pi` CLI's package), never the copy
 * this repository pins as a devDependency. Detection: explicit
 * `PI_INSTALLED_RUNTIME_PATH`, then a `PATH` scan for `pi` (symlink or npm
 * `.cmd`/`.ps1`/POSIX shim). Candidates inside `<projectRoot>/node_modules`
 * are rejected, so `npm run`'s prepended `node_modules/.bin` cannot
 * masquerade as the install. Unusual layouts go through the explicit override.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const OVERRIDE_ENV = "PI_INSTALLED_RUNTIME_PATH";

/** Thrown when `PI_INSTALLED_RUNTIME_PATH` is set but unusable. */
export class InstalledRuntimeOverrideError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstalledRuntimeOverrideError";
  }
}

const MAX_SHIM_BYTES = 100_000;

function statType(candidate) {
  try {
    return statSync(candidate);
  } catch {
    return null;
  }
}

function isFile(candidate) {
  return statType(candidate)?.isFile() ?? false;
}

function isDirectory(candidate) {
  return statType(candidate)?.isDirectory() ?? false;
}

function readManifest(packageRoot) {
  try {
    return JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

/** Walk up from a file or directory to the nearest Pi package root. */
export function packageRootFromPath(candidate) {
  if (!candidate) return null;
  let current;
  try {
    current = realpathSync(candidate);
  } catch {
    current = path.resolve(candidate);
  }
  if (!isDirectory(current)) current = path.dirname(current);
  for (;;) {
    if (readManifest(current)?.name === PI_PACKAGE_NAME) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Extract the CLI entry an npm `.cmd`/`.ps1`/POSIX shim points at. */
function parseNpmShimCliPath(shimPath, contents) {
  const match = contents.match(
    /((?:\.\.[\\/])*(?:node_modules[\\/])?)@earendil-works[\\/]+pi-coding-agent[\\/][^\s"'\r\n)]+/,
  );
  if (!match) return null;
  const relative = match[0].replace(/[\\/]+/g, path.sep);
  return path.resolve(path.dirname(shimPath), relative);
}

/** True when `packageRoot` lives under `<projectRoot>/node_modules`. */
function isProjectLocalDependency(packageRoot, projectRoot) {
  const nodeModules = path.join(path.resolve(projectRoot), "node_modules");
  const relative = path.relative(nodeModules, path.resolve(packageRoot));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function tryBuildRuntime(packageRoot, source) {
  const manifest = readManifest(packageRoot);
  if (manifest?.name !== PI_PACKAGE_NAME) return null;
  const entry = manifest.exports?.["."];
  const relativeIndex =
    typeof entry === "string"
      ? entry
      : (entry?.import ?? entry?.default ?? manifest.main ?? "./dist/index.js");
  if (typeof relativeIndex !== "string") return null;
  const index = path.resolve(packageRoot, relativeIndex);
  if (!isFile(index)) return null;
  return {
    packageRoot,
    version: String(manifest.version ?? "unknown"),
    index,
    source,
  };
}

function candidatesFromPath(env, platform) {
  const raw =
    platform === "win32" ? (env.PATH ?? env.Path ?? "") : (env.PATH ?? "");
  const names =
    platform === "win32"
      ? ["pi.cmd", "pi.exe", "pi.ps1", "pi.bat", "pi"]
      : ["pi"];
  const seen = new Set();
  const candidates = [];
  for (const directory of raw
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (seen.has(candidate) || !isFile(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

function runtimeFromExecutable(executable, source) {
  let real = executable;
  try {
    real = realpathSync(executable);
  } catch {
    // Not a symlink or unreadable; resolve it as-is below.
  }
  const directRoot = packageRootFromPath(real);
  if (directRoot) {
    return { root: directRoot, runtime: tryBuildRuntime(directRoot, source) };
  }
  // npm/scoop shims: a small text wrapper naming the CLI entry.
  if ((statType(executable)?.size ?? 0) > MAX_SHIM_BYTES) return null;
  try {
    const cli = parseNpmShimCliPath(
      executable,
      readFileSync(executable, "utf8"),
    );
    if (!cli) return null;
    const root = packageRootFromPath(cli);
    return root ? { root, runtime: tryBuildRuntime(root, source) } : null;
  } catch {
    return null;
  }
}

/**
 * @returns `{ ok: true, packageRoot, index, version, source, explicit }` or
 *   `{ ok: false, reason, searched, localCandidates }`.
 *   Throws `InstalledRuntimeOverrideError` for a bad explicit override.
 */
export function findInstalledRuntime({
  env = process.env,
  platform = process.platform,
  projectRoot = process.cwd(),
} = {}) {
  const searched = [];
  const override = (env[OVERRIDE_ENV] ?? "").trim();
  if (override) {
    const absolute = path.resolve(projectRoot, override);
    const root = existsSync(absolute) ? packageRootFromPath(absolute) : null;
    const runtime = root ? tryBuildRuntime(root, "override") : null;
    if (!runtime) {
      throw new InstalledRuntimeOverrideError(
        `${OVERRIDE_ENV}=${override} is not a usable Pi installation; expected ` +
          "a package directory, package.json, dist/index.js, or " +
          "dist/bundle/cli.js. A bundled build without an importable SDK " +
          "entry cannot be smoke-tested.",
      );
    }
    return { ok: true, ...runtime, explicit: true, searched };
  }

  const localCandidates = [];
  const sdkUnavailable = [];
  for (const executable of candidatesFromPath(env, platform)) {
    searched.push(`path:${executable}`);
    const candidate = runtimeFromExecutable(executable, `path:${executable}`);
    if (!candidate) continue;
    if (isProjectLocalDependency(candidate.root, projectRoot)) {
      localCandidates.push(candidate.root);
    } else if (candidate.runtime) {
      return { ok: true, ...candidate.runtime, explicit: false, searched };
    } else {
      sdkUnavailable.push(candidate.root);
    }
  }

  return {
    ok: false,
    reason:
      localCandidates.length > 0
        ? `only a project-local Pi dependency was found (${localCandidates.join(
            ", ",
          )}); refusing to treat it as the installed runtime`
        : sdkUnavailable.length > 0
          ? `installed Pi at ${sdkUnavailable.join(", ")} has no importable SDK entry; use ${OVERRIDE_ENV} with a full SDK installation`
          : `no installed ${PI_PACKAGE_NAME} package found`,
    searched,
    localCandidates,
  };
}
