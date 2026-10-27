#!/usr/bin/python3
"""Stable JSON/stdin adapter around Herdr's CLI for the Pi remote extension."""

import json
import hashlib
import os
from pathlib import Path
import platform
import secrets
import shutil
import subprocess
import sys
import time

PROTOCOL = 1

# `recent-unwrapped` asks Herdr for application-owned history. An agent that is
# still working inside an alternate screen cannot provide it (Herdr answers
# `agent_not_idle`), but its visible screen is still readable. Only that specific
# error may fall back; transport and real Herdr failures must stay failures.
READ_SOURCE = "recent-unwrapped"
READ_FALLBACK_SOURCE = "visible"
AGENT_NOT_IDLE = "agent_not_idle"

# Every prompt carries a random submission marker in its final line. The
# session file records it verbatim with the user message, so a result is bound
# to the exact prompt that was sent even when the same text is repeated, the
# cursor probe fails, or the prompt is queued behind another turn.
SUBMISSION_MARKER = "pi-remote-submission"


def executable(name: str, override: str):
    return os.environ.get(override) or shutil.which(name) or name


HERDR = executable("herdr", "PI_REMOTE_HERDR")
GIT = executable("git", "PI_REMOTE_GIT")


def failure_text(process):
    return process.stderr.strip() or process.stdout.strip() or f"herdr exited {process.returncode}"


def run(*args: str):
    process = subprocess.run(
        [HERDR, *args],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=310,
    )
    if process.returncode != 0:
        raise RuntimeError(failure_text(process))
    output = process.stdout.strip()
    return json.loads(output) if output else None


def message_text(message):
    content = message.get("content", [])
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict)
        and part.get("type") == "text"
        and isinstance(part.get("text"), str)
    )


def load_session_entries(path: Path):
    """Entries paired with their physical line index (append-only cursor)."""
    entries = []
    with path.open("r", encoding="utf-8") as session:
        for index, raw_line in enumerate(session):
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                entries.append((index, entry))
    return entries


def active_branch(entries):
    """Return the entries on the current session branch, oldest first.

    Pi appends every entry and links the tree with id/parentId. The last linked
    entry is the active leaf, so walking parentId avoids reading a stale
    sibling branch after /tree navigation. Sessions without ids are linear.
    """
    by_id = {
        entry["id"]: (index, entry)
        for index, entry in entries
        if isinstance(entry.get("id"), str)
    }
    leaf = None
    for index, entry in reversed(entries):
        if isinstance(entry.get("id"), str) and entry["id"] in by_id:
            leaf = (index, entry)
            break
    if leaf is None:
        return entries
    chain = []
    seen = set()
    current = leaf
    while current is not None and current[1].get("id") not in seen:
        _index, entry = current
        chain.append(current)
        seen.add(entry.get("id"))
        parent = entry.get("parentId")
        current = by_id.get(parent) if isinstance(parent, str) else None
    chain.reverse()
    return chain


def sessions_root():
    return (Path.home() / ".pi" / "agent" / "sessions").resolve()


def validated_session_path(session_path):
    path = Path(session_path).expanduser().resolve()
    root = sessions_root()
    if path != root and root not in path.parents:
        raise ValueError("agent session path is outside Pi's sessions directory")
    return path


def prepare_prompt(text):
    """The exact text handed to `herdr agent prompt`.

    A leading `-` would be parsed as a flag, so it is prefixed with a newline.
    The unique marker is what binds the prompt to its result; the digest stays
    for registries written before markers existed.
    """
    base = "\n" + text if text.startswith("-") else text
    marker = secrets.token_hex(16)
    return f"{base}\n\n<!-- {SUBMISSION_MARKER}: {marker} -->", marker


def normalize_prompt(text):
    return text.strip()


def prompt_digest(text):
    return hashlib.sha256(normalize_prompt(text).encode("utf-8")).hexdigest()


def session_cursor(target):
    """Best-effort physical line count before this prompt is sent.

    The marker is the authoritative binding; this cursor is an extra guard for
    identical repeated prompts. A genuinely new session (the file does not
    exist yet) is 0. Any probe failure yields None rather than a guessed value.
    """
    try:
        info = result(run("agent", "get", target))
    except RuntimeError:
        return None
    agent = info.get("agent") if isinstance(info, dict) else None
    session = agent.get("agent_session") if isinstance(agent, dict) else None
    if (
        not isinstance(session, dict)
        or session.get("kind") != "path"
        or not session.get("value")
    ):
        return None
    try:
        path = validated_session_path(session["value"])
    except ValueError:
        return None
    if not path.exists():
        return 0
    try:
        with path.open("rb") as handle:
            return sum(1 for _ in handle)
    except OSError:
        return None


def current_submission(entries, digest, cursor, marker):
    """Entries after the prompt that started this generation.

    Herdr settles a job once, but a follow-up prompt can be accepted while its
    user entry is still unflushed. Taking the latest recorded user message would
    then pair the new generation with the previous prompt's answer. The random
    marker embedded in the sent prompt is the authoritative anchor; the digest
    and cursor are fallbacks for older registries. No anchor match means the
    current submission is simply not in the session yet.
    """
    if not marker and not digest:
        return None
    match = None
    for index, entry in entries:
        if entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        if cursor is not None and index < cursor:
            continue
        text = message_text(message)
        if marker:
            if marker not in text:
                continue
        elif prompt_digest(text) != digest:
            continue
        match = index
    if match is None:
        return None
    submission = []
    for item in entries:
        if item[0] <= match:
            continue
        entry = item[1]
        message = entry.get("message")
        if (entry.get("type") == "message" and isinstance(message, dict)
                and message.get("role") == "user"):
            break
        submission.append(item)
    return submission


def pending_result(session_path, reason):
    """A readable session that does not yet hold this generation's answer.

    This is not success and not a transport failure: the manager keeps the run
    pending (and fails it after its grace window) instead of falling back to
    possibly stale terminal output.
    """
    return {
        "text": "",
        "sessionPath": session_path,
        "status": "pending",
        "reason": reason,
        "stopReason": None,
        "errorMessage": None,
    }


def final_assistant_message(entries):
    """The assistant message that ends the current submission, if finalized.

    A tool result after an assistant message means its turn continued, so only
    the last assistant message after every tool result counts. Non-conversation
    entries (usage, custom notifications, model changes) neither finalize nor
    invalidate a response.
    """
    candidate = None
    for _index, entry in entries:
        if entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            candidate = message
        elif role == "toolResult":
            candidate = None
    return candidate


# Pi's terminal stop reasons. Only `stop` is a complete answer: `length` is a
# truncated output-token-limit response, `toolUse`/`deferred`/`pending` are
# unfinished turns, and `error`/`aborted` are failures. Sessions predating the
# field have no stopReason; their final assistant text is the only available
# signal (documented legacy policy) and counts as a normal answer.
TRUNCATED_STOP_REASON = "length"


def classify_response(message):
    """Classify the final assistant message instead of assuming success."""
    stop_reason = message.get("stopReason")
    text = message_text(message).strip()
    error_message = message.get("errorMessage")
    if not isinstance(error_message, str):
        error_message = ""
    if stop_reason == "error":
        status = "error"
    elif stop_reason == "aborted":
        status = "aborted"
    elif stop_reason == TRUNCATED_STOP_REASON:
        status = "truncated"
    elif stop_reason is None or stop_reason == "stop":
        status = "ok"
    else:
        status = "pending"
    return {
        "text": text,
        "status": status,
        "stopReason": stop_reason if isinstance(stop_reason, str) else None,
        "errorMessage": error_message.strip()[:2000] or None,
    }


def probe_server():
    """Read-only server health; never raises and never inspects the environment."""
    try:
        process = subprocess.run(
            [HERDR, "status", "server"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {"running": False, "error": str(error)[:200]}
    output = (process.stdout or process.stderr).strip()
    fields = {}
    for line in output.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip()
    return {
        "running": process.returncode == 0 and fields.get("status") == "running",
        "version": fields.get("version"),
        "protocol": fields.get("private_protocol"),
        "compatible": fields.get("endpoint_compatible"),
    }


def probe_tool(name, command=None):
    """Report a resolved executable path/version, preferring realpath."""
    path = command if command and os.path.exists(command) else shutil.which(name)
    if not path:
        return None
    info = {"path": os.path.realpath(path)}
    try:
        process = subprocess.run(
            [path, "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return info
    output = (process.stdout or process.stderr).strip()
    if output:
        first = output.splitlines()[0].strip()
        prefix = f"{name.lower()} "
        info["version"] = (
            first[len(prefix) :].strip() if first.lower().startswith(prefix) else first
        )
    return info


def collect_preflight():
    """Read-only environment report for one spawn; no version is enforced."""
    return {
        "cwd": os.getcwd(),
        "python": {
            "path": os.path.realpath(sys.executable),
            "version": platform.python_version(),
        },
        "pi": probe_tool("pi"),
        "herdr": probe_tool("herdr", HERDR),
        "server": probe_server(),
    }


def result(payload):
    if isinstance(payload, dict) and "result" in payload:
        return payload["result"]
    return payload


def extract_session_result(session_path: str, digest=None, cursor=None, marker=None):
    path = validated_session_path(session_path)
    if not path.exists():
        return pending_result(str(path), "session-not-written")

    entries = active_branch(load_session_entries(path))
    submission = current_submission(entries, digest, cursor, marker)
    if submission is None:
        return pending_result(str(path), "prompt-not-recorded")
    message = final_assistant_message(submission)
    if message is None:
        return pending_result(str(path), "response-not-finalized")
    classified = classify_response(message)
    if classified["status"] == "ok" and not classified["text"]:
        return pending_result(str(path), "response-without-text")
    if classified["status"] == "pending":
        reason = classified["stopReason"] or "unfinished"
        return pending_result(str(path), f"response-{reason}")
    return {**classified, "sessionPath": str(path)}


def handle(request):
    action = request.get("action")
    if action == "ping":
        status = subprocess.run([HERDR, "status", "server"], capture_output=True, text=True, timeout=10)
        output = (status.stdout or status.stderr).strip()
        running = any(line.strip() == "status: running" for line in output.splitlines())
        return {"protocol": PROTOCOL, "ok": status.returncode == 0 and running, "status": output}
    if action == "list":
        return result(run("agent", "list"))
    if action == "get":
        return result(run("agent", "get", request["target"]))
    if action == "read":
        read = [
            "agent",
            "read",
            request["target"],
            "--source",
            READ_SOURCE,
            "--lines",
            str(request.get("lines", 200)),
            "--format",
            "text",
        ]
        process = subprocess.run(
            [HERDR, *read],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if process.returncode != 0 and AGENT_NOT_IDLE in failure_text(process):
            read[read.index(READ_SOURCE)] = READ_FALLBACK_SOURCE
            process = subprocess.run(
                [HERDR, *read],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=30,
            )
        if process.returncode != 0:
            raise RuntimeError(failure_text(process))
        return {"text": process.stdout}
    if action == "preflight":
        return collect_preflight()
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
        cursor = request.get("promptCursor")
        return extract_session_result(
            session["value"],
            request.get("promptDigest"),
            cursor if isinstance(cursor, int) and cursor >= 0 else None,
            request.get("promptMarker"),
        )
    if action == "prompt":
        text, marker = prepare_prompt(request["text"])
        cursor = session_cursor(request["target"])
        prompted = result(run("agent", "prompt", request["target"], text))
        return {
            **prompted,
            "promptDigest": prompt_digest(text),
            "promptMarker": marker,
            "promptCursor": cursor,
        }
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
            prompt, marker = prepare_prompt(request["prompt"])
            cursor = session_cursor(request["name"])
            prompted = result(run("agent", "prompt", request["name"], prompt))
            return {
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "agent": started["agent"],
                "prompted": prompted,
                "promptDigest": prompt_digest(prompt),
                "promptMarker": marker,
                "promptCursor": cursor,
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
