---
name: splitbrief-run
description: >
  Use when existing Product Task Briefs should be executed by a different
  coding tool spawned from this session — "splitbrief run", "run these briefs
  with opencode/codex/cursor/cmd", "execute the briefs in .splitbrief/runs/…".
  Spawns the implementer headless per brief, validates with the project's
  gates, checks drift against the brief's scope, retries and escalates on a
  bounded ladder. Needs briefs written by splitbrief-brief or the SPLITBRIEF
  CLI. For the review afterwards: splitbrief-review. Whole pipeline:
  splitbrief.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "impl=<tool>[:<model>][@<effort>] [--ask] [--no-escalate] [error: <review.md>] <briefs dir | brief file>"
---

# splitbrief-run

Phase 2 of the splitbrief pipeline (map: references/family-map.md). Input: a briefs directory with `index.md`, a single brief file, or a SPLITBRIEF CLI `tasks.md` (split on its `---` frontmatter blocks into briefs first). Output: source changes made by the implementer, and the evidence trail.

## Arguments

`impl=<tool>[:<model>][@<effort>]` — required. Tools `claude`, `codex`, `opencode`, `copilot`, `kilo`, `cursor`, `cmd`, `agy`; split on the first `:` and the last `@`. Fallback when absent: `.splitbrief/config.yaml` `implementer:` block; else run `command -v` over all eight binaries, ask one question listing the ones found with their auth status, and wait.
`--ask` — pause at the plan block. `--no-escalate` — no takeover rung.
`error: <review.md>` — a review fix cycle: only the briefs that own a Critical finding run (mapping per references/review-format.md), the findings are the error block, attempt numbers continue from each brief's last attempt, and the local-retry budget resets.
`<briefs dir | brief file>` — the briefs to run. A run dir path is accepted and resolves to its `briefs/`.

## Mandates

1. **Gates decide, not the implementer.** Every attempt is followed by the gates and the drift check (references/gates.md).
2. **One brief, one process at a time.** Dependency order from `index.md`; never two implementers at once.
3. **The ladder is bounded and halts are hard.** Local retries → hint → takeover per brief; auth, usage, missing binary, or two consecutive timeouts halt the run with the fix printed.
4. **Nothing touches git.** Not this session, not the implementer.
5. **Never substitute a seat.** Unlisted model or missing tool → halt, never a swap.

## Phase 0 — Preflight

1. Resolve the implementer; `command -v`, version and auth probes, model listing check (references/tool-recipes.md).
2. Resolve gates and run the baseline (references/gates.md). The run dir is the briefs' own run dir when they live in one; otherwise create `.splitbrief/runs/$(date +%Y-%m-%d-%H%M%S)-<slug>/` now. Write `baseline-tree.txt` there from `git status --porcelain --untracked-files=all`, overwriting one left by `splitbrief-brief` (edits made between briefing and running are not drift) — except under `error:`, where the original baseline stays so the fix cycle's diff is cumulative.
3. Load the briefs; verify each has the frontmatter fields `id`, `title`, `action`, `file`, `depends_on` and the sections `### Description`, `### Implementation Steps`, `### Tests`, `### Scope`, `### Constraints`; a brief missing one stops the run before any spawn, naming the brief and the section.
4. Print the plan block:

    ## SPLITBRIEF preflight — <slug> (run only)
    briefs: <dir> · 2 → T001 src/slugify.ts (create) · T002 src/index.ts (modify, after T001)
    crew: impl cmd:deepseek/deepseek-v4-flash@high (auth ok, model listed)
    gates: typecheck `npx tsc --noEmit` (manifest) · lint none · test `npm test` (default)
    baseline: typecheck PASS · test PASS (12 passed)
    ladder: 2 local retries → hint → takeover (session)
    run dir: <the briefs' run dir, or the new .splitbrief/runs/<stamp>-<slug>/>
    gitignore: .splitbrief/ ignored   (or: NOT ignored — add it to .gitignore or expect the run dir in git status)

5. `--ask` → wait. Otherwise write `plan.md` (append a `## run` section when `splitbrief-brief` already wrote one), `progress.md` (every brief `pending`; Status `pending` · `running` · `retrying (n)` · `done` · `escalated` · `halted`; Rung `—` · `retry` · `recipe-fix` · `hint` · `takeover`), `evidence.md` (one entry per attempt: command, exit + terminal record, completion report, gates + drift, outcome), and `.splitbrief/current-run` with the run dir path; then continue.

## Phase 2 — Run

For each brief in order, while every `depends_on` is `done`:

1. **Prompt** — `T00N/attempt-1.prompt.md` per references/implementer-prompt.md (preamble, body, closing line). Refuse a prompt starting with `-`.
2. **Spawn** — the implementer recipe from references/tool-recipes.md; cwd = project root; output → `T00N/attempt-1.log`; 20-minute timeout. Append the command line to `evidence.md`.
3. **Outcome** — references/implementer-prompt.md §7: exit code, terminal record, the brief's file in the changed set, a completion report naming a file. A failed outcome records `gates: not run · drift: not run` and goes to step 6.
4. **Gates** — typecheck → lint → test with narrowing; verbatim into `validation.md`.
5. **Drift** — per references/gates.md; every attempt gets an entry in `drift.md`; any path entry fails the attempt.
6. **Ladder** on failure — halt signatures first, then spawn-failure signatures (`recipe-fix`: correct the recipe, re-spawn the original prompt as the next attempt, no retry consumed), then local retries (2, or `workflow.max_retries`) → hint (`T00N/hint.md`, ≤ 500 tokens, no code, one implementer retry) → takeover (this session edits the file, then gates + drift), unless `--no-escalate`. Signatures: references/tool-recipes.md; framings and prompts: references/implementer-prompt.md.
7. **Record** — `progress.md` row (`pending` · `running` · `retrying (n)` · `done` · `escalated` · `halted`), reprint the table.

## Hand-back

    ## SPLITBRIEF run — <slug>
    crew: impl cmd:deepseek/deepseek-v4-flash@high
    run dir: <path>
    | Brief | File | Attempts | Rung | Gates | Drift | Status |
    |---|---|---|---|---|---|---|
    | T001 | src/slugify.ts | 1 | — | PASS | none | done |
    ### Recorded validation output (final attempts)
    <verbatim>
    Verdict: DONE — every brief done, all gates pass (nothing committed) · next: splitbrief-review intent: <run dir>

Or `Verdict: STOPPED at T00N — <rung or halt>, <reason>` with pending briefs and the fix.

## Orchestration notes

- **Any host:** foreground spawn with the host's timeout; below 20 minutes, detach — `nohup sh -c '<command>' > <log> 2>&1 & echo $! > <pid file>` — and poll `kill -0 $(cat <pid file>)`.
- **Claude Code:** `run_in_background: true` on the spawn; `--ask` via `AskUserQuestion`.
- **Other hosts:** plain questions; on the next message read `.splitbrief/current-run`, then that run dir's `progress.md`, and continue from the first brief that is not `done`.
- The implementer gets only the recipe's flags — never this session's permissions or keys.
