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
2. **One brief, one outcome, one process at a time.** Dependency order from `index.md`; never two implementers at once.
3. **The ladder is bounded and halts are hard.** Local retries → hint → takeover per brief; auth, usage, missing binary, or two consecutive timeouts halt the run with the fix printed.
4. **Nothing touches git.** Not this session, not the implementer.
5. **Never substitute a seat.** Unlisted model or missing tool → halt, never a swap.

## Phase 0 — Preflight

1. Resolve the implementer; `command -v`, version and auth probes, model listing check (references/tool-recipes.md).
2. Resolve gates and run the baseline (references/gates.md). The run dir is the briefs' own run dir when they live in one; otherwise create `.splitbrief/runs/$(date +%Y-%m-%d-%H%M%S)-<slug>/` now. Record the baseline fingerprints in `baseline-sha.txt` there (references/gates.md), overwriting the ones left by `splitbrief-brief` (edits made between briefing and running are not drift) — except under `error:`, where the original baseline stays so the fix cycle's diff is cumulative.
3. Load the briefs; verify each has the frontmatter fields `id`, `title`, `action`, `file` (plus `files` when the slice writes more than the anchor), `depends_on` and the sections `### Description`, `### Implementation Steps`, `### Tests`, `### Scope`, `### Constraints`; a brief missing one stops the run before any spawn, naming the brief and the section.
4. Print the plan block:

    ## SPLITBRIEF preflight — <slug> (run only)
    briefs: <dir> · 2 → T001 src/slugify.ts +1 (create) · T002 src/index.ts (modify, after T001)
    crew: impl cmd:deepseek/deepseek-v4-flash@high (auth ok, model listed)
    gates: typecheck `npx tsc --noEmit` (manifest) · lint none · test `npm test` (default)
    baseline: typecheck PASS · test PASS (12 passed)
    ladder: 2 local retries → hint → takeover (session)
    run dir: <the briefs' run dir, or the new .splitbrief/runs/<stamp>-<slug>/>
    gitignore: .splitbrief/ ignored   (or: NOT ignored — add it to .gitignore or expect the run dir in git status)

5. `--ask` → wait. Otherwise write `plan.md` (append a `## run` section when the run dir already has one), `progress.md` (every brief `pending`; Status `pending` · `running` · `retrying (n)` · `done` · `escalated` · `halted`; Rung `—` · `retry` · `recipe-fix` · `hint` · `takeover`), `evidence.md` (one entry per attempt: command, exit + terminal record, completion report, gates + drift, outcome), and `.splitbrief/current-run` with the run dir path; then continue. **Resume:** when the run dir already has a `progress.md`, keep it — rows `done` stay done, every other row is re-run from the first one that is not `done`, attempt numbers continue, and the `## run` section records the new crew. This is how a halted run continues on another seat: `splitbrief-run impl=<next seat> <run dir>`.

## Phase 2 — Run

For each brief in order, while every `depends_on` is `done`:

1. **Prompt** — `T00N/attempt-1.prompt.md` per references/implementer-prompt.md (preamble, body, closing line). Refuse a prompt starting with `-`.
2. **Spawn** — the implementer recipe from references/tool-recipes.md; cwd = project root; output → `T00N/attempt-1.log`; detached, with the waiter as the deadline (Orchestration notes below). Append the command line to `evidence.md`.
3. **Outcome** — references/implementer-prompt.md §7: exit code, terminal record, the brief's anchor file in the changed set, a completion report naming a file. A failed outcome records `gates: not run · drift: not run` and goes to step 6.
4. **Gates** — typecheck → lint → test with narrowing; verbatim into `validation.md`.
5. **Drift** — per references/gates.md; every attempt gets an entry in `drift.md`; any path entry fails the attempt.
6. **Ladder** on failure — halt signatures first, then spawn-failure signatures (`recipe-fix`: correct the recipe, re-spawn the original prompt as the next attempt, no retry consumed), then local retries (2, or `workflow.max_retries`) → hint (`T00N/hint.md`, ≤ 500 tokens, no code, one implementer retry) → takeover (this session edits the file, then gates + drift), unless `--no-escalate`. Signatures: references/tool-recipes.md; framings and prompts: references/implementer-prompt.md.
7. **Record** — `progress.md` row (`pending` · `running` · `retrying (n)` · `done` · `escalated` · `halted`), reprint the table.

## Hand-back

    ## SPLITBRIEF run — <slug>
    crew: impl cmd:deepseek/deepseek-v4-flash@high
    run dir: <path>
    | Brief | Files | Attempts | Rung | Gates | Drift | Status |
    |---|---|---|---|---|---|---|
    | T001 | src/slugify.ts +1 | 1 | — | PASS | none | done |
    ### Recorded validation output (final attempts)
    <verbatim>
    Verdict: DONE — every brief done, all gates pass (nothing committed) · next: splitbrief-review intent: <run dir>

Or `Verdict: STOPPED at T00N — <rung or halt>, <reason>` with pending briefs and the fix.

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

`--ask` uses the host's question facility (Claude Code: `AskUserQuestion`; other hosts: a plain question, resumed on the next message).

The implementer gets only the recipe's flags — never this session's permissions or keys.
