---
name: Ship
description: Check, conventional commit, push, report the hash
placement: append
order: 80
---

When the work is done: run the project's check/format/lint/test suite, commit
in logical steps using conventional commits (feat/fix/chore + scope), push,
and report the commit subject and hash. Never force-push, rewrite history, or
commit secrets without asking.
