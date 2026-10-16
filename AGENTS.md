# SPLITBRIEF — Agent Guide

## CRITICAL — NEVER COMMIT, NEVER STAGE (subagents); checkpoint commits only (the orchestrating session)

Subagents, workflow agents and implementer tools do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files — ever. Not even when the task is done, not even after tests pass. Leave every change as an unstaged modification in the working tree.

The one exception is the orchestrating session, at an agreed checkpoint: after the gates of that checkpoint are green and the review findings are fixed, it stages and commits with the `/human-commit` style message, running the command prefixed with `SPLITBRIEF_OWNER_COMMIT=1 ` (the hook lets that prefix through). Nothing else commits, nothing pushes, nothing rewrites history.

**Enforcement (best-effort):** `.claude/hooks/block-git-commits.sh` is a `PreToolUse` hook that blocks `git add` / `git stage` / `git commit` with exit code 2. It is a guardrail, not a sandbox, so the rule above is what binds you, not the hook. A `BLOCKED:` message in stderr means the guardrail fired — stop and report to the user.

---

SPLITBRIEF is an open-source CLI that orchestrates two AI coding tools: the stronger one plans, compiles Task Briefs, and reviews; the weaker one executes them. SPLITBRIEF holds the contract between them — the brief, validation, retry, escalation, and the evidence trail.

**`CLAUDE.md` is the single source of truth.** It carries the tech stack, commands, the full documentation map, and the core conventions (zero classes, ESM `.js` import suffixes, zero memoization, no `forwardRef`, external stores over Context, etc.). Read `CLAUDE.md` first; this file only exists as the root agent entry point that the skill-discovery layer (`src/engine/skill-discovery.ts`) picks up.

Always use the `change-discipline` skill when you implement, fix or review code. Fix the root cause at the shared function, reuse existing code, delete the path you replace, and add nothing speculative.

For conventions, see the **"Core conventions"** section of `CLAUDE.md`. For the source tree and architectural notes, follow the **"Documentation map"** in `CLAUDE.md`.

## Reporting findings (binding)

A finding from a review, a live check, a test run or an audit is reported only when it is confirmed. Every finding states four things:

1. **Evidence.** The raw evidence that shows it: a capture, a log line, a `session.jsonl` event, a test output. Name the file.
2. **Cause.** The code that causes it, with `file:line`, read in the current tree.
3. **Who hits it, and its kind.** `PRODUCT` when a normal user in a normal setup hits it (their own HOME, their signed-in tools, normal input). `TEST` when only the test conditions cause it (a temporary HOME, exported API keys in the tester's shell, a fake tool, an odd input the tester typed, parallel runs on one machine, a flaw in the test or the harness). `ENV` when an outside service failed (an outage, a rate limit).
4. **What the user sees.** One sentence in plain words. A `PRODUCT` finding also has a class: 1 blocks work, loses data or gives a wrong outcome; 2 shows wrong or misleading text; 3 is cosmetic.

A `PRODUCT` finding is fixed in the product. A `TEST` finding is fixed in the test, the harness or the check setup; it blocks a release only when it breaks the gate or CI. An `ENV` finding is recorded, not fixed.

Drop a finding that cannot be confirmed. Never report a guess as a defect.

An independent skeptic, not the agent that found it, checks every finding against these four points and tries to refute it before it is reported or fixed. Only the findings the skeptic confirms go to the owner or to a fix.

## Fixing a defect (binding)

1. **Confirm first.** Before any edit, confirm the defect as "Reporting findings" requires: the evidence, the cause at `file:line`, and that a normal user hits it. A finding that cannot be confirmed is not fixed; report it as not confirmed.
2. **Plan, then change.** Load the `change-discipline` skill. Write the plan: the one function every caller routes through, the callers to migrate, the old path to delete. Then implement it; no guessed design.
3. **Tests at the end.** Planning, implementing, reviewing and fixing run no tests (typecheck, lint and format only). After the review passes, run the tests of the change once at the end. When a test fails, fix the root cause, review the fix, and run the tests again until they pass.

## User-facing text

Text a user can read must not show how SPLITBRIEF is built. This covers the shipped docs (the Markdown files in `package.json` `files`), `CHANGELOG.md` and the GitHub release notes, CLI and TUI strings, the website, and the skills a user installs (the skills in `.claude-plugin/marketplace.json` and every skill not marked `metadata.internal: true`).

Never write these there:

- **Admissions.** Do not say that something is untested, unverified, not verified live, not captured live or not checked on a platform, and do not list such tools or "known gaps". State what is supported. Say "not supported" only where the user needs it to act.
- **Internal process.** No notes about how the project is built: no review rounds, verdicts or handoffs, no agent or model names used to build it, no work lanes or internal decisions, and no dates of internal passes. No finding, task or issue ids (`N-7`, `DOC-2`, `REL-04`, `S11`, `T-080`, `#67`) and no private paths.
- **Implementation detail in the changelog.** No function names, file paths, gate numbers, internal types or state-machine events. Write what the user gets or what changed for the user, grouped as Added, Changed, Fixed and Removed.
- **Unfinished or apologetic words.** No "for now", "hack", "TODO", "temporary", "we hope" or "should work".

Contributor docs (`docs/RELEASING.md`, `TESTING.md`, `DOGFOODING.md`, `INVARIANTS.md`, `CODE-STANDARD.md` and the other docs outside `package.json` `files`) may use process language. A contributor skill carries `metadata.internal: true`, so skills.sh hides it, and the marketplace does not list it. The live-matrix manifest is a private release record: it never goes into the changelog or a GitHub release ([RELEASING.md](./docs/RELEASING.md#the-release-rule)). Invariant gate 59 (`scripts/user-facing-text.ts`) checks the clear markers.
