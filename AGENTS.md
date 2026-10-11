# SPLITBRIEF — Agent Guide

## CRITICAL — NEVER COMMIT, NEVER STAGE

Do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files. The user commits manually. A `PreToolUse` hook at `.claude/hooks/block-git-commits.sh` enforces this with exit code 2.

---

SPLITBRIEF is an open-source CLI that orchestrates two AI coding tools: the stronger one plans, compiles Task Briefs, and reviews; the weaker one executes them. SPLITBRIEF holds the contract between them — the brief, validation, retry, escalation, and the evidence trail.

**`CLAUDE.md` is the single source of truth.** It carries the tech stack, commands, the full documentation map, and the core conventions (zero classes, ESM `.js` import suffixes, zero memoization, no `forwardRef`, external stores over Context, etc.). Read `CLAUDE.md` first; this file only exists as the root agent entry point that the skill-discovery layer (`src/engine/skill-discovery.ts`) picks up.

Always use the `change-discipline` skill when you implement, fix or review code. Fix the root cause at the shared function, reuse existing code, delete the path you replace, and add nothing speculative.

For conventions, see the **"Core conventions"** section of `CLAUDE.md`. For the source tree and architectural notes, follow the **"Documentation map"** in `CLAUDE.md`.

## User-facing text

Text a user can read must not show how SPLITBRIEF is built. This covers the shipped docs (the Markdown files in `package.json` `files`), `CHANGELOG.md` and the GitHub release notes, CLI and TUI strings, the website, and the skills a user installs (the skills in `.claude-plugin/marketplace.json` and every skill not marked `metadata.internal: true`).

Never write these there:

- **Admissions.** Do not say that something is untested, unverified, not verified live, not captured live or not checked on a platform, and do not list such tools or "known gaps". State what is supported. Say "not supported" only where the user needs it to act.
- **Internal process.** No "owner" or "owner decision", no agent or model names used to build the project (Sol, Astra, Opus, codex lanes), no workflows, lanes, smoke runs, review verdicts or handoffs, no dates of internal passes, no `.nuke/` paths, and no finding, task, issue or lane ids (`N-7`, `DOC-2`, `REL-04`, `S11`, `T-080`, `#67`).
- **Implementation detail in the changelog.** No function names, file paths, gate numbers, internal types or state-machine events. Write what the user gets or what changed for the user, grouped as Added, Changed, Fixed and Removed.
- **Unfinished or apologetic words.** No "for now", "hack", "TODO", "temporary", "we hope" or "should work".

Contributor docs (`docs/RELEASING.md`, `TESTING.md`, `DOGFOODING.md`, `INVARIANTS.md`, `CODE-STANDARD.md` and the other docs outside `package.json` `files`) may use process language. A contributor skill carries `metadata.internal: true`, so skills.sh hides it, and the marketplace does not list it. The live-matrix manifest is a private release record: it never goes into the changelog or a GitHub release ([RELEASING.md](./docs/RELEASING.md#the-release-rule)). Invariant gate 59 (`scripts/user-facing-text.ts`) checks the clear markers.
