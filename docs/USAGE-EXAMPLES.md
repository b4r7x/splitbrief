# SPLITBRIEF Cookbook — Usage Examples

A task-oriented reference for "how do I do X?". Every recipe is copy-paste ready against the current CLI surface and slash-command catalog. Where a recipe references a config field, the field name matches the zod schema in `src/core/schemas/config.ts`.

If you're new to SPLITBRIEF, read this in order: recipes 1–5 cover the basic workflow, 6–9 cover cost, 10–11 cover safety, then jump to whatever you need.

> **Conventions.** Commands assume you're in the project root. Long YAML examples elide unrelated config; the loader fills in defaults. The TUI snippets below ("You'll see") use the same line shapes the workflow renders today; exact spacing and color may vary by terminal.

---

## Basic flows

### 1. First time setup

**When:** the project doesn't have a `.splitbrief/` directory yet.

**Run:**

```bash
# SPLITBRIEF is not published to npm yet — install from source
git clone https://github.com/b4r7x/splitbrief.git
cd splitbrief && npm install && npm run build && npm link

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
  Mode [standard] >  ↵
  Wrote .splitbrief/config.yaml
```

`init` writes `.splitbrief/config.yaml` (`version: 3`) and creates `.splitbrief/`. The default planner is the admitted `claude-code` CLI (subscription-included billing; see the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix)). The first `splitbrief start` then creates `.splitbrief/sessions/<session-id>/` and writes `.splitbrief/active`. Run `splitbrief doctor` after setup or runner changes — it is read-only and surfaces remediation copy for non-ready CLI/API states without starting a workflow.

**Variations:** `splitbrief init --reconfigure` overwrites an existing config. To initialize another project, run `splitbrief init` from that project directory.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [docs/BOOTSTRAP.md](./BOOTSTRAP.md), [docs/API-KEYS.md](./API-KEYS.md).

---

### 2. Fix a typo

**When:** the change is a one-line edit in one file. No spec, no plan, no approval gate.

**Run:**

```bash
splitbrief start --mode quick "rename function calcualteTax to calculateTax in src/billing/tax.ts"
```

**You'll see:**

```
mode resolved: quick
planner_status: quick_plan
brief_quality_passed
T001  modify  src/billing/tax.ts  rename function
implementer_generate_done
validate · tsc ✓ lint ✓ test ✓
task_completed T001
workflow_complete
```

`quick` mode does one planner call and goes straight into the task loop — no `spec.md`, no `plan.md`, no approval gates. Because the mode advisor reads "rename" in a short prompt as `trivial`, the planner is additionally told to skip its codebase-structure review and to keep the run to a handful of briefs.

**Variations:** Set `workflow.mode: quick` in config to default new runs to quick. `--mode instant` is retired: it still runs, resolves to `quick`, and prints a deprecation notice.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.3.1, recipe 3.

---

### 3. Add a small feature

**When:** the change touches one file but you want a Task Brief written to disk for review.

**Run:**

```bash
splitbrief start --mode quick "add an isAdult helper that returns true when age >= 18"
```

**You'll see:**

```
mode resolved: quick
planner_status: quick_plan
brief_quality_passed
T001  create  src/utils/age.ts  add isAdult helper
validate · tsc ✓ lint ✓ test ✓
workflow_complete
```

`quick` mode produces a `tasks.md` transport in the session folder and runs the brief-quality gate, but skips the supporting `spec.md` / `plan.md` and the `reviewing-briefs` approval gate. Useful when you want the brief on disk for audit but don't need the ceremony of standard mode.

**Variations:** Add `--budget 0.50` to cap spend. Pair with `--implementer ollama` to keep the implementer free. If you want only the Task Brief without touching the working tree at all, `splitbrief spec --mode quick "add an isAdult helper that returns true when age >= 18"` produces the same single `tasks.md` planning output without implementing.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.2.

---

### 4. Refactor across files

**When:** the change touches several files and you want a planner→implementer split with one approval gate on the supporting spec.

**Run:**

```bash
splitbrief start "extract the duplicated date-formatting logic into a shared util"
```

**You'll see:**

```
mode resolved: standard
phase: researching
phase: specifying      → spec.md
phase: reviewing-spec  ← awaiting approval
  y approve · c comment · q reject · e edit
> y
phase: planning        → plan.md, tasks.md
phase: reviewing-briefs ← brief approval (simple view)
> y
phase: implementing
  T001 ✓  T002 ✓  T003 ✓
phase: final-review    → review.md
workflow_complete
```

`standard` is the default mode (4 planner calls). The spec gate blocks by default (`approve: spec`). While the composer is empty, one key settles the gate: `y` approves, `q` rejects, `e` opens the review file in the external editor, and `c` starts a comment. The typed commands still work — `approve`, `comment <text>`, `reject` / `quit`, `edit` / `edit-file`. Typing anything turns the letters back into text, so a draft is never eaten by a shortcut. `VISUAL` is explicit; otherwise SPLITBRIEF uses non-terminal `EDITOR`, detected GUI editors from safe absolute `PATH` segments, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`; Windows detection honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims.

**Variations:** `--approve none` skips the spec and plan approval gates only. Standard and speckit modes still run the brief-review gate before implementation. `--approve all` blocks on spec and plan (the speckit default). During a gate, approve or reject through the TUI prompt.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.3, recipe 5.

---

### 5. Add auth, migration, or security work

**When:** the change is large, risky, or externally visible. You want maximum ceremony: research, clarifications, constitution check, plan, analyze, then tasks.

**Run:**

```bash
splitbrief start --mode speckit "add JWT bearer auth to the public REST API"
```

**You'll see:**

```
mode resolved: speckit
phase: researching        → research.md
phase: specifying         → spec.md
phase: reviewing-spec     ← approval (speckit default)
phase: clarifying         → clarifications.md
  Q: which library? express-jwt or jose?
> jose
phase: constitution-check → constitution-check.json (passed)
phase: planning           → plan.md
phase: reviewing-plan     ← approval
phase: analyzing          → analyze.json
  specTaskCoverage: 0.94  planTaskCoverage: 0.91
phase: implementing
  T001 ✓ T002 ✓ T003 ✓ T004 ✓
phase: final-review
```

Speckit runs 6–7 planner calls and writes `research.md`, `spec.md`, `clarifications.md`, `constitution-check.json`, `plan.md`, `analyze.json`, and `tasks.md` to the session directory. Constitution violations with `severity: hard` abort the run.

**Variations:** `workflow.speckit.minCoverage` (default `0.9`) controls when analyze warnings fire. Drop the constitution by deleting `.specify/memory/constitution.md`.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.3.2, [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md).

---

## Cost management

### 6. Set a budget

**When:** you want the workflow to warn at 80% and pause at a configurable threshold of a dollar ceiling.

**Setup (`.splitbrief/config.yaml`):**

```yaml
workflow:
  maxBudget: 2.00
  budgetPauseThreshold: 0.85   # pause prompt at 85% of maxBudget
```

**Run:**

```bash
splitbrief start "refactor the payments module"
```

**You'll see (status line):**

```
mode standard · spent $1.23 · proj $1.81 · budget $2.00 · plan 62% · cache 41%
budget_warning · spent $1.60 / $2.00 (80%)
budget_paused  · spent $1.70 / $2.00 (85%)  → continue? [y/N]
```

Three events fire as spend grows: `budget_warning` at 80%, `budget_paused` at the configured threshold, and `budget_exceeded` at 100% — the last halts the workflow.

**Variations:** `--budget 5.00` overrides the config field for one run. Omit `maxBudget` entirely to disable budget enforcement.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) `workflow.maxBudget`, recipe 8.

---

### 7. Use a cheap implementer

**When:** you want an expensive planner (Claude Code subscription) to compile briefs but a cheap local model to execute them.

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
      costTier: local
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

### 8. Review cost breakdown

**When:** the run is over (or paused) and you want to see where the spend went.

**Run:**

In the TUI, press `Ctrl+G` to open the cost drilldown. Or post-hoc:

```bash
jq 'select(.type == "cost_update")' .splitbrief/sessions/<id>/session.jsonl | tail -20
```

**You'll see:**

TUI `Ctrl+G` drilldown:

```
Cost breakdown
  planner    research        $0.18
  planner    specifying      $0.22
  planner    planning        $0.35
  planner    final-review    $0.11
  implementer (per task)     local
  escalation                 $0.04
  ──────────────────────────────────
  total                      $0.90
```

The drilldown reads from `summary.json` (final spend) plus per-event `cost_update` records in `session.jsonl`. Bars at the top of each row scale to the largest line item.

**Variations:** `splitbrief status` prints the active workflow phase, task, and provider status.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md) §Event log.

---

### 9. Use Claude Code subscription as planner

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

**Variations:** Swap `tool` for any admitted CLI in the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix); `splitbrief init` auto-detects installed tools. For a hosted cloud implementer instead of local Ollama, use recipe 7.

**See also:** [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md) §planner / §implementer, [docs/API-KEYS.md](./API-KEYS.md).

---

## Safety

### 10. Approve risky declared file writes explicitly

**When:** you want SPLITBRIEF to confirm before the implementer writes control-plane paths, package manifests/lockfiles, or files outside the task's declared scope.

**Setup (`.splitbrief/config.yaml`):**

```yaml
approval:
  enabled: true
  tiers:
    read:               auto       # silent
    write_in_scope:     auto       # silent (task.file or task.scope.inBounds)
    write_out_of_scope: confirm    # always prompt
    destructive:        confirm    # control-plane paths
    package_change:     confirm    # package manifests/lockfiles
  feedRejectionsToPlanner: true
```

**Run:**

```bash
splitbrief start "consolidate the test fixtures"
```

**You'll see (when an out-of-scope write triggers):**

```
approval_prompted
  class:   write_out_of_scope
  pattern: src/legacy/**/*.ts
  task:    T002 (consolidate fixtures in src/test/)
  [a]pprove once  [s]ticky (this session)  [r]eject
> s
approval_sticky_recorded
```

Sticky grants persist to `.splitbrief/approvals.json`; revoke with `splitbrief approval clear`.

**Variations:** Set every produced file-write class to `auto` for legacy YOLO behavior, or to `confirm` for paranoid mode. A `--json` run has no reply channel, so any class left at `sticky` or `confirm` fails closed there with `APPROVAL_REQUIRED`.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval, recipe 11.

---

### 11. Catch agent drift early

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

**Variations:** Inspect the final deterministic report directly: `cat .splitbrief/sessions/<id>/drift-report.json | jq`. Inspect `drift-chains.json` for cross-task chain state. The summary screen shows a `Drift` row with the latest score.

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md) §Drift detection rules.

---

## Mid-workflow control

### 12. Pause and edit the brief

**When:** the planner produced a brief that's mostly right but needs a tweak before implementation starts.

**Run:**

During the `reviewing-briefs` gate (standard / speckit modes):

```
phase: reviewing-briefs
  T001 add validator     create  src/auth/validate.ts
  T002 wire validator    modify  src/auth/middleware.ts
  T003 add tests         create  src/auth/validate.test.ts
  y approve · c comment · q reject · e edit
> e
```

`e` on an empty composer, plus `Ctrl+E`, `edit`, `E`, and `edit-file`, all point to the external editor path for the brief markdown. `VISUAL` is explicit; otherwise SPLITBRIEF uses non-terminal `EDITOR`, detected GUI editors from safe absolute `PATH` segments, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`; Windows detection honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims. Save and exit; SPLITBRIEF re-reads `tasks.md`, re-runs brief quality, and returns to the brief-review gate until you explicitly approve.

**You'll see:**

```
Opened in editor (vim) … saved.
brief_quality_passed
phase: reviewing-briefs
> y
phase: implementing
```

**Variations:** `comment <text>` triggers planner regeneration with the comment as feedback. The comment goes through `planner.regenerate(...)` exactly the same way `/revise-spec <text>` does.

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) `/revise-spec`, recipe 13.

---

### 13. Reject the brief and regenerate

**When:** the brief got the architecture wrong and you want a do-over.

**Run:**

At the `reviewing-spec` gate:

```
phase: reviewing-spec
> comment the validator should be a plain function, not a class. Reuse the existing isEmail helper.
```

**You'll see:**

```
spec_regenerated
phase: reviewing-spec    ← second pass
> approve
planner_status: planning
```

A non-empty `comment <text>` regenerates. `reject` ends the workflow.

**Variations:** Mid-run, `/revise-spec <text>` rewinds to the spec gate from any phase from `reviewing-spec` onward. `/revise-plan <text>` rewinds only the plan (spec preserved).

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.1, [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

---

### 14. Migrate away from rich brief review

**When:** an older project config still sets `workflow.briefReview: rich`, and config load now refuses it.

**Setup (`.splitbrief/config.yaml`):**

```yaml
workflow:
  briefReview: simple    # the only accepted value; 'rich' fails the load
```

**Run:**

```bash
splitbrief start "add login form"
# opens the simple review gate when the run reaches reviewing-briefs
```

**You'll see:**

```
phase: reviewing-briefs
  T001 add validator     create  src/auth/validate.ts
  T002 wire validator    modify  src/auth/middleware.ts
  T003 add tests         create  src/auth/validate.test.ts

  y approve · c comment · q reject · e edit
```

`e` on an empty composer, plus `Ctrl+E`, `edit`, `E`, and `edit-file`, open `.splitbrief/sessions/<id>/tasks.md` in the external editor. `VISUAL` is explicit; otherwise SPLITBRIEF uses non-terminal `EDITOR`, detected GUI editors from safe absolute `PATH` segments, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`; Windows detection honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims. Save and exit; SPLITBRIEF re-reads `tasks.md`, re-runs brief quality, and returns to the brief-review gate until you explicitly approve.

**Variations:** Dropping the key entirely works too — `briefReview` falls back to `simple` in every mode when it is not set.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) `workflow.briefReview`.

---

### 15. Skip a task

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

**Variations:** To re-run a skipped task later, see recipe 16.

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md), recipe 23.

---

### 16. Redo a completed task

**When:** a task succeeded but the result wasn't what you wanted, and you've now updated the spec via `/revise-spec`.

**Run:**

```
> /redo-task T003
```

**You'll see:**

```
task_reset T003
T003 (re-run): pending → in_progress
implementer_generate_done
validate · tsc ✓ lint ✓ test ✓
task_completed T003
```

`/redo-task` only resets the single task — it doesn't re-plan. Use `/revise-plan` to regenerate the brief instead.

**Variations:** Redo is gated to `implementing`, `validating-task`, and `escalating` phases. The slash command takes the task ID; calling without one prints a usage error.

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) `/redo-task`, [docs/WORKFLOW.md](./WORKFLOW.md) §1.1.

---

### 17. Switch mode mid-workflow

**When:** the run is taking longer than expected, or the planner classified the task wrong.

**Run:**

```
> /mode quick
```

**You'll see:**

```
Mode set to 'quick'. Saved to .splitbrief/config.yaml.
```

`/mode <name>` accepts `quick`, `standard`, or `speckit` and persists the value to config. The retired `instant` is accepted too: it sets `quick` and reports that the modes were merged. `/mode` with no argument opens the mode-selector overlay.

**Variations:** `--mode <name>` on `start` / `resume` is the same setting at the CLI boundary. The mode advisor (`mode_advice` event) hints when the current mode looks wrong but never auto-switches.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.2.

---

### 18. Abort cleanly

**When:** something is wrong and you want to stop without losing the partial transcript.

**Run:**

- **Ctrl-C once** during a live phase: aborts the current planner / implementer call. Partial output preserved with `interrupted: true` in `session.jsonl`. Workflow enters `awaitingContinue: true`. Press Enter to continue, or type a message and Enter to inject context on resume.
- **Ctrl-C twice within 2 seconds:** exits the process after state is saved. Continue later with `splitbrief continue <session-id>` if the saved state is resumable.

**You'll see:**

```
^C  Aborting current turn… (press again within 2s to exit)
phase: planning · awaitingContinue
> what about edge case X?
phase: planning  ← resumes with the message folded in
```

`Esc` closes overlays first. On the workflow screen, it follows the same guarded interruption flow: press once to arm the interrupt/cancel action shown in the footer, then press again to fire it.

**Variations:** `splitbrief resume` re-enters the active saved phase. Use `splitbrief continue <session-id>` when the active pointer is absent but you know the session id. Safe resume covers saved `planning`, `implementing`, and `final-review` phases; earlier phases (`researching`, `specifying`) refuse resume with a clear error.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.5, §1.6.

---

## Headless / CI

### 19. Run in CI without TUI

**When:** you want SPLITBRIEF to run unattended in GitHub Actions or another CI runner.

**Run:**

```bash
splitbrief start --json --allow-hooks "regenerate API client from openapi.yaml" \
  | tee events.ndjson
```

**You'll see (NDJSON, one event per line):**

```
{"type":"workflow_started","ts":1745692800000,"phase":"researching","feature":"regenerate API client from openapi.yaml"}
{"type":"planner_status","ts":1745692801200,"phase":"researching","status":"researching"}
{"type":"brief_quality_passed","ts":1745692840100,"phase":"planning","score":1,"warningCount":0}
{"type":"task_completed","ts":1745692902300,"phase":"implementing","taskId":"T001"}
…
{"type":"workflow_complete","ts":1745692980000,"phase":"complete"}
```

`--json` requires a feature argument and replaces the TUI sink with NDJSON-on-stdout. The on-disk JSONL log is still written. `--allow-hooks` skips the interactive trust prompt.

**Variations:** `CI=1` env var auto-disables fullscreen mode even without `--json`.

**See also:** recipes 20–22.

---

### 20. Parse cost in CI

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

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md) §Event log, [docs/CONFIGURATION.md](./CONFIGURATION.md), recipe 8.

---

### 21. Fail CI on budget exceeded

**When:** you want CI to bail when spend exceeds the configured ceiling.

**Setup (`.splitbrief/config.yaml`):**

```yaml
workflow:
  maxBudget: 1.50
```

**CI script:**

```bash
splitbrief start --json --allow-hooks --approve none "..." | tee events.ndjson
status=$?

if jq -e 'select(.type == "budget_exceeded")' events.ndjson > /dev/null; then
  echo "::error::splitbrief budget exceeded; failing build"
  exit 1
fi

exit $status
```

**You'll see:**

```
{"type":"budget_warning","ts":...,"spent":1.20,"budget":1.50}
{"type":"budget_exceeded","ts":...,"spent":1.51,"budget":1.50}
::error::splitbrief budget exceeded; failing build
```

`--json` exit code is 0 on `workflow_complete`, non-zero on workflow errors. The grep above adds an extra gate on the soft budget signal.

**Variations:** Combine with `--approve none` for unattended runs that should skip spec and plan prompts. Standard and speckit still stop at briefs review; use quick mode if you need no brief-review prompt.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) `workflow.maxBudget`, recipes 6, 19.

---

### 22. Read a headless run without a JSON parser

**When:** CI or a shell script needs the shape of a run — which phase, which task, what the review said — and piping NDJSON through `jq` is more machinery than the job deserves.

**Run:**

```bash
splitbrief start --plain --approve none --allow-hooks "regenerate API client from openapi.yaml"
```

**You'll see:**

```
phase: researching
phase: planning
phase: implementing
task T001: done (typecheck lint test)
task T002: done (typecheck lint test)
task T003: done (typecheck lint test)
phase: final-review
phase: complete
review: passed
done: 3 tasks, 128.4k tokens
```

The count in the closing line is the number of tasks this run completed, so a resumed run reports only the tasks it ran itself.

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

Cost is reported in tokens, not dollars: the event stream carries token counts, and the price catalog lives outside the run. For dollars, use `--json` (recipe 20) or read `summary.json` after the run.

`--plain` and `--json` are two renderings of one stream and cannot share stdout — passing both exits `2` with `--plain and --json cannot be combined; choose one output mode.`

**Variations:** `splitbrief resume --plain` and `splitbrief continue --plain` render a resumed run the same way. A resume that lands on a different crew than the one that started the run prints `PLAN seat changed <old> → <new>; context will be rebuilt` to stderr first, so redirect stderr if you want stdout alone.

**See also:** [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md) §Plain output stream, recipes 20–21.

---

## Power user

### 23. Define project-level coding rules

**When:** you want speckit's constitution-check to enforce project conventions (no React Context, ESM `.js` suffix, etc.).

**Setup:** write `.specify/memory/constitution.md`:

```markdown
# Project Constitution

## Principle 1 — Zero runtime classes
Production TypeScript uses pure functions and module-scoped state.
Test fixtures may contain class syntax only when class behavior is under test.

## Principle 2 — ESM .js suffix
Every internal import uses the `.js` suffix: `'./foo.js'` not `'./foo'`.

## Principle 3 — No barrels
Re-export-only `index.ts` files are forbidden under `src/`.
```

**Run:**

```bash
splitbrief start --mode speckit "add a new HTTP client"
```

**You'll see:**

```
phase: constitution-check
  passed: true
  violations: []
```

A hard violation (`severity: hard`) aborts the run with a `warning` event explaining which principle failed.

**Variations:** Constitution-check is speckit-only. Standard and quick don't read it. Delete the file to disable.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.3.2.

---

### 24. Run pre/post task shell hooks

**When:** you want to format with Prettier and run Biome after every task without modifying the validation pipeline.

**Setup (`.splitbrief/config.yaml`):**

```yaml
hooks:
  post_task:
    - command: "npx"
      args: ["biome", "check", "--write", "${event.file}"]
      timeout_ms: 10000
      on_failure: warn
  pre_commit:
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

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md), recipe 15.

---

## TUI quick reference

### 25. Open the command palette

**When:** you want to discover or quickly invoke any of the slash commands from anywhere in the TUI.

**Run:**

Press `Ctrl+K` from any screen.

**You'll see:**

```
╭──────────────────────────────────────────────────────────────────────────╮
│                                                                          │
│  › Type a command…                                                       │
│                                                                          │
│  Navigate                                                                │
│  ▌ /help               Show help overlay                         ctrl+/  │
│    /sessions           Browse past sessions                              │
│    /settings           Crew, validation, workflow                ctrl+,  │
│    /home               Return to home screen                             │
│    /quit               Exit application                          ctrl+q  │
│  Crew                                                                    │
│    /crew               Who fills each seat          [plan|build|review]  │
│    /mode               Workflow mode           [quick|standard|speckit]  │
│    /refresh            Re-detect available tools                         │
│   ↓ 15 more                                                              │
│                                                                          │
│  ↑↓ navigate · ⏎ run or fill in · esc close                              │
│                                                                          │
╰──────────────────────────────────────────────────────────────────────────╯
```

Captured on the workflow screen. Start typing to fuzzy-filter the list. Enter on a no-argument command runs it; Enter on a command that takes an argument prefills `/name ` in the composer so you can complete it. Press Escape to dismiss without invoking.

**Notes:**
- The palette is disabled while another overlay (help, settings, skills) is active.
- Commands whose `validScreens` excludes your current screen are hidden from the list.
- With an empty query the rows are grouped under the five command categories — `Navigate`, `Crew`, `Workflow`, `View`, `Input & output`. The headers collapse when the panel has fewer than 12 list slots (60x18), and the panel itself grows with the terminal instead of sitting at a fixed width.
- `/crew` opens Settings on the Crew section with `plan` focused; `/crew plan`, `/crew build` and `/crew review` skip Settings and open that seat's picker; the seat's tool and model are changed from there, and its effort travels with the model.
- Effort is no longer its own command — it is chosen with the model in the seat picker, and the crew row mirrors it read-only. Which backends can spend a level: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [CONFIGURATION.md](./CONFIGURATION.md).
- `Ctrl+K` is handled by `src/app/keys.ts`.

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

---

### 26. Confirm a destructive file write (confirm tier)

**When:** a declared file write is classified as `destructive` (for example, a control-plane path under `.splitbrief/**`) and `approval.tiers.destructive` is set to `confirm`.

**You'll see:**

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ Approval · destructive                                 ┃
┃                                                        ┃
┃ control-plane file write                               ┃
┃ .splitbrief/state.json                                 ┃
┃ this cannot be undone ──────────────────────────────── ┃
┃                                                        ┃
┃ ▸ enter   Confirm                                      ┃
┃   r       Confirm with a reason                        ┃
┃   x       Deny                                         ┃
┃                                                        ┃
┃ esc deny                                               ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

**Steps:**
1. Press Enter. The write is approved and the evidence trail records that no reason was stated.
2. To record why instead, press `r` first, type a reason (e.g. `repairing session metadata`), then press Enter.

**Key assignment:** the primary key is Enter only for the `destructive` class. Every other confirm-tier class — `package_change`, or any class you configure as `confirm` — takes `y`. Pressing `y` on a destructive prompt does not confirm it; the prompt answers with `enter confirms this write · esc deny`, which keeps the way out visible at the moment the user mis-keyed.

**Rejection cases:**
- `x`, `n`, or Escape → action denied (`user_cancelled`).
- Keystrokes buffered before the prompt appeared are discarded for 150 ms, so typeahead cannot confirm a write.

**Notes:**
- Confirm-tier approvals are one-shot and are NOT persisted to `.splitbrief/approvals.json`.
- Only `sticky`-tier grants are saved to `approvals.json`.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval.tiers, recipe 10.

---

### 27. Adapt the plan from a rejection

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
  "actionClass": "write_out_of_scope",
  "actionDescription": "delete src/legacy/auth.ts",
  "reason": "user_cancelled"
}
```

On the next planner call (e.g. after `/revise-plan` or a task loop restart), the planner receives these rejection entries as context and adapts — for example, by proposing a different approach for the rejected action or updating scope to exclude the off-limits path.

**You'll see (after `/revise-plan`):**

```
planner_status: planning (with 2 rejection(s) in context)
plan_regenerated · 3 tasks  ← T002 now avoids the rejected path
```

**Variations:** Set `approval.feedRejectionsToPlanner: false` to keep rejections out of planner context (useful when you want to deny an action once without influencing the plan).

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval, [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) `/revise-plan`.

---

## One-shot review

### 28. Review a diff without starting a run

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
