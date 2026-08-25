---
name: youtube-transcript
description: Fetch clean English transcripts from YouTube videos as JSON using yt-dlp. Use when summarizing, analyzing, or quoting video content.
---

# YouTube Transcript

Fetch the title and a clean English transcript of a YouTube video as JSON.
The transcript is printed to stdout and ready for summarization or analysis.
Requires Python 3.9+ and `yt-dlp` on PATH. Works on Linux and Windows.

## Setup

Install `yt-dlp` once (any one option):

**Linux**

```bash
python3 -m pip install --upgrade yt-dlp
# or: sudo apt install yt-dlp   (Debian/Ubuntu)
# or: sudo pacman -S yt-dlp     (Arch)
# or: pipx install yt-dlp
```

**Windows**

```powershell
python -m pip install --upgrade yt-dlp
# or: winget install yt-dlp.yt-dlp
```

Verify with `yt-dlp --version`.

## Usage

```bash
python3 ~/.pi/agent/skills/youtube-transcript/transcript.py <video-id-or-url>  # Linux
python "$HOME\.pi\agent\skills\youtube-transcript\transcript.py" <video-id-or-url>  # Windows PowerShell
python "$HOME\.pi\agent\skills\youtube-transcript\transcript.py" <video-id-or-url> -o out.json
python "$HOME\.pi\agent\skills\youtube-transcript\transcript.py" --selftest
```

When invoking the script programmatically, resolve it relative to this skill
directory rather than the current project directory.

Accepts a video ID or any full URL:

- `EBw7gsDPAYQ`
- `https://www.youtube.com/watch?v=EBw7gsDPAYQ`
- `https://youtu.be/EBw7gsDPAYQ`
- shorts and embed URLs work too

## Output

JSON on stdout: `id`, `url`, `title`, `uploader`, `language`,
`captionSource` (`manual` or `auto`), and `transcript` as trimmed cues with
`start` (seconds), `duration`, and `text`.

Manual (uploaded) English subtitles are preferred; auto-generated captions
are used as a fallback. Markup, duplicate lines, and rolling-caption repeats
are cleaned out.

## Errors

Exit codes: `2` usage error, `3` yt-dlp missing (hint text includes install
commands), `4` fetch failure (private/deleted video, region lock, sign-in
wall), `5` no English captions (the available languages are listed).

## Notes

- The video must have captions or a transcript available
- Works with auto-generated and manual transcripts
- No pip dependencies beyond `yt-dlp` itself
