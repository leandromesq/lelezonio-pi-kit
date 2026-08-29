import { spawn } from "node:child_process";
import type { RemoteAgentsConfig } from "./config.ts";

export function remoteUiArguments(host: string, title: string) {
  return [
    "--detach",
    "--title",
    `Remote Herdr · ${title}`,
    "herdr",
    "--remote",
    host,
  ];
}

export function environmentWithoutHerdr(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith("HERDR_")),
  );
}

export function openRemoteUi(
  config: RemoteAgentsConfig,
  title: string,
  force = false,
) {
  if (!force && !config.openRemoteUiOnSpawn) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      config.terminalExecutable,
      remoteUiArguments(config.host, title),
      {
        detached: true,
        env: environmentWithoutHerdr(),
        stdio: "ignore",
        windowsHide: true,
      },
    );
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(true);
    });
  });
}
