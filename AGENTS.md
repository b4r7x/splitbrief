# SPLITBRIEF — Agent Guide

## CRITICAL — NEVER COMMIT, NEVER STAGE

Do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files. The user commits manually. A `PreToolUse` hook at `.claude/hooks/block-git-commits.sh` enforces this with exit code 2.

---

SPLITBRIEF is an open-source CLI that orchestrates expensive AI (planner) and cheap/local AI (implementer) to cut AI coding costs by 50%+.

**`CLAUDE.md` is the single source of truth.** It carries the tech stack, commands, the full documentation map, and the core conventions (zero classes, ESM `.js` import suffixes, zero memoization, no `forwardRef`, external stores over Context, etc.). Read `CLAUDE.md` first; this file only exists as the root agent entry point that the skill-discovery layer (`src/engine/skill-discovery.ts`) picks up.

For conventions, see the **"Core conventions"** section of `CLAUDE.md`. For the source tree and architectural notes, follow the **"Documentation map"** in `CLAUDE.md`.
