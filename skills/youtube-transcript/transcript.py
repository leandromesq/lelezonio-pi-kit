#!/usr/bin/env python3
"""Fetch a clean English transcript of a YouTube video as JSON.

Requires Python 3.9+ and ``yt-dlp`` on PATH.

Prints JSON on stdout:

    {
      "id": "EBw7gsDPAYQ",
      "url": "https://www.youtube.com/watch?v=EBw7gsDPAYQ",
      "title": "...",
      "uploader": "...",
      "language": "en",
      "captionSource": "manual",   # "manual" (uploaded subs) or "auto" (captions)
      "transcript": [
        {"start": 0.0, "duration": 3.2, "text": "All right. So, I got this UniFi Theta"},
        ...
      ]
    }

Manually uploaded English subtitles are preferred; auto-generated captions
are used as a fallback.

Exit codes:
    2  usage error (missing/unparseable video URL)
    3  yt-dlp not found on PATH
    4  yt-dlp failed (private/deleted video, region lock, sign-in wall, ...)
    5  no English captions available for the video
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_YTDLP_MISSING = 3
EXIT_FETCH_FAILED = 4
EXIT_NO_CAPTIONS = 5

ID_RE = re.compile(r"^[\w-]{11}$")
URL_ID_RE = re.compile(
    r"(?:v=|youtu\.be/|shorts/|embed/|live/|vi/)([\w-]{11})"
)
CUE_RE = re.compile(
    r"^(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+"
    r"(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})"
)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

VTT_SKIP_PREFIXES = ("WEBVTT", "NOTE", "STYLE", "REGION", "X-TIMESTAMP-MAP")


class TranscriptError(Exception):
    """Fatal, user-reportable failure carrying a process exit code."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _force_utf8_stdio() -> None:
    """Avoid UnicodeEncodeError on Windows consoles using legacy codepages."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def ytdlp_missing_hint() -> str:
    return "\n".join(
        [
            "yt-dlp was not found on PATH.",
            "Install it, then re-run this script:",
            "  Linux:   python3 -m pip install --upgrade yt-dlp",
            "           or sudo apt install yt-dlp (Debian/Ubuntu),",
            "           or sudo pacman -S yt-dlp (Arch),",
            "           or pipx install yt-dlp",
            "  Windows: python -m pip install --upgrade yt-dlp",
            "           or winget install yt-dlp.yt-dlp",
            "Verify with: yt-dlp --version",
        ]
    )


def extract_video_id(value: str) -> str | None:
    """Normalize a video ID or URL into the 11-character video ID."""
    value = value.strip()
    if ID_RE.match(value):
        return value
    if "youtube.com" in value or "youtu.be" in value or "youtube-nocookie.com" in value:
        match = URL_ID_RE.search(value)
        if match:
            return match.group(1)
    return None


def run_ytdlp(args: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["yt-dlp", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise TranscriptError(
            EXIT_YTDLP_MISSING,
            f"Could not run yt-dlp: {exc}\n\n{ytdlp_missing_hint()}",
        ) from exc


def clean_ytdlp_error(result: subprocess.CompletedProcess[str]) -> str:
    stderr = ANSI_RE.sub("", result.stderr or "").strip()
    stdout = ANSI_RE.sub("", result.stdout or "").strip()
    return stderr or stdout or f"yt-dlp exited with code {result.returncode}"


def _en_rank(lang: str) -> int:
    """Higher is better for English subtitle selection (exact 'en' first)."""
    normalized = lang.lower()
    if normalized == "en":
        return 3
    if normalized.startswith("en"):
        if normalized in ("en-us", "en-gb", "en-ca", "en-au"):
            return 2
        return 1
    return 0


def pick_track(info: dict[str, Any]) -> tuple[str, str] | None:
    """Pick the best English caption track: manual subtitles first, then auto.

    Returns (source, language) where source is "subtitles" or
    "automatic_captions", or None when no English track exists.
    """
    for source in ("subtitles", "automatic_captions"):
        tracks = info.get(source) or {}
        candidates = [
            (lang, _en_rank(lang)) for lang in tracks if _en_rank(lang) > 0
        ]
        if candidates:
            candidates.sort(key=lambda pair: (-pair[1], pair[0]))
            return source, candidates[0][0]
    return None


def _available_languages(info: dict[str, Any]) -> str:
    lines = []
    for source, label in (
        ("subtitles", "manual subtitles"),
        ("automatic_captions", "auto captions"),
    ):
        langs = sorted((info.get(source) or {}).keys())
        lines.append(f"  {label}: {', '.join(langs) if langs else 'none'}")
    return "\n".join(lines)


def fetch_video_info(video_id: str) -> dict[str, Any]:
    result = run_ytdlp(
        ["--skip-download", "--no-playlist", "--no-warnings", "--dump-single-json", video_id]
    )
    if result.returncode != 0:
        raise TranscriptError(
            EXIT_FETCH_FAILED,
            f"yt-dlp could not fetch video {video_id}:\n{clean_ytdlp_error(result)}",
        )
    try:
        info = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise TranscriptError(
            EXIT_FETCH_FAILED,
            f"yt-dlp produced unparseable metadata for {video_id}: {exc}",
        ) from exc
    if not isinstance(info, dict) or not info.get("id"):
        raise TranscriptError(
            EXIT_FETCH_FAILED,
            f"yt-dlp returned unexpected metadata for {video_id}.",
        )
    return info


def download_caption(video_id: str, source: str, lang: str) -> str:
    """Download the chosen caption track as VTT and return its text."""
    with tempfile.TemporaryDirectory(prefix="yt-transcript-") as tmp:
        args = [
            "--skip-download",
            "--no-playlist",
            "--no-warnings",
            "--no-progress",
            "--quiet",
            "--sub-format",
            "vtt",
            "--paths",
            tmp,
        ]
        # Manual tracks need --write-subs; automatic tracks need --write-auto-subs.
        args.append("--write-subs" if source == "subtitles" else "--write-auto-subs")
        args += ["--sub-langs", lang, video_id]

        result = run_ytdlp(args)
        if result.returncode != 0:
            raise TranscriptError(
                EXIT_FETCH_FAILED,
                f"yt-dlp could not download {source} captions for '{lang}' "
                f"on {video_id}:\n{clean_ytdlp_error(result)}",
            )

        vtt_files = sorted(Path(tmp).glob("*.vtt"))
        if not vtt_files:
            raise TranscriptError(
                EXIT_FETCH_FAILED,
                f"No caption file was written for language '{lang}' on {video_id}.",
            )
        return vtt_files[0].read_text(encoding="utf-8", errors="replace")


def clean_text(raw: str) -> str:
    """Strip WebVTT markup, unescape entities, drop duplicate lines, normalize spaces."""
    text = re.sub(r"<[^>]*>", "", raw)
    text = html.unescape(text)
    text = text.replace("\u00a0", " ")  # &nbsp; etc. become regular spaces
    lines: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("- "):  # rolling-caption dash artifact
            line = line[2:].strip()
        if not line:
            continue
        if lines and line == lines[-1]:  # repeated line inside auto captions
            continue
        lines.append(line)
    return " ".join(lines)


def _to_seconds(h: str | None, m: str, s: str, ms: str) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_vtt(text: str) -> list[dict[str, Any]]:
    """Parse a WebVTT caption file into {start, duration, text} cues."""
    cues: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            current = None
            continue
        if line.startswith(VTT_SKIP_PREFIXES):
            continue
        match = CUE_RE.match(line)
        if match:
            start = _to_seconds(*match.groups()[:4])
            end = _to_seconds(*match.groups()[4:8])
            current = {"start": start, "duration": max(0.0, end - start), "text": ""}
            cues.append(current)
            continue
        if current is not None:
            cleaned = clean_text(line)
            if cleaned:
                if current["text"]:
                    current["text"] += " "
                current["text"] += cleaned

    # Drop sub-second timing-marker cues (e.g. 0.01s) that carry no speech
    # before the rolling-window dedupe below.
    cues = [cue for cue in cues if cue["duration"] >= 0.05 and cue["text"]]

    # Auto captions repeat the tail of one cue at the head of the next; drop
    # fully repeated cues and trim the overlapping words of partially repeated
    # cues.
    deduped: list[dict[str, Any]] = []
    previous_text = ""
    for cue in cues:
        text = cue["text"]
        if previous_text:
            if text in previous_text:
                continue
            trimmed = _trim_overlap(text, previous_text)
            if trimmed != text:
                if not trimmed:
                    continue
                cue["text"] = trimmed
                text = trimmed
        deduped.append(cue)
        previous_text = text
    return deduped


def _trim_overlap(text: str, previous: str) -> str:
    """Trim words of `text` that already concluded `previous`.

    YouTube auto-generated captions render a rolling window: the end of one
    cue is repeated at the start of the next. Remove that repeated tail/head.
    """
    prev_words = previous.split()
    text_words = text.split()
    if not prev_words or not text_words:
        return text
    limit = min(len(prev_words), len(text_words), 6)
    for n in range(limit, 0, -1):
        if prev_words[-n:] == text_words[:n]:
            return " ".join(text_words[n:])
    return text


def build_transcript(video_id: str) -> dict[str, Any]:
    info = fetch_video_info(video_id)

    track = pick_track(info)
    if track is None:
        raise TranscriptError(
            EXIT_NO_CAPTIONS,
            "No English captions available for video "
            f"{video_id} ('{info.get('title') or 'unknown title'}').\n"
            "Available languages:\n" + _available_languages(info),
        )
    source, lang = track

    vtt = download_caption(video_id, source, lang)
    cues = parse_vtt(vtt)
    if not cues:
        raise TranscriptError(
            EXIT_NO_CAPTIONS,
            f"The '{lang}' caption track for {video_id} contained no usable text.",
        )

    return {
        "id": info.get("id") or video_id,
        "url": info.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}",
        "title": info.get("title") or video_id,
        "uploader": info.get("uploader") or info.get("channel") or "",
        "language": lang,
        "captionSource": "manual" if source == "subtitles" else "auto",
        "transcript": cues,
    }


def selftest() -> None:
    """Offline checks for the pure helpers; no network or yt-dlp required."""
    id_cases = {
        "EBw7gsDPAYQ": "EBw7gsDPAYQ",
        "https://www.youtube.com/watch?v=EBw7gsDPAYQ": "EBw7gsDPAYQ",
        "https://youtu.be/EBw7gsDPAYQ?t=10": "EBw7gsDPAYQ",
        "https://www.youtube.com/shorts/EBw7gsDPAYQ": "EBw7gsDPAYQ",
        "https://www.youtube.com/embed/EBw7gsDPAYQ": "EBw7gsDPAYQ",
    }
    for raw, expected in id_cases.items():
        assert extract_video_id(raw) == expected, f"extract_video_id({raw!r})"
    for bad in ("", "too-short", "https://example.com/EBw7gsDPAYQ"):
        assert extract_video_id(bad) is None, f"extract_video_id({bad!r})"

    auto_only = {"subtitles": {}, "automatic_captions": {"en": [{}], "de": [{}]}}
    assert pick_track(auto_only) == ("automatic_captions", "en")
    manual_preferred = {
        "subtitles": {"en-US": [{}], "de": [{}]},
        "automatic_captions": {"en": [{}]},
    }
    assert pick_track(manual_preferred) == ("subtitles", "en-US")
    assert pick_track({"subtitles": {}, "automatic_captions": {}}) is None
    assert pick_track({"subtitles": {"de", "fr"}, "automatic_captions": {}}) is None

    assert clean_text("<c>Hello&nbsp;world</c>") == "Hello world"
    assert clean_text("- foo\n- foo\nbar") == "foo bar"

    vtt = "\n".join(
        [
            "WEBVTT",
            "",
            "1",
            "00:00:00.000 --> 00:00:03.000 align:start position:0%",
            "<v speaker>All right. So, I got this UniFi Theta camera</v>",
            "",
            "2",
            "00:00:03.000 --> 00:00:04.500",
            "camera. I took it out",
            "",
        ]
    )
    assert parse_vtt(vtt) == [
        {"start": 0.0, "duration": 3.0, "text": "All right. So, I got this UniFi Theta camera"},
        {"start": 3.0, "duration": 1.5, "text": "camera. I took it out"},
    ], parse_vtt(vtt)

    repeated = "\n".join(
        [
            "WEBVTT",
            "",
            "00:00:00.000 --> 00:00:02.000",
            "Hello world",
            "",
            "00:00:02.000 --> 00:00:04.000",
            "Hello world",
            "",
        ]
    )
    assert parse_vtt(repeated) == [
        {"start": 0.0, "duration": 2.0, "text": "Hello world"}
    ]

    rolling = "\n".join(
        [
            "WEBVTT",
            "",
            "00:00:00.000 --> 00:00:02.000",
            "Today we talk about the camera",
            "",
            "00:00:02.000 --> 00:00:04.000",
            "the camera and how it works",
            "",
        ]
    )
    assert parse_vtt(rolling) == [
        {"start": 0.0, "duration": 2.0, "text": "Today we talk about the camera"},
        {"start": 2.0, "duration": 2.0, "text": "and how it works"},
    ], parse_vtt(rolling)

    timing_marker = "\n".join(
        [
            "WEBVTT",
            "",
            "00:00:00.000 --> 00:00:00.010",
            "All right.",
            "",
            "00:00:00.010 --> 00:00:02.000",
            "All right. Let's go.",
            "",
        ]
    )
    assert parse_vtt(timing_marker) == [
        {"start": 0.01, "duration": 1.99, "text": "All right. Let's go."}
    ], parse_vtt(timing_marker)

    # Error paths and output shape with a mocked yt-dlp backend.
    global run_ytdlp  # reassigned below; restored in the finally block
    original_run_ytdlp = run_ytdlp

    class _FakeResult:
        def __init__(
            self, returncode: int, stdout: str = "", stderr: str = ""
        ) -> None:
            self.returncode = returncode
            self.stdout = stdout
            self.stderr = stderr

    try:
        # yt-dlp fails to fetch the video -> exit code 4.
        def fetch_fails(args: list[str]) -> _FakeResult:
            return _FakeResult(
                1, "", "ERROR: [youtube] XXXXXXXXXXX: Video unavailable"
            )

        run_ytdlp = fetch_fails
        try:
            fetch_video_info("XXXXXXXXXXX")
            raise AssertionError("expected TranscriptError for failed fetch")
        except TranscriptError as exc:
            assert exc.code == EXIT_FETCH_FAILED, exc.code

        # No English captions at all -> exit code 5 with the available languages.
        def no_captions(args: list[str]) -> _FakeResult:
            info = {
                "id": "XXXXXXXXXXX",
                "title": "No captions",
                "subtitles": {"de": [{}]},
                "automatic_captions": {"fr": [{}]},
            }
            return _FakeResult(0, json.dumps(info))

        run_ytdlp = no_captions
        try:
            build_transcript("XXXXXXXXXXX")
            raise AssertionError("expected TranscriptError for missing English captions")
        except TranscriptError as exc:
            assert exc.code == EXIT_NO_CAPTIONS, exc.code
            assert "de" in exc.message and "fr" in exc.message, exc.message

        # Successful manual-track fetch produces the documented JSON shape.
        def manual_ok(args: list[str]) -> _FakeResult:
            if "--dump-single-json" in args:
                info = {
                    "id": "XXXXXXXXXXX",
                    "webpage_url": "https://www.youtube.com/watch?v=XXXXXXXXXXX",
                    "title": "Test video",
                    "uploader": "Test channel",
                    "subtitles": {"en": [{}]},
                    "automatic_captions": {},
                }
                return _FakeResult(0, json.dumps(info))
            paths = args[args.index("--paths") + 1]
            vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n\n"
            (Path(paths) / "out.en.vtt").write_text(vtt, encoding="utf-8")
            return _FakeResult(0)

        run_ytdlp = manual_ok
        transcript = build_transcript("XXXXXXXXXXX")
        assert transcript["captionSource"] == "manual"
        assert transcript["language"] == "en"
        assert transcript["title"] == "Test video"
        assert transcript["uploader"] == "Test channel"
        assert transcript["url"] == "https://www.youtube.com/watch?v=XXXXXXXXXXX"
        assert transcript["transcript"] == [
            {"start": 0.0, "duration": 2.0, "text": "Hello world"}
        ]
    finally:
        run_ytdlp = original_run_ytdlp

    print("selftest: all checks passed")


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdio()

    parser = argparse.ArgumentParser(
        description="Fetch a clean English YouTube transcript as JSON "
        "(requires yt-dlp on PATH)."
    )
    parser.add_argument("video", nargs="?", help="YouTube video ID or URL")
    parser.add_argument(
        "-o",
        "--output",
        metavar="FILE",
        help="write the JSON to FILE instead of stdout",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="run offline self-checks and exit",
    )
    args = parser.parse_args(argv)

    if args.selftest:
        selftest()
        return EXIT_OK

    if not args.video:
        parser.print_usage(sys.stderr)
        print(
            "error: a video ID or URL is required\n"
            "example: python transcript.py EBw7gsDPAYQ\n"
            "example: python transcript.py https://www.youtube.com/watch?v=EBw7gsDPAYQ",
            file=sys.stderr,
        )
        return EXIT_USAGE

    if shutil.which("yt-dlp") is None:
        print(ytdlp_missing_hint(), file=sys.stderr)
        return EXIT_YTDLP_MISSING

    video_id = extract_video_id(args.video)
    if video_id is None:
        print(
            f"error: could not extract a YouTube video ID from {args.video!r}",
            file=sys.stderr,
        )
        return EXIT_USAGE

    try:
        transcript = build_transcript(video_id)
    except TranscriptError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return exc.code

    payload = json.dumps(transcript, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        try:
            Path(args.output).write_text(payload, encoding="utf-8")
        except OSError as exc:
            print(f"error: could not write {args.output}: {exc}", file=sys.stderr)
            return EXIT_FETCH_FAILED
    else:
        sys.stdout.write(payload)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())