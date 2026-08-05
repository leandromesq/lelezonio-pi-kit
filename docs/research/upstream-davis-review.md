# Upstream review: davis7dotsh/my-pi-setup

**Date:** 2026-08-04
**Scope:** Commits on upstream `main` made after this repository diverged, reviewed against local `/home/leandrom/Projects/pi-setup` `main` (`348730a`).
**Sources:** local git history (refs fetched from `https://github.com/davis7dotsh/my-pi-setup.git` on 2026-08-04) — no web sources needed beyond the upstream URL; every claim below is reproducible from the fetched objects.

## Verdict

Exactly **one** upstream commit exists after the fork point, and it is a **safe, low-value prompt polish that is worth porting** (1-line change, zero structural impact). Nothing else upstream is un-merged into local.

---

## 1. Fork point (cutoff) determination

| Question             | Answer                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| History shared?      | **Yes.** Local `main` and upstream `main` share a linear ancestry from `fb97846` "Initial commit" (2026-07-12).                                                                                                                                                                                                                                                                          |
| Merge-base           | `2657bae` "chore: ignore models.json files and trim AGENTS.md" (2026-07-24)                                                                                                                                                                                                                                                                                                              |
| Confidence           | **High.** Verified: (a) `git merge-base main 4a37b78` → `2657bae`, ancestor of both branches; (b) every upstream commit up to `2657bae` is present locally (0 missing — loop over `git log 2657bae` checking ancestry); (c) divergence is simple: local has 6 commits after the fork, upstream has 1, with no merges on either side after the fork.                                      |
| Residual uncertainty | Only terminological: if "diverged" were meant as the local _re-clone_ (`6c287d7` "feat: rebuild kit as clone-based Pi setup", 2026-07-27), the cutoff would be one commit later — but that commit is a local refactor of shared history, not a re-import, so the merge-base `2657bae` remains the defensible cutoff. No shallow/grafted history detected (61 local commits, continuous). |

**Divergence structure:**

```
2657bae (2026-07-24)  ← last shared commit (fork point)
├── local main (6 commits): 6c287d7 rebuild kit · ec01fd5 Codex switcher · f2f1205 remote-agent ext · 70fcd99 subagent models · c3775a6 Hound docs · 348730a Hound migration
└── upstream main (1 commit): 4a37b78 "chore: refine run recap prompt" (2026-07-31)
```

## 2. Upstream commits after the fork point (on main)

Only one:

- **`4a37b78`** — "chore: refine run recap prompt" (2026-07-31)
  - URL: <https://github.com/davis7dotsh/my-pi-setup/commit/4a37b7830bda00d4a7e861218f70e70097ddf2e8>
  - Files: `extensions/summaries/src/prompt.ts` (1 line)
  - Change: drops the "one short paragraph" option from the recap rule so summaries are always bullets:
    - Before: `...important caveats. Prefer one short paragraph or up to three compact Markdown bullets.`
    - After: `...important caveats. Prefer up to three compact Markdown bullets.`

Other upstream refs were checked for completeness: all six non-main branches (`advanced-subagent`, `effect-v4-extension-migration`, `feat/summaries`, `feature/background-terminals`, `feature/by-the-way`, `feature/fd-rg-tools`) are **0 commits ahead of upstream `main`** — nothing on them is missing from `main`.

## 3. Local comparison state

- Local file `extensions/summaries/src/prompt.ts` exists and is **byte-identical to upstream's pre-commit version** (`git diff main 4a37b78 -- extensions/summaries/` shows exactly the one line above, nothing else).
- No local commit since the fork touched `extensions/summaries/` at all (`git diff 2657bae main -- extensions/summaries/` is empty).
- The extension is wired into the local kit: documented in `README.md` ("Automatic run summaries and conversation export", extension table row `summaries`).
- No local tests assert on the old wording; `SUMMARY_SYSTEM_PROMPT` is referenced only by `summarizer.ts` (consumed at runtime), so the change cannot break tests.

**Not superseded locally:** the change is not already present, and no local work overlaps it.

## 4. Ranked recommendations

| #   | Recommendation                                                                      | Value        | Compatibility                                        | Rationale                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Cherry-pick `4a37b78`** into local `main`                                         | Low–moderate | Trivial (clean 1-line apply; no API/dep/test impact) | The only upstream change since the fork. Keeps the vendored `summaries` extension byte-in-sync with upstream, which makes any _future_ upstream summarizer work (config, transcript, UI) merge cleanly instead of accumulating drift on a shared file. Behavioural effect is small but intended: recaps come back as bullets only, never a paragraph — slightly more consistent output. |
| 2   | **Add `upstream` as a tracking remote and re-run this review after upstream moves** | Low          | None (git metadata only)                             | Upstream `main` is currently 1 commit ahead of us; both sides are evolving independently (6 vs 1 commits since fork). A cheap `git fetch upstream && git log main..upstream/main` on a schedule turns a one-time review into a recurring sync check.                                                                                                                                    |
| —   | Nothing else                                                                        | —            | —                                                    | No other upstream content exists to bring over: 0 commits on other branches beyond `main`, and everything before `2657bae` is already local history.                                                                                                                                                                                                                                    |

**Suggested apply (for a future session, not executed here):**

```bash
git fetch https://github.com/davis7dotsh/my-pi-setup.git main
git cherry-pick 4a37b7830bda00d4a7e861218f70e70097ddf2e8
# then: npm run check && npm run format:check && npm test
```

(Not run — per instructions this review does not alter implementation files or commit.)

## 5. Notes

- To reproduce: `git fetch https://github.com/davis7dotsh/my-pi-setup.git main`. No persistent `upstream` remote was retained after this review.
- Drift risk is currently negligible: one shared file (`extensions/summaries/src/prompt.ts`) differs by a single line, with no pending upstream work touching it.
