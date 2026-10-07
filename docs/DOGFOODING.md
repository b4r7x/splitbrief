# Dogfooding: developing SPLITBRIEF with SPLITBRIEF

The built CLI runs on its own repository. A stronger tool plans and reviews, a weaker one builds, and the operator watches the run. A tool defect that blocks the run ends it; the fix lands between runs, and a new run starts on the new build. The self-contained [splitbrief-babysit skill](../skills/splitbrief-babysit/SKILL.md) supplies the supervision protocol and bundled watcher. This page explains the engine semantics, with further details in [WORKFLOW.md](./WORKFLOW.md) and [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

Four rules, in force for every dogfooding run:

1. **Never commit or stage.** The operator leaves every change in the working tree; the owner commits between runs.
2. **Run the build you just made.** `npm run build` then `node dist/cli.js …`. The global `splitbrief` on PATH is whatever was installed last and is usually stale.
3. **A tool defect that blocks the run ends the run.** Choose End run, so the run closes and keeps every file it wrote and its ledger. Then fix the cause in the checkout, verify it with the gates, rebuild, let the owner commit, and start a **new** run. Nobody edits the checkout and nobody rebuilds while a run lives: `npm run build` deletes `dist/` under the running CLI. A cosmetic defect goes to the debt list (a `Debt` section in `babysit.md`) and the run goes on. A weak seat output is corrected in the composer, not in code. A brief or model mistake handled correctly by the tool remains the run's business.
4. **Every run leaves a record.** Append each defect, repair, and verification result to `.splitbrief/sessions/<id>/babysit.md`. The next supervisor reads that record first.

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
workflow: { approve: plan }
```

Model ids come from the tool (`agy models`, `claude --model` aliases `opus`, `sonnet`, `fable`). No `reviewer:` block means the planner holds the review seat.

The task is a file attached with `@`, for example `.nuke/<date>-<topic>/tasks/<id>.md` or `.splitbrief/inbox/<date>-<slug>/tasks.md` (both gitignored). If the task file's first line gives the exact launch command, use it without its seat flags; seats come from `.splitbrief/config.yaml`. Write the task for the planner: the goal, the invariants, what is out of scope, and the sizing rule that keeps briefs inside the implementer's limits:

- one module group per brief (a source file plus its colocated test), never two large modules in one brief;
- a brief must leave typecheck, lint and tests green on its own, so name every call site a deletion touches;
- an implementer that takes the prompt on argv (antigravity) refuses prompts over 120 KB.

## 2. Launch and gates

Readability does not depend on tmux settings. SPLITBRIEF maps every token to a readable value at 256 colours.
Add `set -as terminal-features ',xterm-ghostty:RGB'` only for exact truecolor values inside tmux. Use the outer `$TERM` instead of `xterm-ghostty` when needed.

Interactive runs go through tmux so the operator can read the pane and type into it:

```bash
SCR=<scratch dir>
cat > "$SCR/launch.sh" <<EOF
#!/usr/bin/env bash
cd $PWD
node $PWD/dist/cli.js start "<one sentence>" @.splitbrief/inbox/<run>/tasks.md 2>>"$SCR/splitbrief.stderr"
echo "SPLITBRIEF EXIT CODE: \$?"
sleep 100000
EOF
chmod +x "$SCR/launch.sh"
tmux kill-session -t sb 2>/dev/null; tmux new-session -d -s sb -x 140 -y 45 "$SCR/launch.sh"
tmux set-option -t sb window-size manual
```

Redirecting stderr matters: the TUI runs on the alternate screen, and a fatal error printed there is gone once the screen restores.

The owner watches live with `tmux attach -r -t sb`. A read-only attach never resizes the window; `window-size manual` keeps 140x45 when the owner attaches without `-r`. Read-only attach cannot scroll, because the TUI runs on the alternate screen. To scroll, the owner attaches without `-r` and uses the TUI's own keys (`shift+↑↓`, `pgup`/`pgdn`), only when the operator agrees, because a writable client sends keys to the run. Otherwise the owner reads `babysit.md`.

| Moment | Read first | Then |
|---|---|---|
| Planner question | the question block in the pane | `↑↓` choose, `⏎` next, `tab` writes a free answer, the last `⏎` sends all answers |
| Plan card (`reviewing-plan`, with `approve: plan`) | `.splitbrief/sessions/<id>/plan.md`: summary, acceptance criteria, protected writes, one task per coherent outcome, no task planning for a red gate | `↑↓` choose a row and `⏎` take it — approve, request changes, edit `plan.json`, end the run; or type `approve`, `comment <text>`, `edit` or `end-run` and `⏎` |
| Recovery panel | the title line (`Needs you · <cause>` or `Seat down · <cause>`) and the file list | press the action's letter, or `⏎` on the highlighted row; at a task halt, typed free text retries the brief with that text as the implementer's correction; `w` (switch seat) opens the halted seat's picker on the offered tool, where tool and model are chosen |
| Stop sheet | — | `esc` opens it, `esc` again stops resumably, `ctrl+c` twice quits after the stop settles |

Headless: `$SB start --plain "<sentence>" @tasks.md`. The plan card is approved unattended (`workflow.approve: none` skips it), a planner question ends the run with `input_required`, and `kill -INT <pid>` parks the run cleanly (exit 0, status `open · stopped`).

## 3. Watching a run

```bash
ID=$(jq -r .sessionId .splitbrief/active); S=.splitbrief/sessions/$ID
jq -r '.phase, (.pendingRecovery.reason // "-"), ([.tasks[] | .id + ":" + .status] | join(" "))' $S/state.json
tail -n 0 -F $S/session.jsonl | jq --unbuffered -r '(.type // .kind) as $t | select($t | test("text_delta|planner_text|activity|tool_use|usage|heartbeat|cost_update") | not) | .ts + " " + $t + " " + ((.data // {}) | del(.diff, .excerpt, .text) | tostring)[0:240]'
tmux capture-pane -t sb -p | sed 's/[[:space:]]*$//' | grep -v '^$' | tail -16
ps -o rss=,etime= -p $(pgrep -f 'dist/cli.js' | head -1)
```

Events worth acting on: `artifact_written`, `recovery_prompted{reason}`, `task_retry{attempt}`, `task_escalating`, `validate{status:"done",passed}`, `runner_call_stalled`, `workflow_complete{review}`.

Silence now means no frames. Every admitted tool is spawned in a streaming output mode — antigravity included, on `--output-format stream-json` — so a working child emits a frame per step and the idle watchdog measures the gap between frames, not the gap between documents. `runner_call_stalled` therefore means the tool has printed nothing for 5 minutes, which is worth looking at rather than waiting out; the watchdog still cuts only after 20 minutes with no event and no running child process. Before killing a child, look for its own activity trail: antigravity writes step records to `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/chunks/transcript_full/*.jsonl` (`ls -t … | head -1`, then `tail -1`); a record younger than a minute is a working agent.

Memory: the process should sit in the hundreds of MB. Growth of more than a few MB per second is a leak; `kill -USR2 <pid>` writes a heap snapshot when the run was started with `NODE_OPTIONS=--heapsnapshot-signal=SIGUSR2`.

## 4. Tool defects: end the run, fix, start a new run

Classify every failure before allowing further work. There are three classes:

1. **A tool defect that blocks the run** — a crash, a lost document, incorrect state, a false alarm, broken recovery, or a weak flow that leaves no way forward (a dead end, a wait with no feedback). End the run, fix the tool, and start a new run.
2. **A cosmetic defect** — an incorrect counter, label, copy or rendering, or a weak flow the run can still get through. Record it in the debt list with evidence; the run goes on.
3. **A weak seat output** — a bad split, a misread task, a weak reply. Correct it in the composer; no code changes. A model mistake the tool handles correctly needs nothing: the retry ladder and the recovery panel own it.

An uncertain cause needs a resumable stop for diagnosis, without code edits. Expected warnings and correctly reported provider limits use normal recovery. Never retry unchanged code or defer a blocking tool defect until the final review.

```bash
# 1. end the run: esc, then End run (or /end); a run parked on a recovery: $SB continue $ID --action end-run
# 2. confirm cleanup and process exit; record the defect in babysit.md
# 3. fix the cause in the checkout; run regression tests, affected suites and typecheck; npm run release-check
# 4. rebuild; the owner commits
npm run build
# 5. start a new run on the new build
$SB start "<one sentence>" @<task file>
```

Inspect visual and flow fixes with the look-and-logic loop in `CLAUDE.md`. In the new run, reproduce the original interaction and record the result. If it still fails, end that run too. Never continue the ended run after a tool fix, and never skip a brief to bypass a tool defect.

`continue` still serves a run that stopped for a reason other than a tool defect: a resumable stop for diagnosis, a quit, a crash of the host, a provider limit, or a parked recovery. No code changed and no rebuild happened while it was stopped, so the run carries on in the build it started with:

```bash
$SB continue $ID                     # picks up at the step its saved state names, or the parked step
$SB continue $ID --action retry      # when the run stopped on a recovery: retry | skip | switch-seat:<tool>[:<model>] | end-run
```

What `continue` does with the saved state (`src/engine/orchestrator/run/init.ts`, `src/core/sessions/run-status.ts`):

| Stopped where | On continue |
|---|---|
| During a planner step | the planning session picks up at the step its saved state names (`resumeStep`); the cut call is re-issued whole, on the resumed native session when the tool has one |
| Parked mid-brief (`esc esc`, `ctrl+c`, `kill -INT`) | the brief continues at the same attempt with its partial edits and a `[Continuation]` note; the worktree is reused |
| Crashed mid-brief (no `interruptedStep`) | the brief restarts at attempt 0; its declared files in the run workspace are restored from its task-start snapshot |
| On a recovery | nothing runs until `--action` or the panel answers it |

Orphaned runner processes from a crash are reaped at the next start (`runner-pids.jsonl`). The code the run builds stays in its run workspace until Apply, and never reaches the running orchestrator: a fix the run built for its own benefit takes effect in the next run, after Apply, the owner's commit and a rebuild.

When the planner's output was lost by the tool, there is no artifact to rebuild by hand: the planning session is one typed call loop. Retry the planning step (`continue --action retry` on its halt); a loss that repeats is a tool defect that blocks the run (§6).

## 5. Swapping a seat

Between runs, edit `.splitbrief/config.yaml`. Inside a run, `/crew build` (or `plan`, `review`) opens that seat's picker, where the tool, its model and its effort are all chosen; committing writes them to `.splitbrief/config.yaml` and the panel says `<SEAT> seat changes after this brief`. The change is taken at the next brief boundary, not mid-brief: the current brief finishes on the seat it started on, then the run re-prepares itself in place on the saved config, prints the seat change, and builds the next brief on the new seat.

From the shell, `continue --implementer <tool> --implementer-model <id>` or `--planner-model fable`. Those flags are now the config of record too: the resulting seat block is written back to `.splitbrief/config.yaml` through the comment-preserving writer, and the CLI prints `<SEAT> seat recorded in .splitbrief/config.yaml` for each seat it moved. A moved plan seat drops the planner's native session and rebuilds context from the transcript. A stopped run continued on a different implementer simply builds the remaining briefs with it.

## 6. Deterministic failures and blocked repairs

A deterministic failure caused by a tool prompt, adapter flag, gate, or default is a tool defect that blocks the run. End the run when it is detected, diagnose the cause, fix it, and start a new run (§4). Do not let the run finish through repeated identical failures. If a repair needs an unauthorized product decision or unavailable credentials, keep the run parked and edit nothing. Report the concrete blocker and the saved run ID. Record the options in the defect record and ask the owner. Do not invent the decision. The code change that the decision brings follows the §4 path.

## 7. Smoke test: stop, continue, finish

Zero tokens. A throwaway git repo whose planner and implementer are local node scripts (`testing/e2e/helpers/stop-continue-fixture.ts`): the planner is a `kind: shell` script that prints the one Task Brief, then the review reply, branching on the prompt's “Final Implementation Review” title; the implementer is a `kind: agent` script whose first invocation writes the marker file, then holds for the fixture's release file — 180 seconds is the backstop, not the pace. Every later invocation writes both declared files at once and finishes, so the same script serves the cut attempt and the resumed one. Writing directly is what the test needs: it signals the run on the marker the implementer writes into the worktree itself while the call is still open, which a reply extracted after the call returns could not carry. Its seat declares a `contextLength`, because routing refuses a profile whose window it cannot prove the brief fits.

The CLI is spawned from source the way the live harness does it — `node --import tsx src/cli.ts …` through `spawnCli`, detached so the test can signal the CLI's process group — so no build step stands between a fix and the smoke. The engine starts the implementer in a process group of its own, so the signal reaches only the CLI: a `SIGINT` reaches the implementer through the CLI's abort, a `SIGKILL` leaves it running.

The brief runs in the run's isolation worktree, so the marker the test waits on appears under the fixture's own state home, not in the project: nothing reaches the project before Apply.

```
testing/e2e/scenarios/stop-continue.test.ts   (sequential e2e project, 240 s per case)
  1. spawn  node --import tsx src/cli.ts start --plain --allow-repo-runners --project <fixture> "smoke"
  2. wait   until src/marker.ts appears under <stateHome>/splitbrief/trees (<= 75 s)
  3. kill   the process group with SIGINT; expect exit 0; state.json: interruptedStep.cut === 'mid-step',
            task T001 in_progress, no pendingRecovery, and src/greet.ts not in the project
  4. spawn  node --import tsx src/cli.ts continue --plain --allow-repo-runners --project <fixture>
  5. assert assertPlainStdout, plus the lines `task T001: done (no gates)`, `review: passed`, `done: 1 tasks`
  6. assert state.json: tasks[0].status === 'done', attempt unchanged from the park, no pendingRecovery
  7. assert the checkout is as it started; Apply the ready run, expect `Applied 2 files to your checkout.`,
            state.json closed as `applied`, and src/marker.ts and src/greet.ts in the checkout hold the written code
```

Steps 6 and 7 are what a resumable park earns: the same attempt continues in the same worktree, so the marker it left stands and nothing is discarded. The checkout receives the brief's files once, at Apply, and not before.

A second case sends `SIGKILL` to the group instead of `SIGINT`: the CLI reports no exit code and writes no `interruptedStep`, and the implementer is left running inside its hold. The test reaps nothing itself — the continuation owns that cleanup, which is what this case exercises: it asserts the orphan is still alive after the kill, then that the continued run's boot has reaped it and released its ledger entry before the brief runs. The continued run then starts the brief fresh at attempt 0 in the same worktree, restores the brief's declared files from its task-start snapshot, and still ends on `task T001: done`; Apply then writes both files into the checkout. Both cases run inside `npm run test:e2e`; there is no live-seat tier of this smoke.

## 8. Record of the 2026-09-21 run

Found and fixed in-session: React ran its development build because the CLI never set `NODE_ENV` (4 GB heap in 23 minutes, `src/node-env.ts`); a planner reply split across messages lost everything but its last message (`reconcileFinalText`); the 96 KB declared-artifact bound rejected a 140 KB `tasks.md` after the call had finished. Found and deferred: a stop inside `validating-task` or `escalating` restarts the brief; the crash-restore snapshot is never persisted; the `--plain` `done:` line no longer matches `assertPlainStdout`; `splitbrief ps` is referenced but not registered; the help example names a removed `anthropic` planner. Details in `.nuke/2026-09-21-session-handoff.md`.
