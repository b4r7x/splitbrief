---
name: diptych-implement-spec
description: Execute a specific implementation spec from plans/. Use when the user asks to implement a numbered spec like "implement 001", "run plans/003", "do the capability matrix spec", or similar. Reads the spec, plan, and tasks files; executes tasks in order; runs tests between phases; updates docs at the end.
---

# Implement a diptych spec end-to-end

This skill drives a full implementation pass through one `plans/<NNN>-<slug>/` directory. It assumes you have already read the project primer (`diptych-dev` skill) — if not, read those files first.

## Input

The user says something like:
- "implement 001" / "run 001" / "do spec 001"
- "implement plans/003-session-jsonl-log"
- "run the capability matrix spec"

Resolve the target spec folder: match by number first (`plans/001-*`), then by slug. If ambiguous, ask. If none found, list available specs via `ls plans/` and ask.

## Execution flow

### Step 1 — Read the spec

Read in this order from the target folder:

1. `spec.md` — understand problem, goal, user stories, functional requirements, success criteria, non-goals.
2. `plan.md` — understand data model, architecture, code paths to change, dependencies.
3. `tasks.md` — the numbered task list (T001…) with per-task file paths and change descriptions.

Also re-read these project docs if it's been a while:
- `docs/CONCEPTS.md` — for any terms referenced in the spec.
- `docs/ARCHITECTURE.md` — especially the "Directory map" and "Where to add things" sections.

### Step 2 — Check dependencies

Look at the "Depends on" line in `plan.md`. For each dependency:

- If the dependency is another `plans/<NNN>/` and that spec has not been implemented (grep the codebase for the spec's declared success-criteria invariants), stop and warn the user: `Spec <NNN> depends on <dep>, which does not appear implemented yet. Implement <dep> first, or confirm you want to proceed anyway.`
- Dependencies on nothing → proceed.

### Step 3 — Create a TaskCreate tracker

Use `TaskCreate` to register a task for each `T001`, `T002`, … entry in `tasks.md`. Mark the first one `in_progress`. This gives visible progress to the user.

### Step 4 — Execute tasks in order

For each task:

1. Read the surrounding source files named in the task.
2. Apply the change using `Edit` (surgical) or `Write` (only for new files).
3. Run the task's stated verification (usually `npm run typecheck` or a specific test file).
4. If verification fails:
   - If the failure is caused by this task, fix and re-verify.
   - If the failure is pre-existing (reproduces on `git stash`), note it and continue.
5. Mark the task completed via `TaskUpdate`.

Do not batch tasks — one at a time so the user can see progress. Exceptions: trivial renames or grep sweeps can fold into one task entry.

### Step 5 — Run the full suite before Doc Sync phase

After the non-doc tasks (everything before the "Phase 6 / Doc Sync" section in `tasks.md`):

```bash
npm run typecheck
npm run lint
npm test
```

All must pass. If tests fail:

- If a test is asserting on a string or path that this spec intentionally changed, update the test.
- If a test breaks and you don't understand why, stop and ask the user before proceeding.

### Step 6 — Doc Sync

Execute the "Phase 6 — Doc Sync" tasks from `tasks.md`:

- Typically updates to `docs/CONCEPTS.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`.
- Each Doc Sync task names exact sections to update. Edit those sections to reflect what was just implemented — NOT what the spec proposed.

Check that docs and code agree by grepping a few spot-check invariants.

### Step 7 — Summary

Before returning control to the user, produce a summary:

```
Implemented: plans/<NNN>-<slug>
- Tasks completed: T001-TNN (NN/NN)
- Tasks skipped: <if any, with reason>
- Tests: <passed> passed / <failed> failed
- Files changed: <count>, bucketed: src/ N, docs/ M, tests N
- Docs synced: <list of doc sections updated>
- Blockers: <none | list>
- Pre-existing issues encountered but not addressed: <list>
```

Remind the user:
- Nothing is committed (hook blocks commits).
- They review and commit manually.
- Next spec per `plans/README.md` dependency order, if applicable.

## Constraints

- **Never run `git add`, `git commit`, or `git stage`.** The hook at `.claude/hooks/block-git-commits.sh` blocks these. Respect it.
- **Never rename folders under `plans/`.** Those are immutable once the spec is written.
- **Never skip the Doc Sync phase.** Docs and code must stay synchronized — this is a project invariant.
- **Never touch other specs' folders** during implementation. If the user wants to work on N, work on N only.
- **If a task says "research during implementation"** (e.g. "confirm the capability value for codex during T004"), do the research, adjust, and document the adjustment in your summary.

## When things go wrong

- Dependency missing → stop, ask user.
- Tests unexpectedly failing → stop, report, ask.
- Task description mismatched with actual code (file moved, signature changed) → stop, ask user whether to update the task or the code.
- User interrupts mid-spec → state should survive (nothing committed); tell them which task is mid-flight so they can resume later.
