#!/usr/bin/python3
"""Stable JSON/stdin adapter around Herdr's CLI for the Pi remote extension."""

import json
from pathlib import Path
import subprocess
import sys
import time

PROTOCOL = 1
HERDR = "/usr/local/bin/herdr"
GIT = "/usr/bin/git"


def run(*args: str):
    process = subprocess.run(
        [HERDR, *args],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=310,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or process.stdout.strip() or f"herdr exited {process.returncode}")
    output = process.stdout.strip()
    return json.loads(output) if output else None


def result(payload):
    if isinstance(payload, dict) and "result" in payload:
        return payload["result"]
    return payload


def extract_session_result(session_path: str):
    path = Path(session_path).expanduser().resolve()
    sessions_root = (Path.home() / ".pi" / "agent" / "sessions").resolve()
    if path != sessions_root and sessions_root not in path.parents:
        raise ValueError("agent session path is outside Pi's sessions directory")

    final_text = ""
    with path.open("r", encoding="utf-8") as session:
        for raw_line in session:
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") != "message":
                continue
            message = entry.get("message", {})
            if message.get("role") != "assistant":
                continue
            content = message.get("content", [])
            if isinstance(content, str):
                text = content
            else:
                text = "\n".join(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                )
            if text.strip():
                final_text = text.strip()
    if not final_text:
        raise ValueError("no finalized assistant text found in remote Pi session")
    return {"text": final_text, "sessionPath": str(path)}


def handle(request):
    action = request.get("action")
    if action == "ping":
        status = subprocess.run([HERDR, "status", "server"], capture_output=True, text=True, timeout=10)
        return {"protocol": PROTOCOL, "ok": status.returncode == 0, "status": status.stdout.strip()}
    if action == "list":
        return result(run("agent", "list"))
    if action == "get":
        return result(run("agent", "get", request["target"]))
    if action == "read":
        process = subprocess.run(
            [HERDR, "agent", "read", request["target"], "--source", "recent-unwrapped", "--lines", str(request.get("lines", 200)), "--format", "text"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if process.returncode != 0:
            raise RuntimeError(process.stderr.strip() or f"herdr read exited {process.returncode}")
        return {"text": process.stdout}
    if action == "path_info":
        path = Path(request["path"]).expanduser()
        exists = path.is_dir()
        is_git = False
        if exists:
            check = subprocess.run(
                [GIT, "-C", str(path), "rev-parse", "--show-toplevel"],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=10,
            )
            is_git = check.returncode == 0 and Path(check.stdout.strip()).resolve() == path.resolve()
        return {"exists": exists, "isGitRepository": is_git}
    if action == "clone":
        root = Path(request["projectsRoot"]).expanduser().resolve()
        destination = Path(request["destination"]).expanduser().resolve()
        if destination.parent != root:
            raise ValueError("clone destination must be a direct child of projectsRoot")
        if destination.exists():
            raise ValueError("clone destination already exists")
        root.mkdir(parents=True, exist_ok=True)
        process = subprocess.run(
            [GIT, "clone", "--", request["origin"], str(destination)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=310,
        )
        if process.returncode != 0:
            raise RuntimeError(process.stderr.strip() or f"git clone exited {process.returncode}")
        return {"path": str(destination), "output": process.stdout.strip()}
    if action == "result":
        info = result(run("agent", "get", request["target"]))
        session = info.get("agent", {}).get("agent_session")
        if not isinstance(session, dict) or session.get("kind") != "path" or not session.get("value"):
            raise ValueError("remote agent does not expose a Pi session path")
        return extract_session_result(session["value"])
    if action == "prompt":
        text = request["text"]
        if text.startswith("-"):
            text = "\n" + text
        return result(run("agent", "prompt", request["target"], text))
    if action == "cancel":
        return result(run("agent", "send-keys", request["target"], "ctrl+c"))
    if action == "close":
        return result(run("workspace", "close", request["workspaceId"]))
    if action == "start":
        workspace = result(run("workspace", "create", "--cwd", request["cwd"], "--label", request["name"], "--no-focus"))
        workspace_id = workspace["workspace"]["workspace_id"]
        pane_id = workspace["root_pane"]["pane_id"]
        try:
            started = None
            for attempt in range(60):
                try:
                    started = result(run("agent", "start", request["name"], "--kind", "pi", "--pane", pane_id, "--timeout", "60000"))
                    break
                except RuntimeError as error:
                    if "agent_pane_busy" not in str(error) or attempt == 59:
                        raise
                    time.sleep(0.25)
            prompt = request["prompt"]
            if prompt.startswith("-"):
                prompt = "\n" + prompt
            prompted = result(run("agent", "prompt", request["name"], prompt))
            return {
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "agent": started["agent"],
                "prompted": prompted,
            }
        except Exception:
            try:
                run("workspace", "close", workspace_id)
            except Exception:
                pass
            raise
    raise ValueError(f"unknown action: {action}")


def main():
    try:
        request = json.load(sys.stdin)
        print(json.dumps({"ok": True, "result": handle(request)}, separators=(",", ":")))
    except Exception as error:
        # Protocol errors are represented in the JSON envelope. Keep the
        # transport successful so callers can parse and report the real error.
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
