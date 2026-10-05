# SPLITBRIEF Cookbook — Usage Examples

A task-oriented reference for "how do I do X?". Every recipe is copy-paste ready against the current CLI surface and slash-command catalog. Where a recipe references a config field, the field name matches the zod schema in `src/core/schemas/config.ts`.

If you're new to SPLITBRIEF, read this in order: recipes 1–5 cover the basic workflow, 6–9 cover cost, 10–11 cover safety, then jump to whatever you need.

> **Conventions.** Commands assume you're in the project root. Long YAML examples elide unrelated config; the loader fills in defaults. The TUI snippets below ("You'll see") use the same line shapes the workflow renders today; exact spacing and color may vary by terminal.

These examples do not configure automatic staging, commits, or index checkpoints.

---

## Basic flows

### 1. First time setup

**When:** the project doesn't have a `.splitbrief/` directory yet.

**Run:**

```bash
npm install -g splitbrief

cd your-project
splitbrief init                        # interactive wizard
splitbrief doctor                      # verify config, CLI auth, and validation readiness
splitbrief start "add a hello-world endpoint"
```

**You'll see:**

```
splitbrief init
  Detected: claude-code, codex, ollama
  Planner [claude-code] >  ↵
  Implementer [ollama qwen3-coder:30b] >  ↵
  Wrote .splitbrief/config.yaml
```

`init` writes `.splitbrief/config.yaml` (`version: 3`) and creates `.splitbrief/`. The default planner is the admitted `claude-code` CLI (subscription-included billing; see the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix)). The first `splitbrief start` then creates `.splitbrief/sessions/<session-id>/` and writes `.splitbrief/active`. Run `splitbrief doctor` after setup or runner changes — it is read-only and surfaces remediation copy for non-ready CLI/API states without starting a workflow.

**Variations:** `splitbrief init --reconfigure` overwrites an existing config. To initialize another project, run `splitbrief init` from that project directory.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [docs/BOOTSTRAP.md](./BOOTSTRAP.md), [docs/API-KEYS.md](./API-KEYS.md).

---

### 2. Fix a typo

**When:** the change is a one-line edit in one file, and you do not want to stop at the plan card.

**Config:**

```yaml
workflow:
  approve: none
```

**Run:**

```bash
splitbrief start "rename function calcualteTax to calculateTax in src/billing/tax.ts"
```

**You'll see:**

```
phase: planning        → plan.json, plan.md, tasks.md
phase: implementing
  T001 ✓  src/billing/tax.ts
phase: final-review    → review.md
workflow_complete
```

Every run plans in one session; a small change simply gets a small plan. With `approve: none` the checked plan goes straight to the build.

**Variations:** Leave `approve` unset (it defaults to `plan`) to see the plan card first. `--mode` and `--approve` were removed: they fail the command with a one-line pointer (`--approve was removed: set workflow.approve (plan or none) in the config`).

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md#3-the-planning-session), recipe 3.

---

### 3. Add a small feature

**When:** you want the plan and its Task Briefs written to disk for review before anything is implemented.

**Run:**

```bash
splitbrief spec "add an isAdult helper that returns true when age >= 18"
```

**You'll see:**

```
Planning feature: add an isAdult helper that returns true when age >= 18 (planner: claude-code)


Planning complete.
  Session: 2026-10-02-add-an-isadult-helper
  /home/me/app/.splitbrief/sessions/2026-10-02-add-an-isadult-helper/plan.json
  /home/me/app/.splitbrief/sessions/2026-10-02-add-an-isadult-helper/plan.md
  /home/me/app/.splitbrief/sessions/2026-10-02-add-an-isadult-helper/tasks.md (1 tasks)
```

The paths are absolute: `spec` prints the project directory it resolved.

`spec` runs the same planning session as `start` and stops after the plan passed its checks. If the planner asks a question, `spec` prints it under `The planner asks:` and reads one line; `⏎` takes the defaults.

**Variations:** Pair `start` with `--implementer ollama` to keep the implementer local. Without a terminal, `spec` takes every question's default.

**See also:** [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-spec).

---

### 4. Refactor across files

**When:** the change touches several files and you want to approve the plan before the build.

**Run:**

```bash
splitbrief start "extract the duplicated date-formatting logic into a shared util"
```

**You'll see:**

```
phase: planning        → plan.json, plan.md, tasks.md
phase: reviewing-plan  ← the plan card
  y approve · c comment · q end run · e edit
> y
phase: implementing
  T001 ✓  T002 ✓  T003 ✓
phase: final-review    → review.md
workflow_complete
```

The plan card is on by default (`approve: plan`). While the composer is empty, one key settles it: `y` approves the plan and starts the build, `c` starts a correction, `e` opens `plan.json` in the in-app editor, and `q` ends the run. The typed commands still work — `approve`, `comment <text>`, `end-run`, `edit`. Typing anything turns the letters back into text, so a draft is never eaten by a shortcut.

**Variations:** `workflow.approve: none` skips the card. A correction (`comment split T002 in two`) goes back to the planning session, which answers with a new plan; the card shows again.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#the-plan-card), recipe 5.

---

### 5. Add auth, migration, or security work

**When:** the change is large, risky, or touches a protected path such as `package.json`.

**Run:**

```bash
splitbrief start "add JWT bearer auth to the public REST API"
```

**You'll see:**

```
phase: planning
  Questions before the plan · round 1 of 2
  Which JWT library? jose (default) · express-jwt
> ⏎
phase: reviewing-plan  ← the plan card
  Protected operations
  - T002: write package.json
> y
phase: implementing
  T001 ✓ T002 ✓ T003 ✓ T004 ✓
phase: final-review
```

The planner may ask up to three questions per round, for at most two rounds; every question has a default, and `⏎` through the panel takes them. The plan lists the protected writes it needs; approving the card confirms them, so `write package.json` does not ask again during the build. A protected write the plan did not list still asks.

**Variations:** Give the planner more context with `@file` arguments, or attach project skills with `/skills` (recipe 21).

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md#the-plan-contract), recipe 9.

---

## Spend

### 6. Use a smaller implementer

**When:** you want a strong planner (Claude Code subscription) to compile briefs but a small local model to execute them.

**Setup (`.splitbrief/config.yaml`):**

<!-- config-example: local-implementer-profiles -->
```yaml
version: 3
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: lm-studio
  service: lm-studio
  offering: local
  apiBase: http://localhost:1234/v1
  model: qwen2.5-coder-7b
implementerProfiles:
  default: local-lmstudio
  profiles:
    local-lmstudio:
      kind: api
      provider: lm-studio
      service: lm-studio
      offering: local
      apiBase: http://localhost:1234/v1
      model: qwen2.5-coder-7b
      label: LM Studio Qwen2.5 Coder
validation:
  typecheck: true
  lint: true
  test: true
```

Load the model in LM Studio and start its server before the run; the model ID must match what `/v1/models` reports. Like every bundled row, a local default is **`compatible-only`**, so it carries no SPLITBRIEF quality claim (see the [bundled model catalog](./CONFIGURATION.md#bundled-model-catalog-t-081-runtime-state)). Named `implementerProfiles` persist in config; recovery can route a stuck task to another profile via `route-bigger-worker`. LM Studio is local: no key, no metered spend, and prompts never leave your machine.

**Run:**

```bash
splitbrief doctor              # verify claude-code auth and LM Studio reachability
splitbrief start "add a CSV exporter"
```

**You'll see:**

```
planner: claude-code (cli)  · subscription, no API spend tracked
implementer: lm-studio · qwen2.5-coder-7b
cost_update: planner unpriced · implementer local
validate · tsc ✓ lint ✓ test ✓
```

The planner bills through your Claude Code subscription, so its usage reads `unpriced` — never zero cost and never `local`, which is reserved for local backends. The local implementer reads `local`, and the session total reads `unpriced + local`.

**Variations:** `provider: ollama` with `apiBase: http://localhost:11434/v1` is the other local backend; a remote OpenAI-compatible endpoint works as a custom provider with an inline `apiKey` (see [docs/API-KEYS.md](./API-KEYS.md)), and metered spend then shows in `cost_update`. Swap the planner `tool` using the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix).

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §implementer / §implementerProfiles, [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [docs/API-KEYS.md](./API-KEYS.md).

---

### 7. Review what a run spent

**When:** the run is over (or paused) and you want to see where the spend went.

**Run:**

Open `/usage` from the workflow, including a saved run. The details show reported usage, missing or partial coverage, and available monetary estimates. The sidebar and closed-run ledger do not display spend; there is no Show spend control.

For a recorded event-level export:

```bash
jq 'select(.type == "cost_update")' .splitbrief/sessions/<id>/session.jsonl | tail -20
```

Unknown or unpriced usage is not zero cost. Estimates in the explicit details view do not prove the vendor’s invoice or the CLI’s authentication method.

---

### 8. Use Claude Code subscription as planner

**When:** you have a Claude Pro / Max subscription and don't want to pay per-token through the API.

**Setup (`.splitbrief/config.yaml`):**

```yaml
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b
validation:
  typecheck: true
  lint: true
  test: true
```

`claude-code` is an admitted PASS CLI runner with subscription-included billing (see the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix)). The bundled Ollama default is **`compatible-only`** — selectable, but not a runtime recommendation (see the [bundled model catalog](./CONFIGURATION.md#bundled-model-catalog-t-081-runtime-state)). Local implementers keep code on your machine; no API credential is required for default loopback Ollama.

**Run:**

```bash
splitbrief doctor              # verify claude-code session auth and ollama reachability
splitbrief start "add input validation to the signup form"
```

**You'll see:**

```
planner: claude-code (cli)  · subscription, no API spend tracked
implementer: ollama · qwen3-coder:30b (local)
validate · tsc ✓ lint ✓ test ✓
```

`kind: cli` spawns `claude` as a subprocess with the brief on stdin. Spend goes through your subscription, so SPLITBRIEF shows the planner as `unpriced`; only the Ollama implementer reads `local`, and the session total reads `unpriced`.

**Variations:** Swap `tool` for any admitted CLI in the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix); `splitbrief init` auto-detects installed tools. For a hosted cloud implementer instead of local Ollama, use recipe 6.

**See also:** [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md) §planner / §implementer, [docs/API-KEYS.md](./API-KEYS.md).

---

## Safety

### 9. Confirm a protected file write

**When:** the implementer writes a control-plane path, a package manifest or lockfile, CI configuration, or an env or key file. Those writes always ask; no other write does.

**Setup:** nothing to configure. `approval.enabled`, `--yolo` and the retired `approval.tiers` do not change the rule.

**Run:**

```bash
splitbrief start "add a lint script to package.json"
```

**You'll see (when the plan did not list the write):**

```
Change a package manifest:
  package.json
  y Confirm · r reason · esc deny
> y
approval_granted
```

A confirmation holds for that path for the rest of the run. A plan that lists the write under its protected operations is confirmed when you approve the plan card, so the build does not ask again. There are no sticky grants and no `splitbrief approval` command.

**Variations:** A `--json` or `--plain` run has no reply channel, so a protected write fails closed there with `APPROVAL_REQUIRED`, even when the plan lists it: an unattended approval confirms nothing. Run that change interactively.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#protected-path-confirmation), recipe 25.

---

### 10. Catch agent drift early

**When:** you suspect the implementer is editing files outside the brief's scope across multiple tasks.

**Setup (`.splitbrief/config.yaml`):**

```yaml
workflow:
  driftChainThreshold: 0.6    # 0.0–1.0; emit drift_chain_detected at/above
```

**Run:**

```bash
splitbrief start "tidy up the UI"
splitbrief status     # after a few tasks
```

**You'll see:**

```
drift_report passed=true errors=0 warnings=2
drift_chain_detected
  score: 0.71
  representativePath: src/utils/format.ts
  tasks: T001, T002, T003 all touched src/utils/format.ts (out of scope)
```

The drift chain detector tracks out-of-bounds files across tasks. A high score indicates the implementer is repeatedly straying into the same off-scope area — usually a sign the brief was wrong about scope.

**Variations:** Inspect the final deterministic report directly: `cat .splitbrief/sessions/<id>/drift-report.json | jq`. Inspect `drift-chains.json` for cross-task chain state. A closed run shows a `Scope` row with the latest score.

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md) §Drift detection rules.

---

## Mid-workflow control

### 11. Edit the plan before the build

**When:** the plan is mostly right but needs a tweak before implementation starts.

**Run:**

At the plan card:

```
phase: reviewing-plan
  T001 add validator     src/auth/validate.ts
  T002 wire validator    src/auth/middleware.ts
  T003 add tests         src/auth/validate.test.ts
  y approve · c comment · q end run · e edit
> e
```

`e` on an empty composer, `Ctrl+E` and `edit` all open the run's `plan.json` in the in-app editor. `Ctrl+S` checks the text first — the JSON, the plan schema and the plan checks. A text that fails stays open with `Not saved: <first message> (+N more)`. A valid save closes the editor; SPLITBRIEF compiles the edited plan, rewrites `plan.md` and `tasks.md`, and shows the card again until you approve.

**You'll see:**

```
plan_regenerated (edited plan.json)
phase: reviewing-plan
> y
phase: implementing
```

**Variations:** `Ctrl+O` inside the editor opens `plan.json` in the external editor (`VISUAL`, then non-terminal `EDITOR`, then detected GUI editors, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`); saving there settles the card the same way. There is no per-brief field editor.

**See also:** [docs/FEATURES.md](./FEATURES.md#editing-planjson), recipe 12.

---

### 12. Request changes to the plan

**When:** the plan got the architecture wrong and you want a new one.

**Run:**

At the plan card:

```
phase: reviewing-plan
> comment the validator should be a plain function, not a class. Reuse the existing isEmail helper.
```

**You'll see:**

```
phase: planning          ← the planning session answers the correction
phase: reviewing-plan    ← the new plan
> approve
phase: implementing
```

A non-empty `comment <text>` (or `c`, then the text) sends the correction and the plan you reviewed to the planning session, which answers with a new plan. `q` or `end-run` ends the run.

**Variations:** `/revise-spec` and `/revise-plan` were removed; typing either prints `request changes on the plan`. A correction typed at an open run at rest steers the step it continues.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md#3-the-planning-session), [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md#the-plan-card).

---

### 13. Update a config from before the planning session

**When:** an older `.splitbrief/config.yaml` still carries `workflow.mode`, `workflow.approve: all|spec|default`, `workflow.task_review`, `workflow.brief_review`, `workflow.speckit` or `approval.tiers`.

**Run:**

```bash
splitbrief doctor
```

**You'll see** one notice per retired key, for example:

```
workflow.mode was retired and is ignored: every run plans in one session. Delete workflow.mode.
workflow.approve "all" was retired; using "plan": the plan waits for your approval before the build. Set approve to plan or none.
workflow.task_review was retired and is ignored: the build no longer stops for your review after each brief. Delete workflow.task_review.
```

The config still loads: each retired key is ignored, and a retired `approve` value loads as `plan`. Delete the keys (or set `approve: plan`, the default) and the notices stop.

**Variations:** The full list of retired keys and their notices is in [docs/CONFIGURATION.md](./CONFIGURATION.md#retired-keys-that-still-load).

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md#5-workflow).

---

### 14. Skip a task

**When:** one task in the brief is wrong and you want to move on without running it.

**Run:**

The cleanest way is a `pre_task` hook that exits non-zero for that task id. Add to `.splitbrief/config.yaml`:

```yaml
hooks:
  pre_task:
    - command: ".splitbrief/hooks/skip-by-id.sh"
      args: ["${event.taskId}"]
      on_failure: block
```

`./.splitbrief/hooks/skip-by-id.sh`:

```bash
#!/usr/bin/env bash
case "$1" in
  T002) echo "skipped per local override" >&2; exit 1 ;;
  *) exit 0 ;;
esac
```

**You'll see:**

```
T001 ✓
T002 skipped: skipped per local override
T003 ✓
```

Denied tasks land in the evidence ledger as `skipped: <reason>`. There is no `/skip-task` slash command today — denying via hook is the supported path.

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md), recipe 23.

---

### 15. Skip the plan card

**When:** you trust the plan checks and want the build to start as soon as the plan passes them.

**Config:**

```yaml
workflow:
  approve: none
```

**Run:**

```bash
splitbrief start "add a health endpoint"
```

**You'll see:**

```
phase: planning
phase: implementing
```

With `approve: none` the card never opens. A plan that fails its checks still goes back to the planner and never reaches the build, and a write to a protected path still asks during the build. The Settings overlay (`Ctrl+,`) carries the same choice as its **Plan approval** row (`plan · none`).

**Variations:** There are no workflow modes: `/mode` prints `/mode was removed: every run plans in one session`, and `--mode` fails the command.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md#5-workflow).

---

### 16. Stop a run cleanly

**When:** something is wrong and you want to stop without losing the partial transcript or the changes already written.

**Run:** press `esc` and pick a row; or press `esc esc` to stop immediately.

```text
Stop options · Changes and draft stay.
▌ Stop now · stop execution; keep partial changes
  Pause after this brief
  End run
↑↓ select · ⏎ confirm · esc stop · tab close
```

**You'll see** the byline report the stop while it happens, then the park:

```
⠙ Stopping T002 · Waiting for processes to exit · 0:02
  esc back after stop · ctrl+c quit after stop
◌ Paused at T002 · Partial changes kept
  /resume · /stop options · esc back to sessions · ctrl+c quit
```

- **`Stop now`** (also `ctrl+c`, one press — that press also arms the two-second quit confirmation) aborts the in-flight call and any retry, escalation or per-task review call, schedules nothing new, and parks with the partial changes kept.
- **`Pause after this brief`** lets `T002` finish its checks and per-task review, then parks before `T003`: `Paused after T002 · 2 of 7 briefs complete`. While the pause is pending, the sheet's second row reads `Keep running` — that is how you take it back.
- **`End run`** stops the same way as Stop now and persists the session with status `ended`: `Cancelled by you at T002 · Changes kept`.
- **`ctrl+q` / `/quit`** stops safely, saves the session, and then exits.

No option writes the run's changes into your checkout or reverts it: the briefs build in the run workspace, and only Apply writes the reviewed result into the checkout. End run on a worktree or staged-copy run keeps the changes in `.splitbrief/sessions/<id>/run.patch`. Opening the menu preserves the draft; `Tab` dismisses it and returns to writing.

**Variations:** `/resume` continues an open run — typed instructions steer it, a blank Enter resumes a continuable run at rest but not a run parked in this process; `/end` closes a parked one. From the shell, `splitbrief resume` re-enters the active saved run and `splitbrief continue <session-id>` works when the active pointer is gone. Every open run is continuable, one stopped in its planning session included; a run killed during validation or escalation re-enters at the start of the brief it was on. Only a closed run is refused, and a saved state that is not the current version must be migrated before it will resume.

**See also:** [docs/FEATURES.md](./FEATURES.md#stopping-a-run), [docs/WORKFLOW.md](./WORKFLOW.md) §1.5, §1.6.

---

## Headless / CI

### 17. Run in CI without TUI

**When:** you want SPLITBRIEF to run unattended in GitHub Actions or another CI runner.

**Run:**

```bash
splitbrief start --json --allow-hooks "regenerate API client from openapi.yaml" \
  | tee events.ndjson
```

**You'll see (NDJSON, one event per line):**

```
{"type":"workflow_started","ts":1745692800000,"phase":"planning","feature":"regenerate API client from openapi.yaml"}
{"type":"plan_approved","ts":1745692840100,"phase":"reviewing-plan"}
{"type":"task_completed","ts":1745692902300,"phase":"implementing","taskId":"T001"}
…
{"type":"workflow_complete","ts":1745692980000,"phase":"complete"}
```

`--json` requires a feature argument and replaces the TUI sink with NDJSON-on-stdout. The on-disk JSONL log is still written. `--allow-hooks` skips the interactive trust prompt. The plan card is approved unattended; set `workflow.approve: none` in the CI config to skip it. A planner question stops the run with an `input_required` record and exit code 1.

**Variations:** `CI=1` env var auto-disables fullscreen mode even without `--json`.

**See also:** recipes 18–20.

---

### 18. Parse cost in CI

**When:** you want to extract the final cost from a CI run and post it as a build comment.

**Run:**

```bash
splitbrief start --json "..." 2>/dev/null > events.ndjson

# Total spend at end of run
jq -s 'map(select(.type == "cost_update")) | last | {planner: .plannerCost, implementer: .implementerCost, total: .totalCost}' \
  events.ndjson

# Per-task cost
jq 'select(.type == "task_tokens") | {task: .taskId, method: .method, cost: .cost}' events.ndjson
```

**You'll see:**

```json
{"planner":0.41,"implementer":0,"total":0.41}
{"task":"T001","method":"local","cost":0}
{"task":"T002","method":"escalation","cost":0.04}
```

The same data lives in `.splitbrief/sessions/<id>/summary.json` once the run finishes. `method: local` on implementer rows means subscription-included or loopback backends with no metered API line item; see billing posture in [CONFIGURATION.md](./CONFIGURATION.md) and the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix).

**Variations:** Filter for failures: `jq 'select(.type == "task_full_fail" or .type == "error")' events.ndjson`.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md) §Event log, [docs/CONFIGURATION.md](./CONFIGURATION.md), recipe 7.

---

### 19. Read a headless run without a JSON parser

**When:** CI or a shell script needs the shape of a run — which phase, which task, what the review said — and piping NDJSON through `jq` is more machinery than the job deserves.

**Run:**

```bash
splitbrief start --plain --allow-hooks "regenerate API client from openapi.yaml"
```

**You'll see:**

```
phase: planning
phase: reviewing-plan
phase: implementing
task T001: done (typecheck lint test)
task T002: done (typecheck lint test)
task T003: done (typecheck lint test)
phase: final-review
phase: complete
review: passed
done: 3 tasks
```

The count in the closing line is the number of tasks the run has completed, read from its state, so a resumed or continued run also counts the tasks an earlier process completed.

A task that exhausts its retries stops the run: headless has nobody to answer the recovery, so the stream ends on the `failed` line and the command exits `1` with no `review:` or `done:` line.

```
phase: implementing
task T001: done (typecheck lint test)
task T002: failed (no gates)
```

Four line shapes and nothing else, so `grep` is enough:

```bash
splitbrief start --plain "..." | grep -c '^task .*: failed' # tasks that did not pass their gates
splitbrief start --plain "..." | tail -1                    # the closing line
```

Cost is reported in tokens, not dollars: the event stream carries token counts, and the price catalog lives outside the run. For dollars, use `--json` (recipe 18) or read `summary.json` after the run.

`--plain` and `--json` are two renderings of one stream and cannot share stdout — passing both exits `2` with `--plain and --json cannot be combined; choose one output mode.`

**Variations:** `splitbrief resume --plain` and `splitbrief continue --plain` render a resumed run the same way. A resume that lands on a different crew than the one that started the run prints `PLAN seat changed <old> → <new>; context will be rebuilt` to stderr first, so redirect stderr if you want stdout alone.

**See also:** [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md) §Plain output stream, recipe 18.

---

### 20. Answer a halted run without a TUI

**When:** a `--json` or `--plain` run stopped on a recovery issue in CI, and you want to resolve it from the shell instead of opening the recovery panel.

**Run:** the halt tells you the command. Every headless run that stops on a recovery writes three lines to stderr and exits `1`:

```
Recovery required (retry-exhausted): T002 failed after 3 attempts
Recommended: skip-current-task
Continue with: splitbrief continue 2026-09-13-rate-limiter --action skip [--plain|--json]
```

Paste the last line, choosing the rendering you want:

```bash
splitbrief continue 2026-09-13-rate-limiter --action skip --plain
```

**You'll see:** the action is applied to the pending recovery — the same transition the panel would make — and the run continues from the state it produced:

```
phase: implementing
task T003: done (typecheck lint test)
phase: final-review
review: passed
done: 2 tasks
```

**The four actions `continue` can take:**

| `--action` | What it does |
|---|---|
| `skip` | `skip-current-task` — marks the blocked brief skipped, records evidence, and moves on |
| `retry` | `retry-same-worker` — resets the brief and reruns it in a fresh worker context |
| `switch-seat:<tool>[:<model>]` | Moves the blocked seat to another detected tool, then reruns the brief there — the answer to a quota halt |
| `end-run` | Closes the run and starts nothing; the files it wrote stay on disk |

**Variations:** `--action` is a `continue` flag; `resume` has no equivalent, and a bare `splitbrief resume --plain` on a session with a pending recovery prints the same three lines and exits `1`. An action the issue does not allow exits `1` and names the actions it does allow; a value that is not a recovery action exits `2` with `'<value>' is not a recovery action. Use skip, retry, switch-seat:<tool>[:<model>], or end-run.` A recovery whose recommended action is a row of the recovery panel prints `Continue with: splitbrief continue <session>, then choose <row> in the recovery panel` instead — `Pause run`, for example — with no `[--plain|--json]`, because the panel needs the TUI.

**See also:** [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-continue), [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

---

### 21. Prime every seat with project skills

**When:** the repo carries skills — house conventions, a testing standard, a security checklist — and you want a scripted run to use them without opening the picker.

**Run:**

```bash
# what is discoverable in this repo
ls .claude/skills .splitbrief/skills 2>/dev/null

splitbrief start --plain \
  --skills testing-standards,api-conventions \
  "add a POST /invoices endpoint"
```

**You'll see:** the ids are resolved against the same scan roots the `/skills` picker uses — project `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `./.github/skills/`, `./.commandcode/skills/`, `./.kilo/skills/`, `./.kilocode/skills/`, `./.cursor/skills/`, then the global forms of the same — and their text reaches every seat — each planning step, each implementer brief and its retries, the consult and the final review — under one `## Active Project Skills` section. Nothing prints for a successful attach; the run simply works with them.

An id no root carries fails before planning, so a typo costs no tokens:

```
Error: Unknown skill: testing-standard (scanned: ./.splitbrief/skills, ./.claude/skills, …)
```

with exit `2`.

**Variations:** `--skills` also applies to `splitbrief resume` and `splitbrief continue`, in headless and interactive mode alike. There it applies to that continue only: it is not saved, so a later continue without it uses the selection the run saved when it started. Interactively, `/skills` opens the picker, `/skills <id> <id>` toggles by id (fuzzy, several at a time), and the command palette carries one `Skill · <name>` row per discovered skill. The section is budgeted at 16 000 characters; a skill body that does not fit is named by path, never cut, and a `skills_truncated` warning names its skill.

**See also:** [docs/FEATURES.md](./FEATURES.md#skills), [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md#skills).

---

## Power user

### 22. Define project-level coding rules

**When:** you want every seat — planner, implementer and reviewer — to follow project conventions (no React Context, ESM `.js` suffix, etc.).

**Setup:** write the rules as a project skill, `.splitbrief/skills/house-rules/SKILL.md`:

```markdown
---
name: house-rules
description: Project coding conventions every brief must follow
---
- Production TypeScript uses pure functions and module-scoped state; no runtime classes.
- Every internal import uses the `.js` suffix: `'./foo.js'` not `'./foo'`.
- Re-export-only `index.ts` files are forbidden under `src/`.
```

**Run:**

```bash
splitbrief start --plain --skills house-rules "add a new HTTP client"
```

Interactively, select the skill with `/skills house-rules` before you start.

**You'll see:** nothing extra. The rules reach every turn of the planning session, each implementer brief and the final review under one `## Active Project Skills` section, and the reviewer judges the result against them.

**Variations:** There is no constitution check: the speckit mode that ran it was removed. A rule that must hold mechanically belongs in a lint rule or a `post_task` hook (recipe 23).

**See also:** recipe 21, [docs/FEATURES.md](./FEATURES.md#skills).

---

### 23. Run pre/post task shell hooks

**When:** you want to format with Prettier and run Biome after every task without modifying the validation pipeline.

**Setup (`.splitbrief/config.yaml`):**

```yaml
hooks:
  post_task:
    - command: "npx"
      args: ["biome", "check", "--write", "${event.file}"]
      timeout_ms: 10000
      on_failure: warn
  pre_task:
    - command: ".splitbrief/hooks/scan.sh"
      args: ["${event.file}"]
      on_failure: block
```

**Run:**

```bash
splitbrief start --allow-hooks "add the User model"
```

**You'll see (first run only):**

```
SPLITBRIEF config declares hooks this machine has not trusted:

  pre_task:
    Executable: "prettier"
    Resolved: "/usr/local/bin/prettier"
    Arguments: "--check"
    On failure: warn

  Execution: runs on this machine as you, in the project directory, on every matching workflow event
  Environment access: Inherits the full SPLITBRIEF process environment, including credentials
  Filesystem: Not an OS sandbox; the process can access files available to the current user
  Network: Network access is not restricted

Trust these hooks for this project? [y/N] y
```

The receipt goes to `~/.splitbrief/trust/hooks.json`, keyed by this checkout — not into the repository, so it does not travel with a clone or a copy. `--allow-hooks` skips the prompt in non-TTY (CI) and prints the same disclosure to stderr. Editing the hooks block invalidates trust and re-prompts on the next run.

**Variations:** `on_failure: block` aborts; `warn` (default) logs; `ignore` is silent. Mandatory `timeout_ms` ceiling: 300_000 ms.

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md), recipe 14.

---

## TUI quick reference

### 24. Open the command palette

**When:** you want to discover or quickly invoke any of the slash commands from anywhere in the TUI.

**Run:**

Press `Ctrl+K` from any screen.

**You'll see:**

```
╭──────────────────────────────────────────────────────────────────────────╮
│                                                                          │
│  › Type a command…                                                       │
│                                                                          │
│  Navigate                                                              █ │
│  ▌ /help                   Show help                            ctrl+/ █ │
│    /skills                 Skills for every seat  <skill-id …>         █ │
│    /sessions               Browse past sessions                        █ │
│    /settings               Crew, validation, workflow           ctrl+, █ │
│    /home                   Return to home screen                       █ │
│    /quit                   Exit application                     ctrl+q █ │
│    Skill · Terminal layout Check spacing and terminal-width behavior   █ │
│    Skill · Release checks  Run deterministic quality gates             │ │
│  Crew                                                                  │ │
│    /crew                   Who fills each seat  [plan|build|review]    │ │
│    /refresh                Re-detect available tools                   │ │
│  Workflow                                                              │ │
│    /stop                   Open stop and session options               │ │
│   ↓ 10 more                                                              │
│                                                                          │
│  ↑↓ select · ⏎ run or fill in · esc close                                │
│                                                                          │
╰──────────────────────────────────────────────────────────────────────────╯
```

Captured at 80x24 on the workflow screen, in a project with two skills (the `Skill ·` rows); the bar on the right is the scrollbar. Start typing to fuzzy-filter the list. Enter on a no-argument command runs it; Enter on a command that takes an argument prefills `/name ` in the composer so you can complete it. Press Escape to dismiss without invoking.

**Notes:**
- The palette is disabled while another overlay (help, settings, skills) is active.
- Commands whose `validScreens` excludes your current screen are hidden from the list.
- With an empty query the rows are grouped under the five command categories — `Navigate`, `Crew`, `Workflow`, `View`, `Input & output`. The headers collapse when the panel has fewer than 12 list slots (60x18), and the panel itself grows with the terminal instead of sitting at a fixed width.
- `/crew` opens Settings on the Crew section with `plan` focused; `/crew plan`, `/crew build` and `/crew review` skip Settings and open that seat's picker; the seat's tool and model are changed from there, and its effort travels with the model.
- Effort is no longer its own command — it is chosen with the model in the seat picker, and the crew row mirrors it read-only. Which backends can spend a level: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [CONFIGURATION.md](./CONFIGURATION.md).
- `Ctrl+K` is handled by `src/app/keys.ts`.

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

---

### 25. Confirm a destructive file write

**When:** a file write is classified as `destructive` (a control-plane path under `.git/**` or `.splitbrief/**`). A protected write always asks; no setting turns it off.

**You'll see:**

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ Approval · destructive                                 ┃
┃                                                        ┃
┃ control-plane file write                               ┃
┃ .splitbrief/state.json                                 ┃
┃ this cannot be undone ──────────────────────────────── ┃
┃                                                        ┃
┃ ▌     Confirm                                          ┃
┃   r   Confirm with a reason                            ┃
┃   x   Deny                                             ┃
┃                                                        ┃
┃ ↑↓ select · ⏎ confirm · esc deny                       ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

**Steps:**
1. `↑↓` move the highlight and `⏎` takes the highlighted row; the gate opens on Confirm. Pressing `⏎` approves the write and the evidence trail records that no reason was stated.
2. To record why instead, move to `r` first, type a reason (e.g. `repairing session metadata`), then press `⏎`.

**Key assignment:** every protected-path prompt confirms on `⏎` over the highlighted row. On the `destructive` class the Confirm row carries no key of its own — `y` does not approve a control-plane write; it moves the highlight to Confirm and answers with `⏎ confirms this write · esc deny`, which keeps the way out visible at the moment the user mis-keyed. The other protected classes — `package_change` (titled `Change a package manifest:`) and `sensitive_change` (CI configuration, env and key files, titled `Change a CI or secret file:`) — also confirm on `y`.

**Rejection cases:**
- `x`, `n`, `⏎` on the highlighted `x` row, or Escape → action denied (`user_cancelled`).
- Keystrokes buffered before the prompt appeared are discarded for 150 ms, so typeahead cannot confirm a write.

**Notes:**
- A confirmation holds for that path for the rest of the run; it is recorded in the run's `evidence.json`, not in a grants file.
- There are no sticky grants and no tier overrides.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#protected-path-confirmation), recipe 9.

---

### 26. Adapt the plan from a rejection

**When:** the implementer proposed an action you rejected, and you want the planner to take that rejection into account on the next run. Planner and implementer roles: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

**Setup (`.splitbrief/config.yaml`):**

```yaml
approval:
  feedRejectionsToPlanner: true   # default: true
```

**What happens:**

When `feedRejectionsToPlanner` is `true`, every rejected action is recorded in the session's evidence ledger as an `EvidenceRejection` entry:

```json
{
  "type": "rejection",
  "taskId": "T002",
  "actionClass": "package_change",
  "actionDescription": "write package.json",
  "reason": "user_cancelled"
}
```

On the next turn of the planning session (for example after a correction at the plan card, or when a stopped run continues in planning), the planner receives these rejection entries as the lead of its prompt and adapts — for example, by proposing a different approach for the rejected write.

**You'll see:** the new plan on the plan card, with T002 no longer writing the rejected path.

**Variations:** Set `approval.feedRejectionsToPlanner: false` to keep rejections out of planner context (useful when you want to deny an action once without influencing the plan).

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval, recipe 12.

---

## One-shot review

### 27. Review a diff without starting a run

**When:** the code is already written — by you, a teammate, or another agent — and you want SPLITBRIEF's review seat on it without a plan, a session, or a state machine.

**Run:**

```bash
splitbrief review                                   # everything uncommitted
splitbrief review --base main                       # the branch against main
splitbrief review --base main --reviewer codex@high # a second-opinion seat, high effort
```

**You'll see:**

```
Reviewing changes since main (reviewer: OpenAI Codex CLI)

### Verdict
pass_with_notes
...

Verdict: pass_with_notes
  warning: the new branch in resolve() has no test
.splitbrief/reviews/2026-09-11-174210/review.md
```

The diff is `git diff <base|HEAD>` plus untracked files, handed to the same review prompt a full run uses — with the specification line replaced by `none — review for correctness, scope creep, and test coverage of the diff`, because there is no spec to check against.

Nothing is written under `.splitbrief/sessions/`, and `.splitbrief/active` is untouched: a run in progress elsewhere is unaffected. A clean tree prints `nothing to review` and exits `0` without spawning anything.

**Variations:** `--reviewer` takes the seat grammar the skills use, `<tool>[:<model>][@<effort>]`. With no `--reviewer`, the seat is the configured `reviewer:` block, or the planner when there is none.

**See also:** [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md) §splitbrief review.

---

## See also

- [docs/WORKFLOW.md](./WORKFLOW.md) — phase machine, modes, abort/queue/continue.
- [docs/CONFIGURATION.md](./CONFIGURATION.md) — every config field with type, default, description.
- [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — full reference for the runtime slash commands.
- [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, payloads, security model.
- [docs/ARCHITECTURE.md](./ARCHITECTURE.md) — canonical inventory of CLI commands, runners, sinks, paths.
- [docs/DEBUGGING.md](./DEBUGGING.md) — JSONL inspection, headless mode.
- [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief schema, drift-report rules, evidence vocabulary.
