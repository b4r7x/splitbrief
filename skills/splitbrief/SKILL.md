---
name: splitbrief
description: >
  Use when this session should plan a task and a different coding tool should
  build it, spawned and supervised from here — "splitbrief", "delegate this to
  opencode/codex/cursor/cmd/claude", "you plan, X implements, Y reviews", "plan
  it and let a cheaper model build it". Compiles Product Task Briefs, runs the
  implementer CLI headless per brief, validates with the project's own gates,
  checks drift against the brief's scope, retries and escalates on a bounded
  ladder, then reviews with recorded evidence. Briefs only: splitbrief-brief.
  Execute existing briefs: splitbrief-run. Review a foreign build:
  splitbrief-review.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "[quick|standard|plan] impl=<tool>[:<model>][@<effort>] [review=<tool>[:<model>][@<effort>]] [--ask [--yes]] [--no-escalate] <task | file>"
---

# splitbrief

The stronger tool plans, compiles Task Briefs, and reviews; the weaker one executes them. This session is the planner and the orchestrator. The implementer is a separate CLI you spawn with a self-contained brief; the reviewer is a separate CLI in read-only mode, or this session when none is given. Family: references/family-map.md.

Core principle — the brief is the contract. The implementer sees nothing but the brief, so everything it needs is in the brief; everything it must not do is in the brief's Scope; and every claim about the result is backed by recorded gate output, never by the implementer's word.

## Arguments

`[mode]` — `quick` (default) | `standard` | `plan`. Tokens match exactly in first position; anything else is the task.
`impl=<tool>[:<model>][@<effort>]` — the implementer seat. Tools: `claude`, `codex`, `opencode`, `copilot`, `kilo`, `cursor`, `cmd`, `agy` (aliases `claude-code`, `command-code`, `antigravity`, `cursor-agent`, `kilo-code`, `github-copilot`). Split on the first `:` and the last `@`, so `impl=opencode:opencode-go/kimi-k3@high` is tool `opencode`, model `opencode-go/kimi-k3`, effort `high`.
`review=<seat>` — the reviewer seat, same grammar. Absent → `review: session`.
`--ask` — pause at the plan block for confirmation. Default: print and run.
`--yes` — only with `--ask`: keep the plan-block pause but apply gate-blocker fixes (references/gates.md, Baseline) without asking.
`--no-escalate` — the ladder stops at the hint rung; this session never implements a brief.
`<task | file>` — task text, or a path that exists on disk (notes, a spec, an issue export) read as the task.

Natural phrasing is accepted ("implementer is opencode with kimi-k3, reviewer is cursor"). Normalize it to the grammar and print the normalized crew in the plan block — the plan block is the record of what was parsed.

Crew fallback, per seat, first match wins: inline → `.splitbrief/config.yaml` (`implementer:` / `reviewer:` blocks with `kind: cli`: `tool`, `model`, `effort` or `variant`; `workflow.max_retries` replaces the default 2 local retries) → no implementer: run `command -v` over all eight binaries, ask one question listing the ones found with their auth status, and wait → no reviewer: this session.

## Modes

| | **quick** (default) | **standard** |
|---|---|---|
| Phase 1 artifacts | briefs only | `spec.md` → `plan-notes.md` → briefs |
| Brief cap | 5 | 12 |
| Upgrade | file plan > 5 files or > 5 briefs → `standard`, printed as `mode: standard (upgraded: 7 files)` | > 12 briefs → write the briefs, stop, recommend splitting the task |

`plan` runs Phase 0 and Phase 1, prints the plan block and the briefs, removes the run dir it created, and stops. Nothing remains on disk, nothing is spawned.

## Mandates

1. **The brief stands alone.** Nothing from this session's context reaches the implementer unless it is written into the brief. Code context is copied verbatim (references/brief-format.md), never summarized.
2. **Gates decide, not the implementer.** Every attempt that changed the brief's file is followed by the resolved gates and the drift check (references/gates.md). An implementer's "tests pass" is a claim; the recorded output is the fact.
3. **One brief, one file, one process at a time.** Briefs run sequentially in dependency order. Never spawn two implementers at once.
4. **The ladder is bounded and halts are hard.** Local retries → hint → takeover, per brief. An auth error, a usage limit, a missing binary, or two consecutive timeouts stop the whole run and are reported with the fix — the next rung would silently hand the work to this session at planner prices.
5. **Review is evidence-bound.** The reviewer quotes the Recorded Validation Output or says validation was not recorded. A reviewer that asserts green tests from nowhere is wrong by construction.
6. **Nothing touches git.** No `git add`, `git commit`, `git stash`, no `.bak` files — not by this session, not by the implementer (the rule is in every brief's Constraints). The working tree is left for the human.
7. **Materialize before you move.** The run dir, `plan.md`, `progress.md`, and `evidence.md` exist on disk before the first spawn. `plan` mode is the only path that leaves nothing behind.
8. **Never substitute a seat.** A model the tool does not list, a tool that is not installed, or a reviewer that fails to spawn halts the run; it is never swapped for something else.

## Phase 0 — Preflight

1. **Instructions.** Read the project's instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*`, `.github/copilot-instructions.md`, whichever exist). Their rules become brief Constraints; a never-commit rule is copied into every brief verbatim.
2. **Crew.** Resolve both seats. For each: `command -v`, the version probe, the auth probe, and — when the tool lists models — confirm the requested model appears (references/tool-recipes.md). Any failure halts with the tool's own fix (login command or the model list).
3. **Gates.** Resolve typecheck, lint, test per references/gates.md and record the source of each.
4. **Baseline.** Run every gate once; record the tail. Blockers follow the unblock rule in references/gates.md.
5. **Run dir + tree.** Choose the run dir now — `.splitbrief/runs/$(date +%Y-%m-%d-%H%M%S)-<slug>/` (on collision append `-2`, `-3`, …) — create it, and write `git status --porcelain --untracked-files=all` into `baseline-tree.txt` there (without git: the mtime listing rule in references/gates.md). Nothing else is written yet.
6. **Shape.** Read the files the task touches at the exports-and-structure level. Cut the work into briefs, one file each, dependency-ordered. Apply the upgrade rule.
7. **Plan block** — always printed:

    ## SPLITBRIEF preflight — <slug>
    task: <first line of the task>
    mode: quick · crew: impl cmd:deepseek/deepseek-v4-flash@high · review session
    tools: cmd 1.50.1 (auth ok, model listed) · review: session
    gates: typecheck `npx tsc --noEmit` (manifest) · lint `biome check .` (manifest) · test `vitest run` (manifest)
    baseline: typecheck PASS · lint PASS · test PASS (42 passed)
    briefs: 2 → T001 src/health.ts (create) · T002 src/router.ts (modify, after T001)
    ladder: 2 local retries → hint → takeover (session)
    run dir: .splitbrief/runs/2026-09-08-153000-health-endpoint/
    gitignore: .splitbrief/ ignored   (or: NOT ignored — add it to .gitignore or expect the run dir in git status)

8. **Materialize, then move.** `plan` → after Phase 1 prints the briefs, `rm -r` the run dir and stop. Otherwise write `plan.md` (the block), `progress.md` (every brief `pending`), `evidence.md` (its first line, `# SPLITBRIEF evidence — <slug>`), and `.splitbrief/current-run` containing the run dir path — every host resumes from that pointer. `--ask` → stop and wait; options: run / change crew / change mode / narrow the task. Without `--ask`: continue in the same turn.

### `progress.md`

    # SPLITBRIEF progress
    task: <slug> · mode: quick · crew: impl cmd:… · review session · started: 2026-09-08 15:30

    | Brief | File | Status | Attempts | Rung | Gates | Drift |
    |---|---|---|---|---|---|---|
    | T001 | src/health.ts | pending | 0 | — | — | — |
    | T002 | src/router.ts | pending | 0 | — | — | — |

Status: `pending` · `running` · `retrying (n)` · `done` · `escalated` · `halted`. Rung: `—` · `retry` · `recipe-fix` · `hint` · `takeover`. Updated after every attempt, reprinted to the user after every brief.

### `evidence.md`

One entry per attempt, appended in order:

    ## T001 — attempt 1
    command: <the exact spawn command line>
    exit: 0 · terminal record: result · duration: 40s
    completion report: Files written: src/health.ts · Steps completed: all
    gates: PASS (test `# pass 5`) · drift: none
    outcome: done   (or: failed — <reason> · retrying (1) / halted — <signature> / escalated)

## Phase 1 — Briefs

`standard` first writes `spec.md` (Overview, Acceptance Criteria — each verifiable, Functional Requirements, Out of Scope) and `plan-notes.md` (Summary, `### New Files` / `### Modified Files` as path lines with an indented purpose line each, Key Implementation Details, Testing Strategy). Both modes then write `briefs/T001.md` … and `briefs/index.md` exactly per references/brief-format.md: template, the nine-section contract, the critical rules, and the skill additions (validation commands inside Tests, the four closing constraints, instruction-file rules). Read every file a brief names before writing its Current Code and Signature sections; never write them from memory.

## Phase 2 — Run

For each brief in `index.md` order, while every `depends_on` is `done`:

1. **Prompt.** Render `T00N/attempt-1.prompt.md` per references/implementer-prompt.md: preamble, body, closing line. Refuse a prompt whose first character is `-`.
2. **Spawn.** Build the implementer command from references/tool-recipes.md with the resolved model and effort; cwd = project root; output → `T00N/attempt-1.log`; timeout 20 minutes (Orchestration notes below for hosts that cap commands shorter). Append the entry to `evidence.md` as soon as the command line is known.
3. **Outcome.** Apply references/implementer-prompt.md §7: exit code, terminal record, the brief's file present in the changed set, a completion report that names a file. A failed outcome records `gates: not run · drift: not run` and goes straight to step 6.
4. **Gates.** typecheck → lint → test with narrowing, per references/gates.md; outputs verbatim into `validation.md`. Baseline failures do not count; new ones do.
5. **Drift.** Per references/gates.md; every attempt gets an entry in `drift.md`; any path entry fails the attempt.
6. **Ladder** on failure — halt signatures first, then spawn-failure signatures (both in references/tool-recipes.md), then:

| Rung | Who | Prompt (references/implementer-prompt.md) |
|---|---|---|
| recipe-fix (spawn failure only; consumes no retry) | the implementer, after the recipe is corrected | the original prompt again |
| local retry, up to 2 (or `workflow.max_retries`) | the implementer | attempt-2 / attempt-3 framing + error + body |
| hint | this session diagnoses (≤ 500 tokens, no code) into `T00N/hint.md`; the implementer retries once | hint framing + hint + error + body |
| takeover (skipped with `--no-escalate`) | this session edits the brief's file itself, then gates + drift like any attempt | the takeover instructions |

Exhausted → `escalated`; the run stops; later briefs stay `pending`. Halt → `halted`; the run stops.

7. **Record.** Update `progress.md` and `evidence.md`; reprint the table. Next brief only from `done`.

## Phase 3 — Review

1. Write `review-packet.md` per references/review-format.md: spec or briefs, the diff of the changed set against the baseline tree, `drift.md`, and the Recorded Validation Output (final attempt per brief, verbatim).
2. `review=<seat>` → spawn the reviewer recipe (read-only), packet as the prompt, 10-minute timeout, output → `review/attempt-1.log`. `review: session` → answer the packet yourself in a fresh pass over the packet file, never from memory of the run. Write the reply to `review.md`.
3. Parse verdict, criteria, findings per references/review-format.md. `fail` → only the briefs that own a Critical finding re-enter Phase 2, with the findings as the error block, attempt numbers continuing and the local-retry budget reset; then a fresh packet and review. Cap 2 review cycles.

## Hand-back

    ## SPLITBRIEF — <slug>
    crew: impl cmd:deepseek/deepseek-v4-flash@high · review session · mode quick
    run dir: .splitbrief/runs/2026-09-08-153000-health-endpoint/

    | Brief | File | Attempts | Rung | Gates | Drift | Status |
    |---|---|---|---|---|---|---|
    | T001 | src/health.ts | 1 | — | PASS | none | done |
    | T002 | src/router.ts | 3 | hint | PASS | none | done |

    ### Recorded validation output (final attempts)
    <verbatim — never summarized>

    ### Review
    verdict: pass_with_notes · criteria 4/4 PASS · findings: 0 critical · 1 warning · 2 notes
    <warnings and notes verbatim>

    Verdict: CLEAN — every brief done, all gates pass, review pass_with_notes, working tree ready for review (nothing committed)

Or honestly: `Verdict: STOPPED at T002 — <rung or halt>, <reason>` with the pending briefs listed and the fix (login command, model list, or the remaining error). No success line without the gate output pasted above it.

## Orchestration notes

- **Any host:** the pipeline needs three capabilities — read a file, run a shell command, write a file. Run the spawn in the foreground with the host's command timeout. When the host caps a command below 20 minutes, run it detached — `nohup sh -c '<command>' > <log> 2>&1 & echo $! > <run dir>/T00N/attempt-N.pid` — and poll `kill -0 $(cat <pid file>)` with the host's wait facility until it exits; the log is the outcome.
- **Claude Code:** commands cap at 10 minutes, so spawn with `run_in_background: true` and act on the completion notification. `--ask` and the crew question go through `AskUserQuestion`.
- **Cursor, OpenCode, Codex, Copilot, Antigravity, Command Code, Kilo:** foreground or detached spawn as above. `--ask` and the crew question are plain questions in the reply; on the user's next message read `.splitbrief/current-run`, then that run dir's `progress.md`, and continue from the first brief that is not `done`.
- The implementer inherits only the recipe's own flags. Never pass this session's permission bypass, API keys, or extra tools down.
