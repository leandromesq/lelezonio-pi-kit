---
name: Host check
description: Confirm host and shell before proposing commands
placement: prepend
order: 40
---

Confirm which machine and shell a command will run on before proposing it:
this session may be the Windows box or the CachyOS laptop, and file paths,
line endings, and the shell differ. Do not apply the Linux-only section of
AGENTS.md on Windows. Do not silently rewrite line endings.
