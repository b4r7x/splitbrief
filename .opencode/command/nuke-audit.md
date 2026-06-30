---
description: Run a convergent multi-agent code quality audit and write a phased fix spec.
---

## User Input

```text
$ARGUMENTS
```

Use the user input as `[mode] [scope]`. If mode is omitted, use `light`. If scope is omitted, audit the full repository.

Accepted modes: `light`, `full`.
Accepted scopes: `changed`, `staged`, `branch`, or a path/glob.

A bare `full` is always the mode, not the scope: `/nuke-audit full` means a full-intensity audit of the whole repository.

## Non-Negotiable Rules

- Read `CLAUDE.md` first, then `AGENTS.md`.
- Never run `git add`, `git stage`, `git commit`, or `git stash`.
- This command is audit-only. Do not edit source, config, docs, tests, or ignore files.
- Write durable output only under a fresh `.nuke/<YYYY-MM-DD>-<HHmmss>-<scope-slug>/` run directory.
- Respect the selected mode. Light-mode agents inherit the session model and use small grouped waves; full mode uses the strongest available model and maximum reasoning effort for every auditor and validator.
- Use subagents according to the current nuke-audit skill protocol: light mode caps each auditor round at 8 agents; full mode does not shrink waves to save cost.
- Main context stays thin: give agents paths, charters, current ledger, and artifact paths instead of pasting large source files.
- A finding enters the ledger only with file:line evidence and an end-to-end trace.
- Include every severity: critical, high, medium, low, and info.

## Artifacts

Create these files in the fresh run directory:

- `.nuke/<run>/context.md` - project snapshot, conventions, gates, scope file list, quality bar.
- `.nuke/<run>/findings.md` - confirmed and rejected findings ledger.
- `.nuke/<run>/rounds.md` - per-round convergence log.
- `.nuke/<run>/report.md` - scorecard and summary.
- `.nuke/<run>/fix-spec.md` - self-contained phased implementation spec.

## Phase -1 - Allocate Run Directory

Create a new run directory before recon:

```text
.nuke/<YYYY-MM-DD>-<HHmmss>-<scope-slug>/
```

If the path already exists, append `-2`, `-3`, etc. until creation succeeds. Never reuse or append to an existing audit run.

## Phase 0 - Recon

1. Resolve the scope into a concrete file list.
2. Exclude `node_modules`, `dist`, lockfiles, generated code, and `.nuke`.
3. Read project instructions and manifests:
   - `CLAUDE.md`
   - `AGENTS.md`
   - `package.json`
   - relevant docs from the `CLAUDE.md` documentation map
4. Identify gates verbatim, including at least:
   - `npm run format:check`
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run check:invariants`
   - `npm run test-ci`
5. Write `context.md`.

## Phase 1 - Quality Bar

Build a repo-specific SOTA quality bar and append it to `context.md`.

Cover at minimum:

- correctness and edge cases
- security and boundary validation
- DRY, KISS, YAGNI, SRP
- naming, file placement, and module ownership
- TypeScript type discipline
- tests that verify behavior, not implementation details
- dead code, comments, slop, and unnecessary abstractions
- documentation and command drift
- performance only where there is clear unbounded or repeated work

## Phase 2 - Convergence Audit Loop

Run rounds until two consecutive rounds find zero new confirmed findings, or until the mode cap is reached: light = 8 rounds, full = 10 rounds.

For each round:

1. Dispatch a fresh auditor wave according to the selected mode.
2. Light mode uses grouped behavioral, security, structural, and quality charters; full mode uses per-lens/per-chunk waves plus cross-cutting auditors.
3. Cover correctness, security, structure, DRY, simplicity, architecture, slop, types, errors, dead code, tests, conventions, performance, stack fit, and hygiene.
4. Every agent receives:
   - `context.md`
   - current `findings.md`
   - its lens charter
   - assigned file paths
   - instruction to report only new candidates with file:line evidence
5. Run an independent skeptic pass for every candidate. Skeptics must try to refute:
   - the issue is real at cited lines
   - it is not a duplicate of confirmed or rejected ledger entries
   - it is not intentional per project docs
   - it is in scope
   - the fix would improve the code instead of adding churn
6. Append confirmed findings as `F-###`; append rejected claims as `R-###`.
7. Update `rounds.md` with candidate counts, confirmed-new count, rejected count, duplicates, and dry-round counter.

Never declare convergence after a single clean round.

## Ledger Format

Use this shape in `findings.md`:

```markdown
# Findings Ledger
scope: <scope> | started: <date> | status: in-progress
counts: <critical> critical / <high> high / <medium> medium / <low> low / <info> info

## Confirmed

### F-001 · high · <lens> · path/file.ts:12
Problem: <what is wrong>
Evidence: <trace proving it>
Fix: <specific fix direction>
round: <n> · skeptic: confirmed

## Rejected - do not re-report, do not re-judge

### R-001 · <lens> · path/file.ts:12
Claim: <candidate claim>
Rejected because: <why it is false, duplicate, intentional, or churn>
round: <n>
```

## Phase 3 - Scorecard And Fix Spec

Write `report.md` with a 1-5 score for each lens. Target after fixes is 5/5 unless the report gives a concrete reason why that is impossible.

Write `fix-spec.md` as a complete handoff for `/nuke-fix` or another fresh AI context. It must include:

- executor context with repo conventions and gates
- rule to never stage, commit, or stash
- audit mode header and phase protocol: implementation subagents, fresh validation subagents, mode-specific fix loop
- dependency-ordered phases
- parallel-safe batches with disjoint file ownership
- exact tasks with affected files, finding IDs, change instructions, and acceptance criteria
- phase exit gates
- coverage map proving every `F-###` is assigned to at least one task

Order phases as:

1. structural moves, file placement, naming, and boundary corrections
2. DRY extractions and architecture consolidation
3. local correctness, type, simplicity, slop, and error fixes
4. tests and behavior coverage
5. docs, commands, packaging, and cleanup

## Final Output

Do not start fixing. Report:

- `.nuke/<run>/fix-spec.md`
- total confirmed and rejected findings
- whether convergence reached two dry rounds
- which command to run next: `/nuke-fix .nuke/<run>/fix-spec.md`
