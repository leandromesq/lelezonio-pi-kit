import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { RemoteAgentsConfig } from "./src/config.ts";
import { remoteToolPathPrologue, SshTransport } from "./src/transport.ts";

/**
 * `ssh host <command>` runs that command through the account's login shell,
 * which is not necessarily POSIX. The homelab host runs fish, where
 * `temporary='x'.$$` and `export PATH=…` are syntax errors, so the helper
 * upload never reached a shell that could run it and every remote job ended up
 * permanently unreachable. Routing the scripts through `sh` keeps them
 * independent of the login shell.
 */
test(
  "remote helper scripts are executed through sh, not the login shell",
  {
    skip:
      process.platform === "win32"
        ? "Requires a POSIX shebang executable fixture"
        : false,
  },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "remote-transport-login-shell-test-"),
    );
    const log = path.join(directory, "ssh.log");
    const ssh = path.join(directory, "fake-ssh.sh");
    fs.writeFileSync(
      ssh,
      [
        "#!/bin/sh",
        // The remote command is the last argv element; log only that. Keep it
        // on one line so multi-line scripts still count as one SSH invocation.
        "for last; do :; done",
        'printf "%s\\n" "$last" | tr "\\n" " " >> "$FAKE_SSH_LOG"',
        'printf "\\n" >> "$FAKE_SSH_LOG"',
        // Drain the payload the transport pipes to stdin.
        "cat > /dev/null",
        'n=$(wc -l < "$FAKE_SSH_LOG")',
        // 1: helper upload, 2: helper ping. Both must succeed for the request
        // below to reach its own helper invocation.
        'if [ "$n" -eq 1 ]; then exit 0; fi',
        'if [ "$n" -eq 2 ]; then printf \'%s\\n\' \'{"ok":true,"result":{"protocol":1,"ok":true}}\'; exit 0; fi',
        'echo "fake ssh: no route to host" >&2',
        "exit 255",
        "",
      ].join("\n"),
    );
    fs.chmodSync(ssh, 0o700);
    const previousLog = process.env.FAKE_SSH_LOG;
    process.env.FAKE_SSH_LOG = log;
    const config: RemoteAgentsConfig = {
      host: "macmini",
      sshExecutable: ssh,
      remoteHelper: path.join(directory, "helper.py"),
      projectsRoot: "/remote/Projects",
      worktreesRoot: "/remote/Worktrees",
      openRemoteUiOnSpawn: false,
      terminalExecutable: "kitty",
      pollIntervalMs: 60_000,
      maxConcurrent: 3,
    };
    try {
      const transport = new SshTransport(config);
      await assert.rejects(() => transport.request({ action: "ping" }));

      const commands = fs.readFileSync(log, "utf8").trim().split("\n");
      assert.equal(
        commands.length,
        3,
        "expected the upload, the ping, and the request",
      );
      for (const command of commands)
        assert.match(
          command,
          /^sh -c '/,
          `remote command is not routed through sh: ${command}`,
        );
      assert.match(commands[0]!, /umask 077/);
      assert.match(commands[0]!, /mv -f/);
      // Both the install ping and the follow-up request run the helper.
      assert.match(commands[1]!, /exec python3/);
      assert.match(commands[2]!, /exec python3/);
      // The helper must resolve Nix-profile tools before the legacy copy.
      for (const command of [commands[1]!, commands[2]!]) {
        assert.match(command, /\/etc\/profiles\/per-user\/\$\(id -un\)\/bin/);
        assert.ok(
          command.indexOf("/etc/profiles") <
            command.indexOf("$HOME/.local/bin"),
          `Nix profile is not ahead of the legacy bin directory: ${command}`,
        );
      }
    } finally {
      if (previousLog === undefined) delete process.env.FAKE_SSH_LOG;
      else process.env.FAKE_SSH_LOG = previousLog;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "remote tool path prefers an existing Nix profile and falls back portably",
  {
    skip:
      process.platform === "win32"
        ? "Requires a POSIX shebang executable fixture"
        : false,
  },
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "remote-transport-path-test-"),
    );
    const profileBin = path.join(directory, "profile", "bin");
    const legacyBin = path.join(directory, "legacy", "bin");
    fs.mkdirSync(profileBin, { recursive: true });
    fs.mkdirSync(legacyBin, { recursive: true });
    for (const bin of [profileBin, legacyBin]) {
      const tool = path.join(bin, "python3");
      fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(tool, 0o700);
    }
    const resolve = (profile: string) =>
      execFileSync(
        "sh",
        [
          "-c",
          `${remoteToolPathPrologue(profile, legacyBin)}; command -v python3`,
        ],
        { encoding: "utf8" },
      ).trim();
    try {
      assert.equal(resolve(profileBin), path.join(profileBin, "python3"));
      assert.equal(
        resolve(path.join(directory, "absent-profile", "bin")),
        path.join(legacyBin, "python3"),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
