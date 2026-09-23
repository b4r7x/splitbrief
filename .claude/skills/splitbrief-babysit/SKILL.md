---
name: splitbrief-babysit
description: Supervised dogfooding run — one agent launches the built SPLITBRIEF CLI on this repo and babysits it in tmux while the session above it fixes the tool's own defects mid-run. Use when the user says "odpal splitbrief i pilnuj go", "run splitbrief and babysit it", "supervised run", "dogfood splitbrief on itself", or asks for any run where a stronger model orchestrates, a weaker one implements, and tool defects are fixed in the same session. Conventions entry point: splitbrief-dev. Engine procedure: docs/DOGFOODING.md.
---

# Babysit a SPLITBRIEF run

The built CLI runs on its own repository. Read `docs/DOGFOODING.md` for the engine semantics; this skill is the supervision protocol on top of it — who holds what context, and who fixes what.

## Roles and contexts

Context discipline is the point. A babysitter that also edits `src/` burns its watch context on diffs and loses the run; an orchestrator that reads `session.jsonl` dies on a 52 MB file.

| Role | Context | Does | Never |
|---|---|---|---|
| **Orchestrator** (this session) | near-empty, kept that way | spawns agents, reads their reports, tells the babysitter when to build and continue | reads `session.jsonl`; edits `src/`; drives tmux |
| **Babysitter** (one long-lived subagent) | the whole run | launches in tmux, watches, answers planner questions, gates, `[c] continue`, recovery panels; on a stop trigger stops **resumably**, quits the TUI and reports up with evidence | edits `src/`; ends the run on its own |
| **Fix agent** (fresh Opus) | the babysitter's report | diagnoses and fixes **directly in the main checkout**, no worktree; proves the fix: a test that fails before and passes after, a live repro when one is possible, the affected suites, `npm run typecheck` | touches the run |
| **Validation** (fresh, only when called for) | the fix agent's report and the diff | added only when a fix touches trust classification, config persistence, the run state machine or the event schema; checks the fix against real behaviour and every gate | reuses an earlier agent's context |

The babysitter is resumed by message with its context intact for as long as it answers. Messages reach a subagent only between its tool calls. An agent that does not answer, or whose context has grown large, is not sent the message again: the orchestrator spawns a fresh agent with a self-contained brief. A fix agent carries one to three items. Every subagent works in its own scratchpad subfolder: the root is shared, and one agent overwrote another's script on 2026-09-23.

## The babysitter drives the TUI as a real user would

This is the spine of the protocol. The babysitter navigates the running tool with the keyboard in the tmux pane — arrow keys, letter keys, `⏎`, `tab`, `esc` — for everything the tool asks: planner questions, approval gates, the `[c] continue` inline prompt, out-of-bounds write approvals, the recovery panel, the seat picker, the stop sheet. A supervised run exists to walk the exact path a human walks, so the defects a human would hit are the defects the run surfaces.

The CLI escape hatches are therefore **not** a shortcut to prefer. `continue --action retry|skip|switch-seat:<tool>[:<model>]|end-run`, a hand-edited `.splitbrief/config.yaml`, and any touching of `state.json` all bypass the surfaces under test; reaching for them in place of the UI hides exactly the defects the run exists to find. They are for one thing: resuming after the run was deliberately stopped for a fix.

Worked example — a usage limit opens a recovery panel with `switch-seat` recommended. The babysitter answers *that panel* and picks the fallback tool and model *in the seat picker it opens* (`pickSwappedSeat`, `src/features/workflow/recovery-driver.ts`). That is what a user does, and it is also what writes the config of record, so the switch survives the next resume.

## Preflight

```bash
cd <repo>                     # the SPLITBRIEF checkout
git status --short            # non-empty → stop, ask the owner to commit first
npm run build                 # always; the global `splitbrief` on PATH is stale
SB="node $PWD/dist/cli.js"
$SB doctor --json | jq '.report.status, [.report.checks[] | select(.severity=="error")]'
```

`ready` or `ready-with-warnings` is go. The two trust-boundary warnings (planner, implementer) and "context length is not configured" are normal.

Seats are declared in `.splitbrief/config.yaml` (gitignored), never with `--implementer <tool>` — that rebuilds the block from `{kind, tool}` and drops model and effort. Name the fallback seat as a commented line beside the live one so the switch target is chosen before it is needed.

```yaml
version: 3
planner:     { kind: cli, tool: claude-code, model: opus, effort: high }
implementer: { kind: cli, tool: antigravity, model: gemini-3.8-flash-high, effort: high }
# fallback:  { kind: cli, tool: claude-code, model: sonnet, effort: medium }
validation:  { typecheck: true, lint: true, test: true }
workflow:    { approve: all, max_retries: 3, mode: standard, task_review: none }
```

The task is a file under `.splitbrief/inbox/<date>-<slug>/tasks.md`, attached with `@`.

## Launch

tmux, so the pane is readable and typeable. stderr redirected to a file: the TUI runs on the alternate screen and a fatal error printed there vanishes when the screen restores.

```bash
SCR=<scratchpad>/babysitter          # the agent's own subfolder
T=sb2                                # one tmux session per run: a name `tmux ls` does not list
cat > "$SCR/launch.sh" <<EOF
#!/usr/bin/env bash
cd $PWD
node $PWD/dist/cli.js "\$@" 2>>"$SCR/splitbrief.stderr"
echo "SPLITBRIEF EXIT CODE: \$?"
sleep 100000
EOF
chmod +x "$SCR/launch.sh"
tmux new-session -d -s $T -x 140 -y 45 "$SCR/launch.sh start --mode standard '<one sentence>' @.splitbrief/inbox/<run>/tasks.md"
```

Never kill a tmux session that holds a parked run you still need; the snippet in `docs/DOGFOODING.md` kills `sb`, so do not copy it verbatim. Other agents' scratch TUIs run in their own sessions against scratch projects — leave them alone.

`.nuke/run-scripts/` holds `wait.sh`, `answer.sh`, `waitexit.sh`. Copy them into `$SCR`, replace the hard-coded `sb` with `$T` and the `cd` path with the checkout, and export `SB_SESSION=<run-id>`.

## Watch loop

**The babysitter never ends its turn while a run is live.** It sits in a foreground `wait.sh 240` loop and acts on what each call prints. Bound each wait at 240 s: a longer wait delays an orchestrator message by the whole wait. Never watch with a background command that re-invokes the babysitter later — the pane goes unwatched in between. A turn ends in three cases only, and every message the babysitter sends names its case:

1. it stopped the run on a stop trigger, quit the TUI, and waits for the word to build and continue;
2. the run reached its review and it waits for the owner's commit and the go;
3. the run is parked or complete.

For a look outside `wait.sh`:

```bash
ID=$(jq -r .sessionId .splitbrief/active); S=.splitbrief/sessions/$ID
jq -r '.phase, (.pendingRecovery.reason // "-"), ([.tasks[] | .id + ":" + .status] | join(" "))' $S/state.json
tail -n 0 -F $S/session.jsonl | jq --unbuffered -r '(.type // .kind) as $t | select($t | test("text_delta|planner_text|activity|tool_use|usage|heartbeat|cost_update") | not) | .ts + " " + $t + " " + ((.data // {}) | del(.diff, .excerpt, .text) | tostring)[0:240]'
tmux capture-pane -t $T -p | sed 's/[[:space:]]*$//' | grep -v '^$' | tail -16
ps -o rss=,etime= -p $(pgrep -P "$(tmux display -p -t $T '#{pane_pid}')" -f dist/cli.js)
```

`session.jsonl` reached 52 MB on one run. **Never read it whole; always filter.**

Events worth acting on: `artifact_written`, `recovery_prompted{reason}`, `task_retry{attempt}`, `task_escalating`, `validate{status:"done",passed}`, `paused_external_changes`, `runner_call_stalled`, `workflow_complete{review}`.

A silent child is usually working. `runner_call_stalled` at 5 min means no frames, not a dead tool; the watchdog kills at 30. Read the tool's own trail before judging — antigravity writes step records under `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/chunks/transcript_full/`, opencode logs to `~/.local/share/opencode/log/opencode.log`.

**Live progress is in the run's isolation worktree**, `~/.local/state/splitbrief/trees/<repo-key>/<session>`, not the project checkout. Nothing lands in the project until a brief's changes are promoted after green validation, so `git status` in the project genuinely does not move between promotions.

## Answering prompts

Every row below is keyboard work in the pane — that is the point, not a convenience.

| Moment | What to do |
|---|---|
| Planner question | `↑↓` choose, `⏎` next, `tab` writes a free answer, last `⏎` sends |
| Spec / plan / briefs gate | read the artifact in the session dir first, then `y` |
| Inline external-edit prompt (`[c] continue`) | `answer.sh c` |
| Bordered recovery panel ("letter key acts") | `tmux send-keys -t $T <letter>`; `⏎` takes the highlighted row. `r` is Try again; `w` opens the halted seat's own picker on the offered tool in one press |
| Out-of-bounds write approval | allow "this operation only" for a colocated test, a doc the brief names, or a sibling in the brief's module group; otherwise ask the owner |
| Stop sheet | `esc` opens, `esc` again stops resumably, `ctrl+c` twice quits after the stop settles |

**Never send a letter and Enter in one `send-keys` chunk.** The letter is swallowed and the highlighted row is taken instead. Send the letter, pause, then Enter.

## Stop triggers — the rule that makes this dogfooding

At every failure, ask *who* failed. The babysitter stops the run on two kinds of trigger:

- **A deterministic tool error**: a crash, an internal invariant, a limit that ended a healthy call, a gate that lied, a halt with no way through, a screen that contradicts `state.json`.
- **An AI output SPLITBRIEF does not handle**: the model returns something the tool mis-parses, silently accepts in a broken form, or crashes on — a verdict line the parser does not read, an artifact with the document glued behind narration, a brief the compiler accepts with a planned red gate, an implementer reply the tool misclassifies.

**Not a trigger**: a model mistake the tool handles correctly. The ladder retries it; the panel offers retry, skip or a seat switch. The run owns those, and the babysitter answers the panel as a user.

A trigger is fixed **now, in this session**, because the next brief hits the same code. Planning is no exception: a trigger during planning means stop, fix, resume, because the planning artifacts would carry it.

```
1. babysitter    stops resumably (esc esc), quits the TUI, reports with evidence — turn-end case 1
2. orchestrator  spawns a fresh Opus fix agent for that one defect
3. fix agent     diagnoses, fixes in the main checkout, proves the fix (Roles and contexts)
4. validation    only when the Roles table calls for one
5. babysitter    on the orchestrator's word: npm run build, then a fresh continue <run-id> (Resume semantics)
```

Repeat until the plan's runs are done.

**Scope.** Fix only what the run actually hits. No code review, no hunting for adjacent issues. Anything a fix agent reports as out of scope goes to the ledger at the bottom of the session handoff (`.nuke/<date>-session-handoff.md`), not into work.

A catalog or model claim is verified by set equality, never by a count — "exit 0 and a plausible count" hid a parser that collapsed 118 rows to 105. The four checks: the tool's own listing against production discovery (missing, extra, duplicates); every metadata field per row; the rows the live picker shows; the argv the child receives.

Record each trigger in the plan's "Live defects" with `file:line` evidence. That list is how the next context knows what is already known.

Per-brief validation runs only the colocated tests, so it cannot see a break outside the declared files. After any deletion of an exported name, grep `src/`, `testing/` **and** `scripts/` for consumers and run those suites yourself.

## Usage limits

A provider limit is the run's business, not a tool defect. **SPLITBRIEF itself must notice it**, halt with `runner-usage-limit` and offer the answers in the recovery panel. There is no automatic seat switch; the babysitter answers the panel.

- **Implementer limit.** Take `switch-seat` as in the worked example above, onto the declared fallback — a *named* model, never `model: auto`. On 2026-09-21 `auto` ran Grok 4.7 at $3.03 instead of the intended model.
- **Claude limit.** The planner and reviewer seats and the orchestrator's own agents draw on one Claude account, so the limit stops both sides. Answer **Try again** once; if it fails on the same limit, leave the panel open and report the reset time. Once the limit clears, a subagent the limit stopped is an agent that does not answer (Roles and contexts).

If the halt or the offer does not come, that is a tool defect, not an operator chore. Fix the whole detect → offer path (`HALT_SIGNATURES.usage` in `src/core/pipeline-spec/halts.ts`, the `switch-seat` offer in `src/engine/orchestrator/recovery/actions.ts`), resume, then **verify the switch still holds after the resume**. Do not paper over it by hand-editing the config.

## Resume semantics

`continue`, never `start`. A `start` opens a second run and loses the memoized artifacts and the compiled briefs.

| Stopped where | On continue |
|---|---|
| During a planner step | every step whose artifact is on disk is skipped; the cut step is re-issued whole |
| Parked mid-brief (`esc esc`, `ctrl+c`, `kill -INT`) | the brief continues at the same attempt, partial edits kept, worktree reused |
| Crashed mid-brief (no `interruptedStep`) | the brief restarts at attempt 0, declared files restored, worktree reseeded |
| On a recovery | nothing runs until `--action` or the panel answers it |

`$SB continue $ID --action retry | skip | switch-seat:<tool>[:<model>] | end-run` — the stopped-for-a-fix path only; a live halt is answered in the panel.

`switch-seat:<tool>:<model>` accepts any non-empty model string with no catalog check (`parseSeatSpecOption`, `src/cli/options.ts:66`), so a typo surfaces late as a `missing-model` halt.

A seat taken through the panel **is** the config of record: the picker saves through `transactConfigDocument`, so the switch survives the next continue with no YAML mirroring.

**New code needs a fresh process.** The at-rest `⏎` keeps the old build in memory. After any `src/` change — a fix, a commit, code the run promoted for its own benefit — resume like this:

```bash
# pane: esc esc (stop resumably), then ctrl+c ctrl+c; wait until it prints SPLITBRIEF EXIT CODE
npm run build
tmux respawn-pane -k -t $T "$SCR/launch.sh continue $ID"
```

**A fix after the task loop starts reads as drift.** The drift baseline is captured when the task loop first starts, not at run start (`captureChangedFilesBaseline` while `state.changedFilesBaseline` is unset, `src/engine/orchestrator/task/loop.ts:110-113`). A fix landed in `src/` after that point appears as drift in later briefs: known defect 33, which Plan B run 2 fixes. So the orchestrator records each fix's file list in the run log, and at the final review the babysitter names those files so the reviewer does not read them as scope drift.

In-TUI recovery answers on a `start`-launched run (retry, skip, switch seat, rewind) threw `Internal invariant: … a new-workflow run requires a freshly allocated session` until the 2026-09-23 fix. Seeing it again is a regression: stop and report. The at-rest `⏎` and CLI `continue` always build a fresh `resume` and are the safe way on.

## Standing prohibitions

- Never `git add`, `git stage` or `git commit`. Every change stays unstaged for the owner.
- Never hand-edit a file a `done` brief owns to patch its result. A fix for a tool defect may change such a file when the defect lives there; the run then reports an external change, answered as the prompts table says, and the fix goes in the run log. Never hand-edit `state.json` or `.splitbrief/config.yaml` mid-run — answer the surface that owns the change.
- Never `model: auto`. Name the model.
- A `paused_external_changes` of kind `unrelated` or `future-task-stale-input` is answered `c`.
- If a brief fails the same way twice because of a *fixed setting* of the tool — a prompt line, an adapter flag, a gate rule, a default — stop retrying. Let the run finish or end it, then plan the setting change as its own work.

## Sizing the task file

One module group per brief (a source file plus its colocated test), never two large modules. A brief must leave typecheck, lint and tests green on its own, so name every call site a deletion touches. An argv-transport implementer (antigravity) refuses prompts over 120 KB. Planner effort `high` minimum — on `low` it once compiled a brief that planned a red typecheck.

## Between runs

After a run's review, run the gates. `npm run release-check` must be green before the report.

```bash
npm run release-check
node scripts/dangling-imports.mjs
find src -name index.ts          # must be empty
git diff --stat
```

Then report to the owner with the new "Live defects" entries. The owner commits, and the next run starts on a clean tree (Preflight).
