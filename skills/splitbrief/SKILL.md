---
name: splitbrief
description: >
  Use when this session should plan a task and a different coding tool should
  build it, spawned and supervised from here — "splitbrief", "delegate this to
  opencode/codex/cursor/cmd/claude", "you plan, X implements, Y reviews", "plan
  it here, let another tool build it". Compiles Product Task Briefs, runs the
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

`[mode]` — `quick` (default) | `standard` | `plan`. Tokens match exactly in first position; anything else is the task. The CLI defaults to `standard` in an isolation worktree; this skill defaults to `quick` in the working tree — the one documented divergence.
`impl=<tool>[:<model>][@<effort>]` — the implementer seat. Tools: `claude`, `codex`, `opencode`, `copilot`, `kilo`, `cursor`, `cmd`, `agy` (aliases `claude-code`, `command-code`, `antigravity`, `cursor-agent`, `kilo-code`, `github-copilot`). Split on the first `:` and the last `@`, so `impl=opencode:opencode-go/kimi-k3@high` is tool `opencode`, model `opencode-go/kimi-k3`, effort `high`.
`review=<seat>` — the reviewer seat, same grammar. Absent → `review: session`.
`--ask` — pause at the plan block for confirmation. Default: print and run.
`--yes` — only with `--ask`: keep the plan-block pause but apply gate-blocker fixes (references/gates.md, Baseline) without asking.
`--no-escalate` — the ladder stops at the hint rung; this session never implements a brief.
`<task | file>` — task text, or a path that exists on disk (notes, a spec, an issue export) read as the task.

Natural phrasing is accepted ("implementer is opencode with kimi-k3, reviewer is cursor"). Normalize it to the grammar and print the normalized crew in the plan block — the plan block is the record of what was parsed.

Crew fallback, per seat, first match wins: inline → `.splitbrief/config.yaml` (`implementer:` / `reviewer:` blocks with `kind: cli`: `tool`, `model`, `effort` or `variant`; `workflow.max_retries` replaces the default 2 local retries) → no implementer: run `command -v` over all eight binaries, ask one question listing the ones found with their auth status, and wait → no reviewer: this session.

## Modes

<!-- generated: modes-table -->
| Mode | Planner calls | Brief cap | Approval gates |
|---|---|---|---|
| `quick` | 1 | 5 | none |
| `standard` | 4 | 12 | spec, briefs |
| `speckit` | 6-7 | 12 | spec, plan, briefs |

Default: `quick`. Upgrade `quick` → `standard` when the plan exceeds 5 files or 5 briefs; above 12 briefs stop and recommend splitting the task.
<!-- /generated -->

`plan` runs Phase 0 and Phase 1, prints the plan block and the briefs, removes the run dir it created, and stops. Nothing remains on disk, nothing is spawned.

## Mandates

1. **The brief stands alone.** Nothing from this session's context reaches the implementer unless it is written into the brief. Code context is copied verbatim (references/brief-format.md), never summarized.
2. **Gates decide, not the implementer.** Every attempt that changed the brief's files is followed by the resolved gates and the drift check (references/gates.md). An implementer's "tests pass" is a claim; the recorded output is the fact.
3. **One brief, one slice, one process at a time.** Briefs run sequentially in dependency order. Never spawn two implementers at once.
4. **The ladder is bounded and halts are hard.** Local retries → hint → takeover, per brief. An auth error, a usage limit, a missing binary, or two consecutive timeouts stop the whole run and are reported with the fix — the next rung would silently hand the work back to this session.
5. **Review is evidence-bound.** The reviewer quotes the Recorded Validation Output or says validation was not recorded. A reviewer that asserts green tests from nowhere is wrong by construction.
6. **Nothing touches git.** No `git add`, `git commit`, `git stash`, no `.bak` files — not by this session, not by the implementer (the rule is in every brief's Constraints). The working tree is left for the human.
7. **Materialize before you move.** The run dir, `plan.md`, `progress.md`, and `evidence.md` exist on disk before the first spawn. `plan` mode is the only path that leaves nothing behind.
8. **Never substitute a seat.** A model the tool does not list, a tool that is not installed, or a reviewer that fails to spawn halts the run; it is never swapped for something else.

## Phase 0 — Preflight

1. **Instructions.** Read the project's instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*`, `.github/copilot-instructions.md`, whichever exist). Their rules become brief Constraints; a never-commit rule is copied into every brief verbatim.
2. **Crew.** Resolve both seats. For each: `command -v`, the version probe, the auth probe, and — when the tool lists models — confirm the requested model appears (references/tool-recipes.md). Any failure halts with the tool's own fix (login command or the model list).
3. **Gates.** Resolve typecheck, lint, test per references/gates.md and record the source of each.
4. **Baseline.** Run every gate once; record the tail. Blockers follow the unblock rule in references/gates.md.
5. **Run dir + tree.** Choose the run dir now — `.splitbrief/runs/$(date +%Y-%m-%d-%H%M%S)-<slug>/` (on collision append `-2`, `-3`, …) — create it, and record the baseline fingerprints in `baseline-sha.txt` there per references/gates.md. Nothing else is written yet.
6. **Shape.** Read the files the task touches at the exports-and-structure level. Cut the work into briefs, one verifiable slice each, dependency-ordered. Apply the upgrade rule.
7. **Plan block** — always printed:

    ## SPLITBRIEF preflight — <slug>
    task: <first line of the task>
    mode: quick · crew: impl cmd:deepseek/deepseek-v4-flash@high · review session
    tools: cmd 1.50.1 (auth ok, model listed) · review: session
    gates: typecheck `npx tsc --noEmit` (manifest) · lint `biome check .` (manifest) · test `vitest run` (manifest)
    baseline: typecheck PASS · lint PASS · test PASS (42 passed)
    briefs: 2 → T001 src/health.ts (create) · T002 src/router.ts +1 (modify, after T001)
    ladder: 2 local retries → hint → takeover (session)
    run dir: .splitbrief/runs/2026-09-08-153000-health-endpoint/
    gitignore: .splitbrief/ ignored   (or: NOT ignored — add it to .gitignore or expect the run dir in git status)

8. **Materialize, then move.** `plan` → after Phase 1 prints the briefs, `rm -r` the run dir and stop. Otherwise write `plan.md` (the block), `progress.md` (every brief `pending`), `evidence.md` (its first line, `# SPLITBRIEF evidence — <slug>`), and `.splitbrief/current-run` containing the run dir path — every host resumes from that pointer. `--ask` → stop and wait; options: run / change crew / change mode / narrow the task. Without `--ask`: continue in the same turn.

### `progress.md`

    # SPLITBRIEF progress
    task: <slug> · mode: quick · crew: impl cmd:… · review session · started: 2026-09-08 15:30

    | Brief | Files | Status | Attempts | Rung | Gates | Drift |
    |---|---|---|---|---|---|---|
    | T001 | src/health.ts | pending | 0 | — | — | — |
    | T002 | src/router.ts +1 | pending | 0 | — | — | — |

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
2. **Spawn.** Build the implementer command from references/tool-recipes.md with the resolved model and effort; cwd = project root; output → `T00N/attempt-1.log`; detached, with the waiter as the deadline (Orchestration notes below). Append the entry to `evidence.md` as soon as the command line is known.
3. **Outcome.** Apply references/implementer-prompt.md §7: exit code, terminal record, the brief's anchor file present in the changed set, a completion report that names a file. A failed outcome records `gates: not run · drift: not run` and goes straight to step 6.
4. **Gates.** typecheck → lint → test with narrowing, per references/gates.md; outputs verbatim into `validation.md`. Baseline failures do not count; new ones do.
5. **Drift.** Per references/gates.md; every attempt gets an entry in `drift.md`; any path entry fails the attempt.
6. **Ladder** on failure — halt signatures first, then spawn-failure signatures (both in references/tool-recipes.md), then:

<!-- generated: ladder-table -->
| Rung | Who runs it | Attempts | Consumes a local retry |
|---|---|---|---|
| `recipe-fix` | implementer | 1 | no |
| `local` | implementer | 2 | yes |
| `intermediate` | intermediate-implementer | 1 | yes (optional rung) |
| `hint` | planner-then-implementer | 1 | yes |
| `takeover` | planner | 1 | yes |
<!-- /generated -->

Exhausted → `escalated`; the run stops; later briefs stay `pending`. Halt → `halted`; the run stops.

7. **Record.** Update `progress.md` and `evidence.md`; reprint the table. Next brief only from `done`.

## Phase 3 — Review

1. Write `review-packet.md` per references/review-format.md: spec or briefs, the diff of the changed set against the baseline fingerprints, `drift.md`, and the Recorded Validation Output (final attempt per brief, verbatim).
2. `review=<seat>` → spawn the reviewer recipe (read-only), packet as the prompt, the reviewer deadline from references/tool-recipes.md, output → `review/attempt-1.log`. `review: session` → answer the packet yourself in a fresh pass over the packet file, never from memory of the run. Write the reply to `review.md`.
3. Parse verdict, criteria and findings per references/review-format.md §2, then apply its §3 fix cycle: a `fail` sends the briefs that own a Critical finding back through Phase 2 and a fresh packet follows, within the cycle cap stated there.

## Hand-back

    ## SPLITBRIEF — <slug>
    crew: impl cmd:deepseek/deepseek-v4-flash@high · review session · mode quick
    run dir: .splitbrief/runs/2026-09-08-153000-health-endpoint/

    | Brief | Files | Attempts | Rung | Gates | Drift | Status |
    |---|---|---|---|---|---|---|
    | T001 | src/health.ts | 1 | — | PASS | none | done |
    | T002 | src/router.ts +1 | 3 | hint | PASS | none | done |

    ### Recorded validation output (final attempts)
    <verbatim — never summarized>

    ### Review
    verdict: pass_with_notes · criteria 4/4 PASS · findings: 0 critical · 1 warning · 2 notes
    <warnings and notes verbatim>

    Verdict: CLEAN — every brief done, all gates pass, review pass_with_notes, working tree ready for review (nothing committed)

Or honestly: `Verdict: STOPPED at T002 — <rung or halt>, <reason>` with the pending briefs listed and the fix (login command, model list, or the remaining error). No success line without the gate output pasted above it.

## Orchestration notes

<!-- generated: wait-protocol -->
1. **Spawn.** One tool call, detached, writing `<run>/T00N/attempt-N.{pid,log,done}`: `nohup sh -c '<argv> > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`. The wait is never in the same tool call as the spawn — never `nohup … &` and the wait in one call, and never a command that begins with `sleep`.
2. **Wait.** A separate tool call running `scripts/wait-attempt.sh <run> <T00N> <n>`: it blocks until `.done` exists or the pid is gone and prints one line, `T00N attempt N: exit=<code>|timeout|missing-pid[ halt=<kind>]`. On Claude Code run it with `run_in_background: true` — the completion notification names the outcome; elsewhere run it in the foreground. The waiter is its own deadline (`--deadline 1200`); no coreutils `timeout` wrapper.
   Fallback, when the installer dropped `scripts/`: `n=0; until [ -f "$DONE" ] || [ "$n" -ge 1200 ]; do sleep 5; n=$((n+5)); done; cat "$DONE" 2>/dev/null || echo exit=timeout` — same deadline, no halt sniff, so read the halt phrases off the log yourself.
3. **Re-read every turn.** Every turn — user message, completion notification, hook follow-up, cron fire — begins with `cat .splitbrief/current-run` → `progress.md` → `scripts/wait-attempt.sh --reconcile <run>`, and rewrites every `running` row to `done` / `retrying` / `halted` before deciding anything. A running row whose pid is alive is never re-spawned.
4. **Monitor (Claude Code, optional).** A persistent `Monitor` on `tail -f <run>/events.log` filtering `done|failed|timeout|halted|run: complete` wakes the session on any terminal state. It is a whole-run wake, never the single-completion primitive — the waiter of point 2 stays.
5. **Stop-hook safety net.** Install `scripts/splitbrief-gate.sh` for the host: Claude Code `settings.json` `hooks.Stop`, Codex `~/.codex/hooks.json` `Stop`, Command Code `.commandcode/settings.json` `Stop`, Copilot `.github/hooks/*.json` `agentStop`, Cursor `.cursor/hooks.json` `stop` with `SPLITBRIEF_HOST=cursor`, Antigravity `hooks.json` `Stop` with `SPLITBRIEF_HOST=antigravity`. It is a safety net — every host caps consecutive continuations.
6. **`--plain` fast path.** When `command -v splitbrief` and `.splitbrief/config.yaml` both exist, `splitbrief start --plain "<feature>"` (or `splitbrief resume --plain`) is the whole loop in one command; read its lines from the `plain-shapes` block instead of running this protocol.
<!-- /generated -->

`--ask` and the crew question use the host's question facility (Claude Code: `AskUserQuestion`; other hosts: a plain question in the reply, resumed on the next message).

The implementer inherits only the recipe's own flags. Never pass this session's permission bypass, API keys, or extra tools down.

When the SPLITBRIEF CLI is installed and the project has a `.splitbrief/config.yaml`, `splitbrief start --plain "<task>"` (or `splitbrief resume --plain`) is the whole loop in one command, printing one line per event:

<!-- generated: plain-shapes -->
```
phase: implementing
task T001: done (typecheck lint test)
task T002: failed (test)
phase: complete
review: failed
done: 1 tasks, 128.4k tokens
```
<!-- /generated -->
