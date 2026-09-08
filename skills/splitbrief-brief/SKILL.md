---
name: splitbrief-brief
description: >
  Use when a task should be compiled into self-contained Product Task Briefs
  without executing them — "splitbrief brief", "write the briefs", "compile
  task briefs for <tool>", "prepare briefs I can hand to another agent". Reads
  the project's instruction files and gates, cuts the work one file per brief
  in dependency order, and writes them under .splitbrief/runs/. To execute the
  briefs afterwards: splitbrief-run. For the whole pipeline in one go:
  splitbrief.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "[quick|standard|plan] [--ask] <task | file>"
---

# splitbrief-brief

Phase 0 and Phase 1 of the splitbrief pipeline (map: references/family-map.md). Output: a briefs directory any executor can consume — `splitbrief-run`, the SPLITBRIEF CLI, a human, or a tool prompted by hand.

## Arguments

`[mode]` — `quick` (default) | `standard` | `plan`. `standard` writes `spec.md` and `plan-notes.md` before the briefs; `plan` prints the plan block and the briefs and writes nothing.
`--ask` — pause at the plan block before writing.
`<task | file>` — task text, or a path that exists on disk read as the task.

No crew is needed. Nothing is spawned.

## Mandates

1. **The brief stands alone.** Code context is copied verbatim from the files it describes (references/brief-format.md); nothing is summarized from memory.
2. **Gates are resolved now, not later.** Every brief's `### Tests` ends with the resolved validation commands (references/gates.md) so whoever executes it runs the same checks the review will quote.
3. **One brief, one file.** Cut by file; order by dependency; caps `quick` 5 / `standard` 12; upgrade `quick` → `standard` when the file plan exceeds 5 files or 5 briefs and say so in the plan block.
4. **Nothing touches git.** The briefs carry the never-commit constraint; this skill writes only under `.splitbrief/`.

## Phase 0 — Preflight

1. Read the instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*`, `.github/copilot-instructions.md`); their rules become Constraints.
2. Resolve gates per references/gates.md; run the baseline once and record it. Choose the run dir now — `.splitbrief/runs/$(date +%Y-%m-%d-%H%M%S)-<slug>/` (on collision append `-2`, `-3`, …) — create it, and write `git status --porcelain --untracked-files=all` into `baseline-tree.txt` there so `splitbrief-run` can use it.
3. Read the files the task touches at the exports-and-structure level; cut the file plan; apply the upgrade rule.
4. Print the plan block:

    ## SPLITBRIEF preflight — <slug> (brief only)
    task: <first line>
    mode: quick
    gates: typecheck `npx tsc --noEmit` (manifest) · lint none · test `npm test` (default)
    baseline: typecheck PASS · test PASS (12 passed)
    briefs: 2 → T001 src/slugify.ts (create) · T002 src/index.ts (modify, after T001)
    run dir: .splitbrief/runs/2026-09-08-153000-slugify/
    gitignore: .splitbrief/ ignored   (or: NOT ignored — add it to .gitignore or expect the run dir in git status)

5. `plan` → print the briefs, `rm -r` the run dir, and stop. `--ask` → wait. Otherwise write `plan.md` (the block) and `.splitbrief/current-run` (the run dir path), then continue.

## Phase 1 — Briefs

`standard`: write `spec.md` (Overview, Acceptance Criteria — each verifiable, Functional Requirements, Out of Scope) and `plan-notes.md` (Summary, `### New Files` / `### Modified Files` path lines with an indented purpose each, Key Implementation Details, Testing Strategy). Both modes: write `briefs/T001.md` … and `briefs/index.md` exactly per references/brief-format.md — template, nine-section contract, critical rules, skill additions. Read every file a brief names before writing its Current Code and Signature sections.

## Hand-back

    ## SPLITBRIEF briefs — <slug>
    run dir: .splitbrief/runs/2026-09-08-153000-slugify/
    | Brief | File | Action | Depends on |
    |---|---|---|---|
    | T001 | src/slugify.ts | create | — |
    | T002 | src/index.ts | modify | T001 |
    gates recorded: typecheck · test (lint: none)
    next: splitbrief-run impl=<tool>[:<model>] .splitbrief/runs/2026-09-08-153000-slugify/briefs

## Orchestration notes

Read files, run the gate commands, write files — nothing else. `--ask` uses the host's question facility (Claude Code: `AskUserQuestion`; other hosts: a plain question, resume on the next message).
