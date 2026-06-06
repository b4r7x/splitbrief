---
name: diptych-implement-spec
description: Execute a specific implementation spec from notes/superpowers/specs/. Use when the user asks to implement a numbered spec like "implement 01", "run notes/superpowers/specs/04-rpc-mode", "do the polyglot validation spec", or similar. Reads the spec's execute-prompt and agent-briefs; executes briefs in order; runs tests between phases; updates docs at the end.
---

# Implement a diptych spec end-to-end

This skill drives a full implementation pass through one spec directory under `notes/superpowers/specs/` (numbered, e.g. `04-rpc-mode/`, or dated, e.g. `2026-04-26-command-palette/`). It assumes you have already read the project primer (`diptych-dev` skill) — if not, read those files first.

## Input

The user says something like:
- "implement 01" / "run 01" / "do spec 01"
- "implement notes/superpowers/specs/04-rpc-mode"
- "run the polyglot validation spec"

Resolve the target spec folder under `notes/superpowers/specs/`: match by number first (`04-*`), then by slug. If ambiguous, ask. If none found, list available specs via `ls notes/superpowers/specs/` and ask.

## Execution flow

### Step 1 — Read the spec

Read in this order from the target folder (layout is heterogeneous — read whatever the folder actually contains):

1. `execute-prompt.md` — the ready-to-paste prompt: which skills to load, what to read, which agent-briefs to implement and in what order. Numbered specs always have this.
2. `agent-briefs/*.md` — the per-brief work items (problem, files to touch, change descriptions). Read them in the order `execute-prompt.md` dictates.
3. Any `README.md` / `decisions.md` in the folder — dated specs often carry these for context and design rationale.

Also re-read these project docs if it's been a while:
- `docs/CONCEPTS.md` — for any terms referenced in the spec.
- `docs/ARCHITECTURE.md` — especially the "Directory map" and "Where to add things" sections.

### Step 2 — Check dependencies

Check the dependency graph in `notes/superpowers/specs/README.md` (and any "depends on" note in `execute-prompt.md`). For each dependency:

- If the dependency is another spec under `notes/superpowers/specs/` and that spec has not been implemented (grep the codebase for the spec's declared success-criteria invariants), stop and warn the user: `Spec <NN> depends on <dep>, which does not appear implemented yet. Implement <dep> first, or confirm you want to proceed anyway.`
- Dependencies on nothing → proceed.

### Step 3 — Create a TaskCreate tracker

Use `TaskCreate` to register a task for each agent-brief the spec lists (in `execute-prompt.md` order). Mark the first one `in_progress`. This gives visible progress to the user.

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

After the non-doc work (everything before the Doc Sync step the `execute-prompt.md` / agent-briefs call for):

```bash
npm run typecheck
npm run lint
npm test
```

All must pass. If tests fail:

- If a test is asserting on a string or path that this spec intentionally changed, update the test.
- If a test breaks and you don't understand why, stop and ask the user before proceeding.

### Step 6 — Doc Sync

Execute the Doc Sync work the spec calls for (its `execute-prompt.md` / final agent-brief names the doc updates):

- Typically updates to `docs/CONCEPTS.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`.
- Each Doc Sync item names exact sections to update. Edit those sections to reflect what was just implemented — NOT what the spec proposed.

Check that docs and code agree by grepping a few spot-check invariants.

### Step 7 — Summary

Before returning control to the user, produce a summary:

```
Implemented: notes/superpowers/specs/<spec-folder>
- Briefs completed: <NN/NN>
- Briefs skipped: <if any, with reason>
- Tests: <passed> passed / <failed> failed
- Files changed: <count>, bucketed: src/ N, docs/ M, tests N
- Docs synced: <list of doc sections updated>
- Blockers: <none | list>
- Pre-existing issues encountered but not addressed: <list>
```

Remind the user:
- Nothing is committed (hook blocks commits).
- They review and commit manually.
- Next spec per `notes/superpowers/specs/README.md` dependency order, if applicable.

## Constraints

- **Never run `git add`, `git commit`, or `git stage`.** The hook at `.claude/hooks/block-git-commits.sh` blocks these. Respect it.
- **Never rename folders under `notes/superpowers/specs/` or `notes/specs/`.** Those are immutable once the spec is written.
- **Never skip the Doc Sync phase.** Docs and code must stay synchronized — this is a project invariant.
- **Never touch other specs' folders** during implementation. If the user wants to work on N, work on N only.
- **If a brief says "research during implementation"** (e.g. "confirm the capability value for codex during this brief"), do the research, adjust, and document the adjustment in your summary.

## When things go wrong

- Dependency missing → stop, ask user.
- Tests unexpectedly failing → stop, report, ask.
- Task description mismatched with actual code (file moved, signature changed) → stop, ask user whether to update the task or the code.
- User interrupts mid-spec → state should survive (nothing committed); tell them which task is mid-flight so they can resume later.
