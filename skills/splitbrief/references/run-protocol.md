# Run protocol

Both `splitbrief` and `splitbrief-run` execute this procedure through review and bounded fixes.
The host session remains the planner. Run one implementer at a time, sequentially in dependency order.
The read-only review entry selects validation, review, and the reviewer's fix work. It never dispatches fixes.

## Input and selected stages

Resolve inspection before tool probes, planning, validation, or dispatch.
With `--status`, read the saved run and inspect its process records without waiting or changing them.
Print stage, selection, task statuses, live processes, attempts, consults, remaining bounds, decisions, and open findings; then return.
A status request authorizes no implementer or reviewer call.

For execution, select the entry stage from the input:

| Input | Admission | Entry stage |
|---|---|---|
| Existing typed plan or brief set | Use references/planning.md and references/brief-format.md for admission. | build |
| Prose plan | Convert to the typed contract while preserving the stated outcome. | conversion, then build |
| Stopped run directory | Load its saved progress and reconcile processes below. | the saved stage, including review or fixes |
| `error: <review.md>` | Load the review's plan, typed answer, evidence, and saved bounds. | saved review fix work |
| Single brief file | Select its task id from the owning plan or recover a complete typed contract. | dependency check, then build for that selection |

For `error:`, use references/recovery.md to append fixes with new ids, then validate and review again.
Read the saved fix part using references/recovery.md. Run the review again only when neither saved file holds it.

If the review has no owning plan or usable evidence, recover its stated intent before any dispatch.
For a single brief, check every dependency against recorded completion and current evidence first.
Pause on an unmet dependency; list it instead of silently executing additional plan tasks.
Keep unrelated tasks pending. Fixes for selected findings stay within the selected outcome.

Print the normalized crew, cadence, run directory, selection, and exact selected stages before the first dispatch.
Announce that `splitbrief-run` includes review and bounded fixes by default.
For continuation, print the saved stage and the remaining stages; preserve the saved selection unless explicitly changed.
A typical selection reads `stages: build → validation → review → bounded fixes`.
After admission, use the optional approval and protected confirmations from references/family-map.md.

## Preflight and saved progress

Read project instructions and the saved plan. Probe selected seats with references/tool-recipes.md.
Halt on unavailable seats with their diagnosis. Never silently substitute a seat.
Initialize a new baseline with references/gates.md; preserve an existing baseline on continuation or fixes.
Materialize the plan artifacts before spawning. Save `progress.md`, `evidence.md`, and `.splitbrief/current-run`.
Use this table so the waiter and optional stop hook read the same status column:

    | Task | Suggested files | Status | Attempts | Consults | Checks |
    |---|---|---|---|---|---|
    | T001 | src/health.ts | pending | 0 | 0 | not run |

Statuses are `pending`, `running`, `retrying`, `done`, `halted`, or `skipped`.
Save the active stage and next step beside the table, including review and fixes.
On a stop, retain the stage to resume and its task id, attempt, or review cycle.
Save the selected task ids, seats, cadence, approvals, lineage roots, revisions, input hashes, and process artifact paths.
Persist attempts, consults, run planner decisions, fix cycles, and extra allowances using references/recovery.md.
Keep the decisions ledger in `plan.json` using references/planning.md.
Update progress before each spawn and after each attempt, task, review, or planner decision.
Only current recorded checks produce `done`. A skipped task prevents a claim that the whole plan passed.

## Continuation and process reconciliation

Load the saved stage, plan, briefs, progress, decisions, consults, findings, counters, and original baseline.
Preserve completed tasks, attempts, lineage bounds, run bounds, decisions, and fix cycles.
Run `scripts/wait-attempt.sh --reconcile <run>` before spawning.
Also inspect every active attempt's `.pid`, `.done`, and log, including retrying tasks and the `review/` directory.
The helper reports running task rows only; those additional records still require reconciliation.
A live process remains the active attempt. Attach its waiter; never spawn a second process for it.
For a finished process, read its log and terminal result, then perform its saved validation or review parse step.
For a dead process without a terminal record, record the interrupted attempt and enter recovery with its existing counters.
Resume the saved stage after reconciliation. A saved review or fix stage does not restart the build.

For an older run whose next stage is `triage`, read the fix part from `review.json` first.
If absent, use the saved `triage.json` fields as that review's fix part, following references/recovery.md.
Run the review again only when neither file holds a fix part. Make no second planner call.
The session writes no new `triage.json`.
A completed run needs no dispatch; report its saved completion scope.

## Dispatch and validation

For each selected pending task whose dependencies are done:

1. Apply the stale-input procedure in references/recovery.md before dispatch.
2. Refresh suggested/context code, input hashes, and read-only Plan context from disk.
3. Save `T00N/attempt-N.prompt.md` using references/implementer-prompt.md.
4. Check the model context and prompt transport fit; refuse an oversized prompt.
5. Spawn with references/tool-recipes.md and wait using the protocol below.
6. Read the terminal result and advisory completion report.
7. Route blocked reports, proposed decisions, and failures through references/recovery.md.
8. Record touched files and reasons. At task cadence, run the task's checks and the due checks with references/gates.md. At end cadence, run the task's own checks, except a render check.
9. Mark the task done only after those checks pass. Update and print progress.
10. At task cadence, enter review for completed work before dispatching another task. That review runs the related tests the reviewer chooses.

Take an attempt-start snapshot of candidate bytes for recovery; preserve accepted earlier task changes.
Record command, exit, terminal result, report, changed paths, check results, and outcome in the evidence trail.

## Review cadence and fixes

At `cadence=end`, review after all selected tasks and after each fix cycle.
At `cadence=task`, also review after every completed task, scoped to completed tasks and criteria due so far.
A criterion is due when all current tasks serving it are done. Keep pending criteria listed separately.
SPLITBRIEF records a finding outside the task review scope as a note and refuses fix work for it.
For a one-task selection, review only the selected task, its appended fixes, and criteria due within that selection.
Criteria shared with unfinished tasks remain pending. Never claim the whole plan passed for one selected brief.
There is no batch review cadence. The final review runs every registered check and its reviewer checks first under references/gates.md.

Prepare the current packet and derive the verdict using references/review-format.md.
Apply the reviewer's fix work using references/recovery.md.
Persist the whole answer in `review.json` and save appended briefs before executing the fix tasks.
Execute authorized fix tasks through this same dispatch procedure.
Keep the saved fix cycle count; continuation never resets it.
For the review-only entry, hand back the review answer and fix briefs without executing them.

## Waiting

<!-- generated: wait-protocol -->
1. **Spawn.** One tool call, detached, writing `<run>/T00N/attempt-N.{pid,log,done}`: `nohup sh -c '<argv> > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`. The wait is never in the same tool call as the spawn — never `nohup … &` and the wait in one call, and never a command that begins with `sleep`.
2. **Wait.** Run `scripts/wait-attempt.sh <run> <T00N> <n>` in a separate tool call. It waits until `.done` exists or the pid is gone. It prints one line: `T00N attempt N: exit=<code>|timeout|no-done|missing-pid[ halt=<kind>]`. On Claude Code, use `run_in_background: true`. The completion notification names the outcome. Elsewhere, run it in the foreground. Add `--deadline <seconds>` only for an explicit limit. Without it, the waiter never kills the call. Monitor silence using references/tool-recipes.md.
   Fallback, when the installer dropped `scripts/`: `pid=$(cat "$PID"); until [ -f "$DONE" ] || ! kill -0 "$pid" 2>/dev/null; do sleep 5; done; cat "$DONE" 2>/dev/null || echo no-done`. For an explicit limit, set `N` to seconds and use `(pid=$(cat "$PID"); elapsed=0; until [ -f "$DONE" ] || ! kill -0 "$pid" 2>/dev/null; do [ "$elapsed" -ge "$N" ] && { echo exit=timeout; exit; }; sleep 1; elapsed=$((elapsed + 1)); done; cat "$DONE" 2>/dev/null || echo no-done)`. Read the halt phrases from the log. If an explicit limit expires, reconcile the recorded PID and its implementer children. Confirm they are gone, or stop them and confirm exit, before recovery or another dispatch.
3. **Re-read every turn.** Read `.splitbrief/current-run`, `progress.md` and `scripts/wait-attempt.sh --reconcile <run>`. Read a finished process's log and run its checks before marking the task done. Never re-spawn a live pid. Preserve counters and decisions.
4. **Monitor (Claude Code, optional).** A persistent `Monitor` on `tail -f <run>/events.log` filtering `done|failed|timeout|halted|run: complete` wakes the session on any terminal state. It is a whole-run wake, never the single-completion primitive — the waiter of point 2 stays.
5. **Stop-hook safety net.** If the user authorized a host hook, use `scripts/splitbrief-gate.sh`. It checks continuation, not task success. Recorded checks still decide.
<!-- /generated -->

For reviewer calls, use `review` as the waiter task id. Use a deadline only for an explicit limit.
Give each attempt distinct pid, log, and done paths, including reviewers.
Use only the recipe's flags; never forward this session's permissions or keys.

## Completion report

Print crew, cadence, selection, run directory, stage, task statuses, attempts, consults, and recorded checks.
Print the derived review verdict, pending criteria, open findings, and the next step.
Use `CLEAN` only for the entire plan when every task and criterion passes with no blocking finding.
For one selected brief, report `selection T001 complete` with its review result; state that remaining plan tasks were not selected.
Use `STOPPED at <task or stage> — <reason>` when required work or evidence remains.
Keep pending work and the complete evidence trail on disk.
