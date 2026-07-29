import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LocalGitProject {
  readonly name: string;
  readonly root: string;
  readonly relativeCwd: string;
  readonly origin?: string;
}

function projectName(root: string, origin?: string) {
  const source = origin
    ? origin
        .replace(/[\\/]$/, "")
        .split(/[\\/:]/)
        .at(-1)
    : path.basename(root);
  const name = (source ?? path.basename(root)).replace(/\.git$/i, "");
  if (
    !name ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(
      `Cannot derive a safe remote project name from ${source ?? root}`,
    );
  }
  return name;
}

export async function detectLocalGitProject(cwd: string) {
  try {
    const rootResult = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", windowsHide: true },
    );
    const root = path.resolve(rootResult.stdout.trim());
    const originResult = await execFileAsync(
      "git",
      ["-C", root, "config", "--get", "remote.origin.url"],
      { encoding: "utf8", windowsHide: true },
    ).catch(() => undefined);
    const origin = originResult?.stdout.trim() || undefined;
    return {
      name: projectName(root, origin),
      root,
      relativeCwd: path.relative(root, cwd),
      origin,
    } satisfies LocalGitProject;
  } catch {
    return undefined;
  }
}

export function remoteProjectLocation(
  projectsRoot: string,
  project: LocalGitProject,
) {
  const root = `${projectsRoot.replace(/\/$/, "")}/${project.name}`;
  const relative = project.relativeCwd
    .split(path.sep)
    .filter(Boolean)
    .join("/");
  return { root, cwd: relative ? `${root}/${relative}` : root };
}
