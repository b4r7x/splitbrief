# Dogfooding: developing SPLITBRIEF with SPLITBRIEF

The built CLI runs on its own repository. A stronger tool plans and reviews, a weaker one builds, and the operator (a person or a Claude session) watches the run, fixes the tool when the tool is what broke, and carries the same session on. This page is the operating procedure; the engine semantics it relies on are in [WORKFLOW.md](./WORKFLOW.md) and [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

Four rules, in force for every dogfooding run:

1. **Never commit or stage.** The operator leaves every change in the working tree; the owner commits between runs.
2. **Run the build you just made.** `npm run build` then `node dist/cli.js …`. The global `splitbrief` on PATH is whatever was installed last and is usually stale.
3. **A deterministic tool defect is fixed in the tool, in the same session.** Stop, fix `src/`, rebuild, `continue` the run. A brief that fails because the brief or the model is wrong is the run's business, not the tool's.
4. **Every run leaves a record.** Append what broke, why, and the fix to `.nuke/<date>-session-handoff.md` (untracked). The next context reads that first.

## 1. Preflight

```bash
cd <repo>
npm run build
SB="node $PWD/dist/cli.js"
$SB doctor --json | jq '.report.status, [.report.checks[] | select(.severity=="error")]'
```

`ready` or `ready-with-warnings` is go. A blocker names its remediation.

Seats live in `.splitbrief/config.yaml` (gitignored). The implementer is the seat that changes between runs; set effort in YAML because `--implementer <tool>` on the command line rebuilds the block from `{kind, tool}` and drops it.

```yaml
version: 3
planner: { kind: cli, tool: claude-code, model: opus, effort: high }   # fallback: fable
implementer: { kind: cli, tool: antigravity, model: gemini-3.8-flash-high, effort: high }
# implementer: { kind: cli, tool: claude-code, model: sonnet, effort: medium }
# implementer: { kind: cli, tool: codex, model: <id> }
validation: { typecheck: true, lint: true, test: true }
workflow: { approve: all, max_retries: 3, mode: standard, task_review: none }
```

Model ids come from the tool (`agy models`, `claude --model` aliases `opus`, `sonnet`, `fable`). No `reviewer:` block means the planner holds the review seat.

The task is a file, attached with `@`, kept next to the run's other inputs in `.splitbrief/inbox/<date>-<slug>/tasks.md` (gitignored). Write it for the planner: the goal, the invariants, what is out of scope, and the sizing rule that keeps briefs inside the implementer's limits:

- one module group per brief (a source file plus its colocated test), never two large modules in one brief;
- a brief must leave typecheck, lint and tests green on its own, so name every call site a deletion touches;
- an implementer that takes the prompt on argv (antigravity) refuses prompts over 120 KB.

## 2. Launch and gates

Interactive runs go through tmux so the operator can read the pane and type into it:

```bash
SCR=<scratch dir>
cat > "$SCR/launch.sh" <<EOF
#!/usr/bin/env bash
cd $PWD
node $PWD/dist/cli.js start --mode standard "<one sentence>" @.splitbrief/inbox/<run>/tasks.md 2>>"$SCR/splitbrief.stderr"
echo "SPLITBRIEF EXIT CODE: \$?"
sleep 100000
EOF
chmod +x "$SCR/launch.sh"
tmux kill-session -t sb 2>/dev/null; tmux new-session -d -s sb -x 140 -y 45 "$SCR/launch.sh"
```

Redirecting stderr matters: the TUI runs on the alternate screen, and a fatal error printed there is gone once the screen restores.

| Moment | Read first | Then |
|---|---|---|
| Planner question | the question block in the pane | `↑↓` choose, `⏎` next, `tab` writes a free answer, the last `⏎` sends all answers |
| Spec gate (`reviewing-spec`) | `.splitbrief/sessions/<id>/spec.md`: scope, out of scope, acceptance criteria | `y` approve, `c` request changes, `e` edit |
| Plan gate (`reviewing-plan`, only with `approve: all`) | `plan.md` | `y` |
| Briefs gate (`reviewing-briefs`) | `tasks.md`: one module group per brief, no new knobs, no brief planning for a red gate; per-brief declared-file bytes against the argv limit | `y` |
| Recovery panel | the reason line and the file list | type the action letter and `⏎`; on a task halt the letters are the action, free text is dropped |
| Stop sheet | — | `esc` opens it, `esc` again stops resumably, `ctrl+c` twice quits after the stop settles |

Headless: `$SB start --plain --approve none --yolo "<sentence>" @tasks.md`. Gates auto-approve, a planner question ends the run with `input_required`, and `kill -INT <pid>` parks the run cleanly (exit 0, status `open · paused`).

## 3. Watching a run

```bash
ID=$(jq -r .sessionId .splitbrief/active); S=.splitbrief/sessions/$ID
jq -r '.phase, (.pendingRecovery.reason // "-"), ([.tasks[] | .id + ":" + .status] | join(" "))' $S/state.json
tail -n 0 -F $S/session.jsonl | jq --unbuffered -r '(.type // .kind) as $t | select($t | test("text_delta|planner_text|activity|tool_use|usage|heartbeat|cost_update") | not) | .ts + " " + $t + " " + ((.data // {}) | del(.diff, .excerpt, .text) | tostring)[0:240]'
tmux capture-pane -t sb -p | sed 's/[[:space:]]*$//' | grep -v '^$' | tail -16
ps -o rss=,etime= -p $(pgrep -f 'dist/cli.js' | head -1)
```

Events worth acting on: `artifact_written`, `recovery_prompted{reason}`, `task_retry{attempt}`, `task_escalating`, `validate{status:"done",passed}`, `paused_external_changes`, `runner_call_stalled`, `workflow_complete{review}`.

Silence now means no frames. Every admitted tool is spawned in a streaming output mode — antigravity included, on `--output-format stream-json` — so a working child emits a frame per step and the idle watchdog measures the gap between frames, not the gap between documents. `runner_call_stalled` therefore means the tool has printed nothing for 5 minutes, which is worth looking at rather than waiting out; the watchdog still kills only after 30 minutes. Before killing a child, look for its own activity trail: antigravity writes step records to `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/chunks/transcript_full/*.jsonl` (`ls -t … | head -1`, then `tail -1`); a record younger than a minute is a working agent.

Memory: the process should sit in the hundreds of MB. Growth of more than a few MB per second is a leak; `kill -USR2 <pid>` writes a heap snapshot when the run was started with `NODE_OPTIONS=--heapsnapshot-signal=SIGUSR2`.

## 4. The autofix loop

The question at every failure is *who* failed. The run owns model mistakes and brief mistakes: the ladder retries, the recovery panel offers retry, skip, seat switch. The operator owns tool mistakes: a crash, a limit that ended a healthy call, a parser that dropped a document, a gate that lied. Those are fixed now, because the next brief hits the same code.

```bash
# 1. stop: esc, esc (resumable) — or ctrl+c ctrl+c, or kill -INT <pid> on a headless run
# 2. fix src/, keep the change minimal, run the colocated tests
# 3. rebuild
npm run build
# 4. carry the same session on
$SB continue $ID                     # picks up at the first artifact not on disk, or the parked step
$SB continue $ID --action retry      # when the run stopped on a recovery: retry | skip | switch-seat:<tool>[:<model>] | end-run
```

What `continue` does with the saved state (`src/engine/orchestrator/run/init.ts`, `src/core/sessions/run-status.ts`):

| Stopped where | On continue |
|---|---|
| During a planner step | every step whose artifact exists on disk is skipped; the cut step is re-issued whole, on the resumed native session when the tool has one |
| Parked mid-brief (`esc esc`, `ctrl+c`, `kill -INT`) | the brief continues at the same attempt with its partial edits and a `[Continuation]` note; the worktree is reused |
| Crashed mid-brief (no `interruptedStep`) | the brief restarts at attempt 0 with its declared files restored |
| On a recovery | nothing runs until `--action` or the panel answers it |

Orphaned runner processes from a crash are reaped at the next start (`runner-pids.jsonl`). The code the run itself promotes into the tree does not reach the running orchestrator: a fix the run built for its own benefit needs the same stop → build → continue.

When the planner's output was lost by the tool but is in the log, rebuild the artifact rather than pay for the call again: concatenate the call's `runner_call_text_delta` rows, repair what the split broke, write the file into the session directory, then `continue --action retry`. The step is memoized by the file's presence.

## 5. Swapping a seat

Between runs, edit `.splitbrief/config.yaml`. Inside a run, `/crew build` (or `plan`, `review`) opens that seat's picker, where the tool, its model and its effort are all chosen; committing writes them to `.splitbrief/config.yaml` and the panel says `<SEAT> seat changes after this brief`. The change is taken at the next brief boundary, not mid-brief: the current brief finishes on the seat it started on, then the run re-prepares itself in place on the saved config, prints the seat change, and builds the next brief on the new seat.

From the shell, `continue --implementer <tool> --implementer-model <id>` or `--planner-model fable`. Those flags are now the config of record too: the resulting seat block is written back to `.splitbrief/config.yaml` through the comment-preserving writer, and the CLI prints `<SEAT> seat recorded in .splitbrief/config.yaml` for each seat it moved. A moved plan seat drops the planner's native session and rebuilds context from the transcript. A stopped run continued on a different implementer simply builds the remaining briefs with it.

## 6. When to stop fixing and plan instead

A brief that fails the same way twice because of a fixed setting of the tool (a prompt line, an adapter flag, a gate rule, a default) is not a retry problem. Note it, let the run finish or end it, then plan the setting change as its own piece of work with `/sota`. Symptoms: the implementer declines with the same words every attempt, a validation stage fails on something no brief can touch, a limit trips on a healthy call.

## 7. Smoke test: stop, continue, finish

Zero tokens. A throwaway git repo whose planner and implementer are local node scripts (`testing/e2e/helpers/stop-continue-fixture.ts`): the planner is a `kind: shell` script that prints the one Task Brief, then the review reply, branching on the prompt's “Final Implementation Review” title; the implementer is a `kind: agent` script that writes its two declared files in two steps with a four-second hold between them. It has to be a direct writer — the brief declares two files, and an extracting runner can carry only one back — and its seat declares a `contextLength`, because routing refuses a profile whose window it cannot prove the brief fits.

The CLI is spawned from source the way the live harness does it — `node --import tsx src/cli.ts …` through `spawnCli`, detached so one signal reaches the tool subprocess with it — so no build step stands between a fix and the smoke.

The brief runs in the run's isolation worktree, so the marker the test waits on appears under the fixture's own state home, not in the project: nothing reaches the project until the brief's changes are promoted.

```
testing/e2e/scenarios/stop-continue.test.ts   (sequential e2e project, testTimeout 120 s)
  1. spawn  node --import tsx src/cli.ts start --plain --mode quick --approve none --allow-repo-runners --project <fixture> "smoke"
  2. wait   until src/marker.ts appears under <stateHome>/splitbrief/trees (<= 45 s)
  3. kill   the process group with SIGINT; expect exit 0; state.json: interruptedStep.cut === 'mid-step',
            task T001 in_progress, no pendingRecovery, and src/greet.ts not in the project
  4. spawn  node --import tsx src/cli.ts continue --plain --allow-repo-runners --project <fixture>
  5. assert assertPlainStdout for quick mode, plus the lines `task T001: done (no gates)`, `review: passed`, `done: 1 tasks`
  6. assert state.json: tasks[0].status === 'done', attempt unchanged from the park, no pendingRecovery
  7. assert session.jsonl has no `paused_external_changes` with conflict kind `current-task-conflict`,
            no `own_partial_output_kept` warning and no `Discarded …` warning, and src/greet.ts holds the written code
```

Step 7 is what a resumable park earns: the same attempt continues in the same worktree, so the marker it left stands, nothing is discarded, and nothing is mistaken for a user edit. `own_partial_output_kept` belongs to a brief whose partial reached the project, which an isolated run never produces.

A second case sends `SIGKILL` to the group instead of `SIGINT`: the CLI reports no exit code and writes no `interruptedStep`, so the continued run starts the brief fresh, reseeds its worktree (`session.jsonl` carries `Discarded 1 unpromoted change(s) an earlier attempt left in the isolation worktree: src/marker.ts`), and still ends on `task T001: done` with `src/greet.ts` holding the written code. Both cases run inside `npm run test:e2e`; there is no live-seat tier of this smoke.

## 8. Record of the 2026-09-21 run

Found and fixed in-session: React ran its development build because the CLI never set `NODE_ENV` (4 GB heap in 23 minutes, `src/node-env.ts`); a planner reply split across messages lost everything but its last message (`reconcileFinalText`); the 96 KB declared-artifact bound rejected a 140 KB `tasks.md` after the call had finished. Found and deferred: a stop inside `validating-task` or `escalating` restarts the brief; the crash-restore snapshot is never persisted; the `--plain` `done:` line no longer matches `assertPlainStdout`; `splitbrief ps` is referenced but not registered; the help example names a removed `anthropic` planner. Details in `.nuke/2026-09-21-session-handoff.md`.
