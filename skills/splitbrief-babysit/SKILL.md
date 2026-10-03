---
name: splitbrief-babysit
description: Supervise the built SPLITBRIEF CLI while it develops its own repository. Use for "odpal splitbrief i pilnuj go", "run splitbrief and babysit it", or a supervised dogfooding run. A tool defect that blocks the run ends it; fix and verify it, rebuild, then start a new run.
metadata:
  author: b4r7x
  version: "1.0.0"
  argument-hint: "<task or task file> [run-id to continue]"
---

# Babysit a SPLITBRIEF run

The built CLI runs on its own repository. This skill contains the supervision and recovery procedure, including its watcher.

Read the target repository's agent instructions. No other skill, private run script, handoff file, or external service is required by this skill.
The run uses the repository's Node.js, npm, Git, dependencies, and configured coding tools.
When `tmux` is on PATH, every run launches in a named tmux session so the owner can watch it live. Without tmux, use an interactive terminal supplied by the host.
Do not install tmux or change the host configuration automatically.

Resolve `SKILL_DIR` to the directory containing this installed `SKILL.md`. All helper paths are relative to that directory.

**A SPLITBRIEF defect that blocks the run ends the run. Fix it between runs, then start a new run.**
Nobody edits the checkout and nobody rebuilds while a run lives: `npm run build` deletes `dist/` under the running CLI.
A cosmetic defect goes to the debt list and the run goes on. A weak seat output is corrected in the composer, not in code.
Do not defer a blocking defect to the final review, retry through it, or skip the affected brief.

## Roles and contexts

One agent owns the live terminal. If delegation is available, use a babysitter and a fresh fix agent for each defect.
Otherwise this session watches, ends the run, fixes, and starts the new run sequentially. No particular model or agent framework is required.

| Role | Context | Does | Never |
|---|---|---|---|
| **Orchestrator** (this session) | reports and decisions | spawns agents, reads their reports, confirms that a defect blocks the run, tells the babysitter when to start the new run | reads the whole log; edits source while a run lives or another agent owns the repair |
| **Babysitter** (one long-lived subagent) | the whole run | owns the terminal, watches, answers prompts, records cosmetic defects in the debt list; on a blocking tool defect ends the run (End run), quits the TUI and reports with evidence | edits source; ends the run for anything but a blocking tool defect |
| **Fix agent** | the babysitter's report | after the run ended, diagnoses and fixes **directly in the main checkout**, no worktree; proves a logic fix with a regression test, affected suites, and `npm run typecheck`; renders and inspects a visual or flow fix | edits while a run lives; broadens the task beyond detected tool defects |
| **Validation** (fresh, only when called for) | the fix agent's report and the diff | added only when a fix touches trust classification, config persistence, the run state machine or the event schema; checks the fix against real behaviour and every gate | reuses an earlier agent's context |

Apply the role separation when using subagents. Without delegation, the session takes these roles in sequence, with source edits only after the run ended.
Use separate scratch directories for agents. Before replacing a babysitter, stop or confirm the previous watcher has relinquished the terminal.
Never let two agents drive one run. Pass the run ID, terminal handle, watcher cursor, and defect record to the replacement.

## The babysitter drives the TUI as a real user would

Navigate the running tool with its keyboard controls for questions, approval gates, external-edit prompts, recovery, seat selection, and stopping.
Inspect the rendered terminal after each action. A working key does not excuse an incorrect label, counter, render, or flow.

Start a new run after a tool fix. Answer live prompts through the TUI.
Never hand-edit `state.json` or configuration to bypass a defect. Do not replace a broken interaction with a shortcut and call it verified.

Worked example — a usage limit opens a recovery panel with `switch-seat` recommended. The babysitter answers *that panel* and picks the fallback tool and model *in the seat picker it opens* (`pickSwappedSeat`, `src/features/workflow/recovery-driver.ts`). That is what a user does, and it is also what writes the config of record, so the switch survives the next resume.

## Preflight

```bash
cd <repo>                     # the SPLITBRIEF checkout
git status --short            # record existing changes; never stage, commit, stash, or reset them
npm run build                 # always; the global `splitbrief` on PATH is stale
node dist/cli.js doctor --json
```

`ready` or `ready-with-warnings` permits launch after inspecting each warning. A blocker requires remediation before launch.
Preserve existing user changes. If the CLI requires a clean tree, report that concrete blocker; never manufacture a clean tree.

Seats are declared in `.splitbrief/config.yaml` (gitignored), never with `--implementer <tool>` — that rebuilds the block from `{kind, tool}` and drops model and effort. Name the fallback seat as a commented line beside the live one so the switch target is chosen before it is needed.

```yaml
version: 3
planner:     { kind: cli, tool: <installed-tool>, model: <named-model> }
implementer: { kind: cli, tool: <installed-tool>, model: <named-model> }
validation:  { typecheck: true, lint: true, test: true }
workflow:    { approve: plan }
```

Preserve the user's seats. Confirm model names through the configured tools before launch; choose a fallback only within the user's authorization.
The task is a file attached with `@`, for example `.nuke/<date>-<topic>/tasks/<id>.md` or `.splitbrief/inbox/<date>-<slug>/tasks.md`.
If the task file's first line gives the exact launch command, use it without its seat flags; seats come from `.splitbrief/config.yaml`.

## Launch

Redirect stderr to a run-specific file so a crash survives alternate-screen restoration.
Create `SCR` with `mktemp -d` or the host's scratch directory. Record the terminal handle and scratch path.

Launch `node dist/cli.js start '<task>' @<task-file>`.
For an existing run, use `continue <run-id>` instead. Retain the process exit status and inspect stderr on unexpected exit.

When `command -v tmux` succeeds, always launch in a named tmux session:

```bash
SCR=$(mktemp -d)
T="splitbrief-$(date +%s)-$$"
export SB_REPO="$PWD" SB_STDERR="$SCR/splitbrief.stderr"
cat > "$SCR/launch.sh" <<'EOF'
#!/usr/bin/env bash
cd "$SB_REPO" || exit 1
node "$SB_REPO/dist/cli.js" "$@" 2>>"$SB_STDERR"
echo "SPLITBRIEF EXIT CODE: $?"
exec bash
EOF
chmod +x "$SCR/launch.sh"
tmux new-session -d -s "$T" -x 140 -y 45 -e "SB_REPO=$SB_REPO" -e "SB_STDERR=$SB_STDERR" "$SCR/launch.sh" start '<one sentence>' @.splitbrief/inbox/<run>/tasks.md
tmux set-option -t "$T" window-size manual
```

For `continue <run-id>`, run the whole block with two changes: set `T` to the session name recorded in that run's `babysit.md`, and pass `continue "$ID"` in place of `start …`.
When `babysit.md` records no session, keep the new name and record it.
If `tmux has-session -t "$T"` succeeds, wait until its pane prints `SPLITBRIEF EXIT CODE`, then replace the `new-session` and `set-option` lines with `tmux respawn-pane -k -t "$T" -e "SB_STDERR=$SB_STDERR" "$SCR/launch.sh" continue "$ID"`.
A read-only attach never resizes the window. `window-size manual` keeps the window at 140x45 when the owner attaches without `-r` to scroll, so the TUI the babysitter reads keeps its size.

Right after launch, give the owner this command once, with the session name expanded: `tmux attach -r -t "$T"`.
A babysitter subagent passes it to the orchestrator, which relays it to the owner.
Record the session name and the attach command in `<session-dir>/babysit.md` (`$SCR/defects.md` until the session directory exists).

Read-only attach cannot scroll, because the TUI draws on the alternate screen.
tmux copy mode shows only the current screen, for the same reason.
To scroll, the owner attaches without `-r` and uses the TUI's own keys (`shift+↑↓`, `pgup`/`pgdn`), only when the babysitter agrees; a writable client sends keys to the run.
Otherwise the owner reads `babysit.md`.

Without tmux, launch the same command in the host's persistent interactive terminal.

Never kill a terminal that holds another run. Leave other agents' terminals alone.

Read the new run ID from the CLI or `.splitbrief/active`, then verify it against this run's task and terminal.
Pin that ID for all later commands; do not follow a changing global active-run pointer.
Set `SESSION_DIR` to the absolute `.splitbrief/sessions/<run-id>` path and `WATCH_CURSOR` to `$SCR/watch-cursor.json`.
Store the defect record in `$SCR/defects.md` until the session directory exists, then keep it in `<session-dir>/babysit.md`.

## Watch loop

**Never end the supervising turn while a run is live.** Read the terminal, call the bundled watcher, and act on its result.
The watcher polls once per second and returns within 30 seconds by default. Never set a wait above 60 seconds.
It reads events incrementally with a persistent cursor, including events written between calls. It needs only Node.js built-ins.
It reports evidence; it does not send a stop signal or guarantee an engine-level barrier before the next brief.
On a suspected blocking tool defect, stop resumably before further diagnosis, approvals or retries. Edit no source while the run lives.
If supervision becomes unavailable, park the run before handing back. A turn ends only when:

1. a babysitter subagent ended the run on a blocking tool defect, quit the TUI, and handed the repair to the supervising session;
2. the run is parked on a concrete blocker, with the reason and next action recorded;
3. the run is complete and the final checks and defect record are reported.

The supervising session carries out the authorized repair and starts the new run without asking for permission again. An ended run alone is not task completion.

Once the session files exist, call:

```bash
node "$SKILL_DIR/scripts/watch-run.mjs" "$SESSION_DIR" "$WATCH_CURSOR" 30
```

Read its event and state summary, then inspect the terminal and stderr. A watcher failure is a supervision blocker: park, then supervise from a copy of the watcher outside the checkout, then resume. The watcher fix in the checkout waits until the run ends.
Never discard the cursor to suppress a finding. Record each event's disposition. Do not read the entire log into agent context.

Events worth acting on: `artifact_written`, `recovery_prompted{reason}`, `task_retry{attempt}`, `task_escalating`, `validate{status:"done",passed}`, `paused_external_changes`, `runner_call_stalled`, `workflow_complete{review}`.

A stalled-call event requires inspection of the terminal and the child's activity. Silence alone does not prove a tool defect.
Do not wait through repeated identical failures without classification. If the cause is uncertain, park and diagnose it.

**Live progress is in the run's isolation worktree**, `~/.local/state/splitbrief/trees/<repo-key>/<session>`, not the project checkout. Nothing lands in the project until a brief's changes are promoted after green validation, so `git status` in the project genuinely does not move between promotions.

## Answering prompts

Every row below is keyboard work in the pane — that is the point, not a convenience.

| Moment | What to do |
|---|---|
| Planner question | `↑↓` choose, `⏎` next, `tab` writes a free answer, last `⏎` sends |
| Plan card | read `plan.md` / `plan.json` in the session dir first; `y` approves the plan and also confirms every protected operation listed on the card (`Approving also confirms: …`), so check each listed write against the task before `y` |
| Inline external-edit prompt (`[c] continue`) | verify the changed files match authorized user edits, then send `c`; nobody edits the checkout for a fix while a run lives |
| Bordered recovery panel (each row shows its key) | send the action letter through the terminal; `⏎` takes the highlighted row, `tab` types a correction when the halt takes one. `r` is Try again; `w` opens the halted seat's picker |
| Protected-path write approval (manifest, lockfile, CI config, env or key file, `.git`, `.splitbrief`) | allow only when the task explicitly asks for that operation; otherwise deny — a denial is normal. A write prompt for an ordinary project file is a tool defect: stop resumably and classify it (Stop triggers) |
| Stop sheet | `esc` opens, `esc` again stops resumably, `ctrl+c` twice quits after the stop settles |

Send a letter and Enter as separate terminal actions. Inspect the result of the letter before sending Enter.

## Stop triggers — the rule that makes this dogfooding

Classify each failure before allowing further work:

- **Tool defect that blocks the run: END the run.** Includes crashes, lost artifacts, incorrect state, false security alarms, and broken recovery. Also includes a weak flow with no way forward: a dead end, or a wait with no feedback.
- **Cosmetic defect: record it in the debt list, and the run goes on.** Includes incorrect counters, labels, copy, and rendering. Also includes a weak flow the run can still get through: an unclear next action, a manual step that the tool can do, or different behavior for one action on neighboring surfaces. The debt list is a `Debt` section in `<session-dir>/babysit.md`, with terminal evidence per item.
- **Weak seat output (a bad split, a misread task): correct it in the composer.** No code changes.
- **Uncertain cause: stop resumably for diagnosis, with no code edits.** Do not spend retries to find out whether the tool itself is broken. Continue the run when the cause is not a blocking tool defect; end it when it is.
- **Expected warning or provider limit:** inspect it. Use normal recovery only when the tool detects and presents the condition correctly.

**Not a trigger**: a model mistake the tool handles correctly. The ladder retries it; the panel offers retry, skip or a seat switch. The run owns those, and the babysitter answers the panel as a user.

A blocking tool defect is fixed **in this session**, between runs. There is no LOG-only exception for known defects.

```
1. End the run through the TUI (esc, then End run; or /end). The run closes and keeps every file it wrote and its ledger.
2. Quit the TUI and confirm runner cleanup and process exit. If ending fails, record that defect and resolve cleanup first.
3. Record run ID, brief, attempt, event, expected/actual behavior, terminal evidence, and changed files.
4. Fix the cause in the main checkout. Delegate this step if agents are available.
5. Prove a logic fix with a failing-before/passing-after regression test, affected suites, and typecheck.
6. For a visual or flow defect, do the look-and-logic loop in CLAUDE.md on the screen and its neighbors. Stop at zero open items.
7. Run npm run release-check, then npm run build. The owner commits the fix.
8. Start a new run with start '<task>' @<task-file>. Reproduce the original interaction and verify the repair live.
9. Record the verification evidence. If the defect remains, end the new run too; do not advance or approve the next step.
```

Fix one diagnosed cause at a time. If verification exposes another blocking tool defect, end that run and resolve it before the next run.
Never continue an ended run after a tool fix. Do not change Git branches, create agent worktrees, stage, or commit during a run. Preserve all existing user changes.

**Tripwire false positives are tool defects that block the run on the first occurrence.** End the run, fix detection, and prove that genuine out-of-bounds writes still halt.
Do not disable the tripwire, add a permissive bypass, or retry unchanged detection.

Repeat until the plan's runs are done.

**Scope.** Fix defects exposed by the run or verification. A weak flow that the run shows is a defect, not a redesign. Do not search for unrelated cleanup or redesign opportunities.
Record unrelated ideas separately; they do not become requirements for this run.
If a repair needs an unauthorized product decision or unavailable credentials, keep the run parked, edit nothing, and report the exact blocker. Record the options in the defect record and ask the owner. Do not invent the decision.

A catalog or model claim is verified by set equality, never by a count — "exit 0 and a plausible count" hid a parser that collapsed 118 rows to 105. The four checks: the tool's own listing against production discovery (missing, extra, duplicates); every metadata field per row; the rows the live picker shows; the argv the child receives.

Record every trigger and its resolution in `<session-dir>/babysit.md`, with `file:line` evidence and commands actually run.

Per-brief validation runs only the colocated tests, so it cannot see a break outside the declared files. After any deletion of an exported name, grep `src/`, `testing/` **and** `scripts/` for consumers and run those suites yourself.

## Usage limits

A provider limit is the run's business, not a tool defect. **SPLITBRIEF itself must notice it**, halt with `runner-usage-limit` and offer the answers in the recovery panel. There is no automatic seat switch; the babysitter answers the panel.

- Use the declared, authorized fallback through the panel and picker. Use a named model, never `model: auto`.
- Without an available fallback, park the run and report the provider's reset time when known. Do not repeatedly retry a known limit.
- If the supervisor shares that provider, ensure the run is parked before supervision becomes unavailable.

If the halt or the offer does not come, that is a tool defect that blocks the run, not an operator chore. End the run, fix the whole detect → offer path (`HALT_SIGNATURES.usage` in `src/core/pipeline-spec/halts.ts`, the `switch-seat` offer in `src/engine/orchestrator/recovery/actions.ts`), start a new run, then **verify the switch still holds after a resume** of that run. Do not paper over it by hand-editing the config.

## Resume semantics

`continue` serves a run that stopped for a reason other than a blocking tool defect: a resumable stop for diagnosis, a quit, a host crash, a provider limit, or a parked recovery. No code changed and no rebuild happened while it was stopped. For such a run use `continue`, not `start`: a `start` opens a second run and loses the memoized artifacts and the compiled briefs. After a tool fix, the old run is ended and a new run starts.

| Stopped where | On continue |
|---|---|
| During a planner step | every step whose artifact is on disk is skipped; the cut step is re-issued whole |
| Parked mid-brief (`esc esc`, `ctrl+c`, `kill -INT`) | the brief continues at the same attempt, partial edits kept, worktree reused |
| Crashed mid-brief (no `interruptedStep`) | the brief restarts at attempt 0, declared files restored, worktree reseeded |
| On a recovery | nothing runs until `--action` or the panel answers it |

To carry such a run on, use `node dist/cli.js continue "$ID"`. Answer any remaining recovery through the panel.
Use `--action retry` only when CLI recovery is itself under test. Never skip a brief to pass a defect.

`switch-seat:<tool>:<model>` accepts any non-empty model string with no catalog check (`parseSeatSpecOption`, `src/cli/options.ts:66`), so a typo surfaces late as a `missing-model` halt.

A seat taken through the panel **is** the config of record: the picker saves through `transactConfigDocument`, so the switch survives the next continue with no YAML mirroring.

**New code needs a new run in a fresh process.** The at-rest `⏎` keeps the old build in memory.
After a source repair, confirm the ended run's process exited, build, then launch `start` in the retained terminal.
With tmux, respawn the pane in the same session, so the owner's attach command stays valid:

```bash
# pane: esc, End run, then ctrl+c ctrl+c; wait until it prints SPLITBRIEF EXIT CODE
npm run build
tmux respawn-pane -k -t "$T" -e "SB_STDERR=$SB_STDERR" "$SCR/launch.sh" start '<one sentence>' @<task-file>
```

Record the new run ID and each repair's files in `babysit.md`. Inspect any external-change or drift report against that record; never approve an unexplained change.

If the new run repeats the same failure, check the loaded build and reproduce the cause again. A retry is not evidence of a repair.

## Standing prohibitions

- Never `git add`, `git stage` or `git commit`. Every change stays unstaged for the owner.
- Never edit the checkout while a run lives, and never rebuild while a run lives. Never hand-edit `state.json` or `.splitbrief/config.yaml` mid-run — answer the surface that owns the change.
- Never `model: auto`. Name the model.
- Inspect external changes before answering `c`; the reason label alone is not approval.
- A deterministic failure caused by a tool prompt, adapter flag, gate, or default is a tool defect that blocks the run. End the run on detection, fix it, and start a new run.

## Sizing the task file

Keep each brief small enough for the selected implementer. A brief must leave typecheck, lint, and tests green on its own.
Name every caller affected by a deletion. Respect the configured tool's transport and context limits without substituting models or effort settings.

## Between runs

After a run's review, run the gates. `npm run release-check` must be green before the report.

```bash
npm run release-check
git diff --stat
```

Report the run ID, outcome, fixed defects, checks, live verification, and any blocker. Leave all changes unstaged for the owner.
