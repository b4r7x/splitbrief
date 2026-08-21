# SPLITBRIEF Cookbook — Usage Examples

A task-oriented reference for "how do I do X?". Every recipe is copy-paste ready against the current CLI surface and slash-command catalog. Where a recipe references a config field, the field name matches the zod schema in `src/core/schemas/config.ts`.

If you're new to SPLITBRIEF, read this in order: recipes 1–5 cover the basic workflow, 6–9 cover cost, 10–15 cover safety, then jump to whatever you need.

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
splitbrief start --mode instant "rename function calcualteTax to calculateTax in src/billing/tax.ts"
```

**You'll see:**

```
mode resolved: instant
planner_status: instant_plan
instant_plan_received · 1 task
T001  modify  src/billing/tax.ts  rename function
implementer_generate_done
validate · tsc ✓ lint ✓ test ✓
task_completed T001
workflow_complete
```

`instant` mode does one planner call, parses `tasks.md` directly, and goes straight into the task loop — no `spec.md`, no `plan.md`, no approval gates.

**Variations:** `splitbrief start --mode quick "..."` if you want a brief generated but no approval gate. Set `workflow.mode: instant` in config to default new runs to instant.

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

`standard` is the default mode (4 planner calls). The spec gate blocks by default (`approve: spec`). While the composer is empty, one key settles the gate: `y` approves, `q` rejects, `e` opens the review file in the external editor, and `c` starts a comment. The typed commands still work and are what RPC and attached clients send — `approve`, `comment <text>`, `reject` / `quit`, `edit` / `edit-file`. Typing anything turns the letters back into text, so a draft is never eaten by a shortcut. `VISUAL` is explicit; otherwise SPLITBRIEF uses non-terminal `EDITOR`, detected GUI editors from safe absolute `PATH` segments, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`; Windows detection honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims.

**Variations:** `--approve none` skips the spec and plan approval gates only. Standard and speckit modes still run the brief-review gate before implementation. `--approve all` blocks on spec and plan (the speckit default). During a gate, approve or reject through the TUI prompt or the matching RPC response.

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

**When:** you want an expensive planner (Claude Code subscription) to compile briefs but a cheap hosted API model to execute them.

**Setup (`.splitbrief/config.yaml`):**

<!-- config-example: cheap-cloud-profiles -->
```yaml
version: 3
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: groq
  service: groq
  offering: payg
  apiBase: https://api.groq.com/openai/v1
  model: openai/gpt-oss-120b
implementerProfiles:
  default: cheap-cloud
  profiles:
    cheap-cloud:
      kind: api
      provider: groq
      service: groq
      offering: payg
      apiBase: https://api.groq.com/openai/v1
      model: openai/gpt-oss-120b
      label: Groq GPT OSS
      costTier: cheap
validation:
  typecheck: true
  lint: true
  test: true
```

`openai/gpt-oss-120b` on Groq is a bundled **`compatible-only`** row — T-080 recorded OMIT-NOT-APPLICABLE for it, so it carries no SPLITBRIEF quality claim (see the [bundled model catalog](./CONFIGURATION.md#bundled-model-catalog-t-081-runtime-state)). Set `GROQ_API_KEY` in your environment per [docs/API-KEYS.md](./API-KEYS.md) — never inline credentials in YAML. Named `implementerProfiles` persist in config; recovery can route a stuck task to another profile via `route-bigger-worker`. Groq is pay-as-you-go with provider-dependent billing; prompts leave your machine for hosted inference.

**Run:**

```bash
splitbrief doctor              # verify claude-code auth and GROQ_API_KEY readiness
splitbrief start "add a CSV exporter"
```

**You'll see:**

```
planner: claude-code (cli)  · subscription, no API spend tracked
implementer: groq · openai/gpt-oss-120b
cost_update: planner unpriced · implementer $0.02
validate · tsc ✓ lint ✓ test ✓
```

The planner bills through your Claude Code subscription, so its usage reads `unpriced` — never zero cost and never `local`, which is reserved for local backends. The implementer shows metered API spend when pricing metadata is available, and the session total reads `$0.02 + unpriced`.

**Variations:** For local backends (`ollama`, `lm-studio`), see the [provider matrix](./CONFIGURATION.md#provider-matrix) and bundled catalog — like every bundled row, local defaults are **`compatible-only`**, not recommended. Swap the planner `tool` using the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix).

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §implementer / §implementerProfiles, [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [docs/API-KEYS.md](./API-KEYS.md).

---

### 8. Review cost breakdown

**When:** the run is over (or paused) and you want to see where the spend went.

**Run:**

In the TUI, press `Ctrl+G` to open the cost drilldown. Or post-hoc:

```bash
jq 'select(.type == "cost_update")' .splitbrief/sessions/<id>/session.jsonl | tail -20
splitbrief status --history
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

CLI `splitbrief status --history`:

```
Cost History (3 sessions)
  Total spent:    $0.90
  Total saved:    ~$4.20
  Avg savings:    82%
  Avg local rate: 73%

  By Provider:
    Claude Code:  $0.90 (3 sessions)
```

The drilldown reads from `summary.json` (final spend) plus per-event `cost_update` records in `session.jsonl`. Bars at the top of each row scale to the largest line item.

**Variations:** `splitbrief status` prints the active workflow phase, task, and provider status. `splitbrief status --history` walks every `summary.json` under `.splitbrief/sessions/`.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md) §Event log, recipe 36.

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

### 10. Create a snapshot before risky work

**When:** you're about to start a refactor and want a known-good restore point.

**Run:**

```bash
splitbrief snapshot create --name "before-refactor"
```

**You'll see:**

```
Snapshot created: 2026-04-26T14-30-00-000Z
  Name: before-refactor
  Files: 412
  Location: .splitbrief/sessions/<id>/snapshots/2026-04-26T14-30-00-000Z
```

Snapshots use a baseline + delta layout under `.splitbrief/sessions/<id>/snapshots/`. The first snapshot copies every tracked file (honouring `.gitignore` plus the always-excluded set `.git`, `.splitbrief`, `node_modules`, `.trees`); later snapshots only store changed files.

**Variations:** Omit `--name` to get an unnamed snapshot keyed only by ISO timestamp. `--session <id>` snapshots a specific session (default: active).

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §6 Persistence layout, recipes 11–13.

---

### 11. Restore after a bad run

**When:** the implementer rewrote a file you wanted to keep and you snapshotted before.

**Run:**

```bash
splitbrief snapshot list
splitbrief snapshot restore before-refactor
```

**You'll see:**

```
Restored 17 file(s) from snapshot 2026-04-26T14-30-00-000Z.
```

If a file was modified after the snapshot, restore reports it as a conflict and skips it:

```
Conflicts (not restored — modified since snapshot):
  src/auth/middleware.ts
Run with --force to overwrite.
```

**Variations:** `--force` overrides conflicts. Pass an ISO id (`2026-04-26T14-30-00-000Z`) instead of a name. Restore exits non-zero on conflicts so CI can detect them.

**See also:** recipe 12.

---

### 12. Diff current state vs snapshot

**When:** you want to see what changed since a snapshot without restoring anything.

**Run:**

```bash
splitbrief snapshot diff before-refactor
```

**You'll see:**

```
modified  src/billing/tax.ts        (+12 / -3)
added     src/billing/tax.test.ts
removed   src/billing/legacy.ts
unchanged 410 files
```

Exit code is non-zero when there are changes — useful in scripts that want to gate on "did anything change?".

**Variations:** `--no-color` for plain text output. Pass an ISO id directly when you don't have a name.

**See also:** recipes 10–11.

---

### 13. Auto-snapshot every task

**When:** you want a per-task safety net so a single bad implementation can't lose work.

**Setup (`.splitbrief/config.yaml`):**

```yaml
snapshots:
  auto:
    preTask: true
    postTask: true
    preFinalReview: true
```

**Run:**

```bash
splitbrief start "rewrite the auth flow"
```

**You'll see:**

```
snapshot_created · phase=implementing taskIndex=0  (auto preTask)
T001 ✓
snapshot_created · phase=implementing taskIndex=0  (auto postTask)
snapshot_created · phase=implementing taskIndex=1  (auto preTask)
…
```

`postTask` only fires when the task reached `done` (failed tasks don't take a postTask snapshot). `preFinalReview` snapshots once before the planner reviews the cumulative diff.

**Variations:** Set just `preTask: true` for the cheapest safety net. All triggers are off by default. Failures emit a `warning` event and don't abort the run.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §snapshots, [docs/WORKFLOW.md](./WORKFLOW.md) §Auto-snapshots.

---

### 14. Approve risky declared file writes explicitly

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

**Variations:** Set every produced file-write class to `auto` for legacy YOLO behavior, or to `confirm` for paranoid mode. `approval.headless: true` fails closed in CI when a `confirm` would have prompted.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval, recipes 15, 25.

---

### 15. Catch agent drift early

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

### 16. Pause and edit the brief

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

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) `/revise-spec`, recipe 17.

---

### 17. Reject the brief and regenerate

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

### 18. Migrate away from rich brief review

**When:** an older project config still sets `workflow.briefReview: rich`.

**Setup (`.splitbrief/config.yaml`):**

```yaml
workflow:
  briefReview: simple    # 'rich' is deprecated and maps to simple review
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

**Variations:** Leaving `briefReview: rich` in a legacy config is safe, but it no longer opens an inline plan editor. Prefer changing it to `simple` so the config matches the runtime behavior.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) `workflow.briefReview`.

---

### 19. Skip a task

**When:** one task in the brief is wrong and you want to move on without running it.

**Run:**

The cleanest way is a `pre_task` hook that returns `decision: deny`. Add to `.splitbrief/config.yaml`:

```yaml
hooks:
  pre_task:
    - kind: module
      path: ./.splitbrief/hooks/skip-by-id.js
      on_failure: block
```

`./.splitbrief/hooks/skip-by-id.js`:

```js
export default async function (event, ctx) {
  const SKIP = new Set(['T002']);
  if (event.taskId && SKIP.has(event.taskId)) {
    return { kind: 'deny', message: 'skipped per local override' };
  }
  return { kind: 'allow' };
}
```

**You'll see:**

```
T001 ✓
T002 skipped: skipped per local override
T003 ✓
```

Denied tasks land in the evidence ledger as `skipped: <reason>`. There is no `/skip-task` slash command today — denying via hook is the supported path.

**Variations:** A non-module shell hook can do the same — exit non-zero with `on_failure: block`. To re-run a skipped task later, see recipe 20.

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md) §`kind: module`, recipe 39.

---

### 20. Redo a completed task

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

### 21. Switch mode mid-workflow

**When:** the run is taking longer than expected, or the planner classified the task wrong.

**Run:**

```
> /mode quick
```

**You'll see:**

```
Mode set to 'quick'. Saved to .splitbrief/config.yaml.
```

`/mode <name>` accepts `instant`, `quick`, `standard`, or `speckit` and persists the value to config. `/mode` with no argument opens the mode-selector overlay.

**Variations:** `--mode <name>` on `start` / `resume` is the same setting at the CLI boundary. The mode advisor (`mode_advice` event) hints when the current mode looks wrong but never auto-switches.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.2.

---

### 22. Abort cleanly

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

## Handoff to external agent

Built-in handoff targets `claude-code` and `copilot-issue` correspond to admitted PASS CLI runners (`subscription-included` billing; see the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix)). Tool-neutral targets (`spec-kit`, `agents-md`) export markdown packs without spawning a runner. Billing and API posture for mixed planner/implementer workflows: [CONFIGURATION.md](./CONFIGURATION.md).

### 23. Export brief to Claude Code

**When:** you used SPLITBRIEF to compile the brief but want Claude Code to do the actual coding.

**Run:**

```bash
splitbrief spec "add JWT auth"            # plan only, no implementation
splitbrief handoff claude-code
cd .splitbrief/handoffs/claude-code
claude                                  # opens Claude Code in a primed dir
```

**You'll see:**

```
Handoff written to: .splitbrief/handoffs/claude-code
  manifest.json
  README.md
  spec.md
  plan.md
  tasks/T001.md
  tasks/T002.md
  tasks/T003.md
```

The Claude Code renderer drops a `CLAUDE.md` and per-task `.md` files structured to be picked up by Claude's auto-context. The target name matches the admitted `claude-code` CLI id in the [canonical CLI runner matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix).

**Variations:** `--out path/to/dir` redirects the output. `--mode overwrite` clobbers an existing pack; `--mode append` adds task files alongside.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §1 Handoff packs, [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), recipes 24–27.

---

### 24. Export to GitHub issue body

**When:** you want a bug-tracker-shaped issue body that Copilot or a human contributor can pick up.

**Run:**

```bash
splitbrief handoff copilot-issue --out .splitbrief/handoffs/issue
gh issue create \
  --title "Add JWT auth" \
  --body-file .splitbrief/handoffs/issue/issue.md
```

**You'll see:**

```
Handoff written to: .splitbrief/handoffs/issue
  manifest.json
  issue.md
```

The `copilot-issue` renderer writes one Markdown issue body. It embeds selected task IDs, titles, files, acceptance criteria, constraints, and validation commands in `issue.md`; it does not emit `tasks/<id>.md` files. GitHub Copilot CLI (`copilot`) is an admitted runner in the [canonical CLI matrix](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix).

**Variations:** `--task T001,T003` only includes a subset of tasks. Pair with `gh issue edit` to update an existing issue.

**See also:** recipes 23, 25.

---

### 25. Export universal Spec Kit folder

**When:** you want a tool-neutral handoff matching the [Spec Kit](https://github.com/github/spec-kit) layout (`spec.md`, `plan.md`, `tasks/`).

**Run:**

```bash
splitbrief handoff spec-kit
```

**You'll see:**

```
Handoff written to: handoff/spec-kit
  manifest.json
  README.md
  spec.md
  plan.md
  tasks/T001.md
  tasks/T002.md
```

`spec-kit` is the default target (`splitbrief handoff` with no argument). The manifest carries `briefHash` so downstream tools can detect drift.
When `.specify/memory/constitution.md` exists, the pack also includes it as `constitution.md`, matching the constitution Speckit enforces during planning.

**Variations:** `agents-md` produces an `AGENTS.md` instead — the emerging cross-tool agent context standard.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §8 `engine/handoff/`.

---

### 26. Handoff a single task

**When:** you want to delegate just one task to an external agent without exporting the full brief.

**Run:**

```bash
splitbrief handoff claude-code --task T003 --out handoff/T003
```

Or inline during a session:

```
> /handoff claude-code T003
```

**You'll see:**

```
Handoff written to: handoff/T003
  manifest.json
  README.md
  tasks/T003.md
```

The pack contains only the requested task, but the supporting spec / plan are still included so the receiving agent has context.

**Variations:** `--task T001,T003,T005` for a subset. Without `--task`, every task is included.

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) `/handoff`.

---

### 27. Define a custom renderer

**When:** none of the four built-in targets fit and you want a Linear ticket / Jira issue / Slack post format.

**Setup:** create `.splitbrief/handoff-renderers/linear-ticket.js`:

```js
export default function render(input) {
  const body =
    `## Tasks\n\n` +
    input.tasks
      .map(t => `- [ ] **${t.id}** — ${t.title} (\`${(t.scope?.inBounds ?? [t.file]).join(', ')}\`)`)
      .join('\n');
  return {
    files: [
      { path: 'ticket.md', content: `# ${input.feature}\n\n${body}\n` },
    ],
  };
}
```

**Run:**

```bash
splitbrief handoff --list                  # confirm the custom target appears
splitbrief handoff linear-ticket --allow-custom-renderer --out handoff/linear
```

**You'll see:**

```
Built-in targets:
  spec-kit
  agents-md
  claude-code
  copilot-issue
Custom renderers:
  linear-ticket
Handoff written to: handoff/linear
  manifest.json
  ticket.md
```

Custom renderers are dynamically imported from `.splitbrief/handoff-renderers/` only after trust is enabled for that command or through `trust.customRenderers: true`. They can be sync or async; TypeScript renderers must be loadable by the current Node runtime or an already-registered loader. Built-in CLI-backed targets (`claude-code`, `copilot-issue`) align with admitted tool ids in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#canonical-cli-runner-matrix); run `splitbrief doctor` before handoff if auth readiness matters.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §8 `engine/handoff/load-renderer.ts`, [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

---

## Live MCP

### 28. Expose session over MCP

**When:** you want Claude Code, Cursor, or another MCP-aware client to read the active session's spec / plan / evidence as resources.

**Run:**

```bash
splitbrief mcp serve --port 4321
```

**You'll see:**

```
splitbrief MCP server ready

  URL:    http://127.0.0.1:4321/mcp
  Token:  3b9a8c…
  Sessions: 2026-04-26-add-jwt-auth

To configure in Claude Code (.claude/settings.json):
  {
    "mcpServers": {
      "splitbrief": {
        "type": "http",
        "url": "http://127.0.0.1:4321/mcp",
        "headers": { "Authorization": "Bearer 3b9a8c…" }
      }
    }
  }

Press Ctrl+C to stop.
```

The bearer token is generated per invocation and only printed once. Restart the server to rotate.

This endpoint exposes read-only session resources plus constrained evidence tools (`report_evidence`, `report_progress`, `mark_task_done`, `report_validation_result`, `report_error`). The tools only update `.splitbrief/sessions/<id>/evidence.json` for existing sessions and tasks; they do not run shell commands, write project files, or execute tasks.

**Variations:** `--session <id>` serves a specific session (otherwise the active session). Default port is 4321; choose a concrete port with `--port <number>` when 4321 is unavailable.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §1 MCP server.

---

### 29. Multi-session MCP discovery

**When:** you want one MCP endpoint to expose every session under a project (handy when running parallel worktrees).

**Run:**

```bash
splitbrief mcp serve --all-sessions --port 4321
```

**You'll see:**

```
splitbrief MCP server ready
  Sessions: all
```

The MCP resource list now includes `state.json`, `summary.json`, `tasks`, individual `tasks/<id>`, `evidence.json`, `drift-report.json`, and available spec/plan resources. With `workflow.persistTranscript: false`, the sessions index and `state.json` read resource use transcript-protected text for feature, task, queued-message, and queued-question fields. Multi-session mode is still not an execution surface; the only mutation surface is the constrained evidence-tool set for existing sessions and tasks.

**Variations:** `--session` and `--all-sessions` are mutually exclusive.

**See also:** recipe 28.

---

## Worktrees & parallel

### 30. Try a feature in isolation

**When:** you want to start a workflow on a branch in its own directory without touching the main checkout.

**Run:**

```bash
splitbrief start --worktree my-feature "experiment with a streaming parser"
```

**You'll see:**

```
Starting session in worktree .trees/my-feature (branch splitbrief/my-feature)
mode resolved: standard
phase: researching
…
```

The worktree lives at `.trees/my-feature/`, on branch `splitbrief/my-feature`. Each worktree has its own `.splitbrief/` directory and own session lockfile, so two parallel runs cannot collide.

**Variations:** `--worktree` (no value) auto-slugifies the feature description. Worktrees do not isolate dev-server ports or `node_modules` — see [docs/WORKTREES.md](./WORKTREES.md) for mitigations.

**See also:** recipe 31.

---

### 31. List and clean up worktrees

**Run:**

```bash
splitbrief worktree list
splitbrief worktree remove my-feature --delete-branch
```

**You'll see:**

```
NAME              BRANCH                       STATUS
my-feature        splitbrief/my-feature           idle
old-experiment    splitbrief/old-experiment       running  (2026-04-25-…)

Removed worktree ".trees/my-feature".
Deleted branch splitbrief/my-feature.
```

Remove refuses to delete a worktree with a live session or uncommitted changes; `--force` overrides both guards.

**Variations:** `splitbrief worktree switch <name>` prints the `cd` command (worktree switching can't actually change the parent shell's CWD).

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

## Server-client / detach

### 32. Run a long planner job in the background

**When:** the planner phase will take a while and you want to keep your terminal free.

**Run:**

```bash
splitbrief start --detach "rewrite the billing pipeline"
```

**You'll see:**

```
Session 2026-04-26-rewrite-billing started (pid 38291).
Run: splitbrief attach 2026-04-26-rewrite-billing
```

`--detach` spawns the workflow as a background server with its own IPC socket at `.splitbrief/sessions/<id>/ipc.sock`. Logs go to `.splitbrief/sessions/<id>/server.log`. The lockfile records pid + heartbeat for `splitbrief ps`. Planner runner billing follows the configured backend — subscription CLIs vs metered APIs: [CONFIGURATION.md](./CONFIGURATION.md), [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

**Variations:** `splitbrief ps` lists every running, exited, and crashed session in the project. `--detach` cannot be combined with `--json` or `--rpc`.

**See also:** recipe 33, [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §1 IPC server, [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

---

### 33. List background sessions and check status

**When:** you forgot which sessions are still running.

**Run:**

```bash
splitbrief ps
```

**You'll see:**

```
SESSION-ID                              STATUS    PID    MODE       ELAPSED   FEATURE
2026-04-26-rewrite-billing              running   38291  speckit    01:14:22  rewrite the billing pipeline
2026-04-26-add-jwt-auth                 exited    -      standard   00:42:11  add JWT auth
2026-04-25-flaky-experiment             crashed   -      standard   00:08:05  try a streaming parser
```

A `crashed` row means the server died without writing a clean exit. `splitbrief attach <id>` on a crashed session prints a post-mortem from `server.log`.

**Variations:** `splitbrief ps` is read-only and does not acquire the active-session lock.

**See also:** recipe 34, [docs/DEBUGGING.md](./DEBUGGING.md).

---

### 34. Recover from a crashed session

**When:** `splitbrief ps` shows `crashed` and you want to know what happened.

**Run:**

```bash
splitbrief attach 2026-04-25-flaky-experiment
```

**You'll see:**

```
session 2026-04-25-flaky-experiment is not running

Crash diagnostic
  Last heartbeat: 2026-04-25T18:42:11Z (12 hours ago)
  Exit code:      137 (SIGKILL — likely OOM)
  Tail of server.log:
    [planner] context length 200000 exceeded
    [orchestrator] uncaught error: …
```

Once you've inspected the diagnostic, re-run with `splitbrief resume` (if the phase is resumable) or start fresh.

**Variations:** `cat .splitbrief/sessions/<id>/server.log` for the full server log; `cat .splitbrief/sessions/<id>/session.jsonl | jq '.type'` for the event stream up to the crash.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md), recipe 36.

---

## Headless / CI

### 35. Run in CI without TUI

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

**See also:** recipes 37–38.

---

### 36. Drive a run over RPC

**When:** you are building an editor extension, service wrapper, or test harness that needs to answer gates programmatically.

**Run:**

```bash
splitbrief start --rpc --allow-hooks "add auth audit logging"
```

**Send commands on stdin (NDJSON):**

```json
{"type":"status"}
{"type":"approve"}
{"type":"brief_review","id":"cmd-1","command":{"action":"status"}}
{"type":"brief_review","id":"cmd-2","promptId":"approval-2","command":{"action":"external_edit_applied"}}
{"type":"message","text":"Use the existing audit logger."}
{"type":"recovery","action":"retry-same-worker"}
```

**You'll see responses on stdout:**

```json
{"type":"status","data":{"type":"readiness_report","report":{"status":"ready"}}}
{"type":"event","data":{"type":"workflow_started","ts":1745692800000,"phase":"researching","feature":"add auth audit logging"}}
{"type":"status","data":{"pending":"approval","approvalType":"spec","filePath":"/repo/.splitbrief/sessions/.../spec.md"}}
{"type":"ack","command":"approve"}
```

`brief_review` commands are scoped to a pending Task Brief prompt. `save_draft` re-reads `tasks.md`, parses the Task Briefs, runs brief quality checks, persists the updated `BRIEFS_READY` and brief quality state, and returns `ack` / `status` responses marked `saved` with the original correlation ids. It does not approve, reject, or resolve the prompt. `--rpc` is mutually exclusive with `--json`. Workflow events are wrapped in `event` responses; command failures use `error` responses and do not crash the stream.

### 36a. Recover a blocked Brief from JSON/RPC

**When:** a headless run reports a Brief contract problem and you need to inspect or resolve it
without inventing a planner comment.

For an owner-facing RPC resume, use `splitbrief resume --rpc`.

**Inspect first:**

```json
{
  "version": 1,
  "sessionId": "session-1",
  "epochId": "epoch-1",
  "action": "status"
}
```

Status is observational: it reads the owner's current projection and makes no recovery/provider
call. A public result is versioned and machine-readable, for example:

```json
{ "type": "status", "data": { "status": "UNRESOLVED", "operationId": "operation-1" } }
{ "type": "error", "code": "brief_contract_blocked", "status": "blocked", "operationId": null }
```

**Retry once, deliberately:**

Forward this owner-facing command only when the projection advertises `retry`:

```json
{
  "version": 1,
  "sessionId": "session-1",
  "epochId": "epoch-1",
  "operationId": "operation-1",
  "base": { "revision": 1, "hash": "brief-hash", "path": "tasks.md" },
  "intentHash": "retry-intent-hash",
  "action": "retry",
  "diagnosticFingerprint": "diagnostic-hash",
  "frozenInputIds": []
}
```

The retry payload has no fabricated comment or revision request. The owner revalidates the epoch,
base evidence, allowed action, and operation identity; a duplicate operation ID is replayed or
refused rather than dispatched a second time. A `brief_recovery_result` record reports whether the
attempt was accepted, is in flight, became ready, or was blocked. A blocked headless outcome exits
non-zero with its typed code (`brief_contract_blocked`, `brief_provider_error`, or
`brief_budget_exhausted`).

**Resolve terminal outcomes:**

| Projection | Meaning | Next action |
| --- | --- | --- |
| `blocked` | quality, provider, budget, or storage evidence prevents approval | `retry` when advertised, edit, or `reject` |
| `UNRESOLVED` | a provider dispatch may have happened; replay is unsafe | explicit `resolve-unresolved` with `rebind` or `abandon`, then edit/reject |
| `rejected` | the Brief epoch is closed by user intent | start a new epoch; do not approve or retry the old one |
| `ready` | the current Brief/report pair passed the contract gate | approve or edit |

**Attach or reconnect:**

```bash
splitbrief start --detach "rewrite the billing pipeline"
splitbrief attach <session-id> --project .
splitbrief status --project .
```

`attach` and reconnect replay the live owner's projection. `status`, attach, and reconnect are
observational and perform zero recovery/provider calls and zero local recovery-state writes. Retry,
edit, reject, approve, and unresolved resolution are forwarded to the live owner; if that owner is
gone, the normal fenced takeover path must complete before state is hydrated.
The UI keeps this projection in `src/stores/workflow/review.ts`; that store owns display state only,
not recovery authority, receipts, persistence, budget, or provider calls.

**Layout check:**

The composer/input is always full width (`x = 0`, `width = cols`) and remains outside the scrollable
body. The sidebar renders only when `cols > 120`; at `121` the body and the sidebar end on the same
bottom row, and at `120`, `119`, `80`, `50`, and `40` the sidebar and gap disappear and the body
reaches the content bottom on its own. The body height is passed once to the conversation
or review viewport, so status/help rows cannot be clipped into the scroll range or subtract a
second row.

**See also:** [docs/STORES-AND-UI.md](./STORES-AND-UI.md) §Brief recovery and whole-screen geometry,
[docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md), recipe 32.

---

### 37. Parse cost in CI

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

### 38. Fail CI on budget exceeded

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

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) `workflow.maxBudget`, recipes 6, 35.

---

## Power user

### 39. Define project-level coding rules

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

**Variations:** Constitution-check is speckit-only. Standard / quick / instant don't read it. Delete the file to disable.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.3.2.

---

### 40. Run pre/post task shell hooks

**When:** you want to format with Prettier and run Biome after every task without modifying the validation pipeline.

**Setup (`.splitbrief/config.yaml`):**

```yaml
hooks:
  builtin:
    prettier-on-change: true       # built-in: prettier --write ${event.file}
    block-secrets: true            # built-in: scan ${event.file} for AWS / GH / OpenAI / Anthropic keys
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

The receipt goes to `~/.splitbrief/trust/hooks.json`, keyed by this checkout — not into the repository, so it does not travel with a clone or a copy. `--allow-hooks` skips the prompt in non-TTY (CI) and prints the same disclosure to stderr. Editing the hooks block or a module hook file invalidates trust and re-prompts on the next run.

**Variations:** `kind: module` for in-process JS / TS hooks. `on_failure: block` aborts; `warn` (default) logs; `ignore` is silent. Mandatory `timeout_ms` ceiling: 300_000 ms.

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md), recipe 19.

---

### 41. Use OpenTelemetry for tracing

**When:** you want span-level visibility (workflow → phase → task → validation) in Honeycomb, Tempo, or any OTLP-compatible backend.

**Setup (`.splitbrief/config.yaml`):**

```yaml
otel:
  enabled: true
  serviceName: splitbrief
```

**Quick local check (console exporter):**

```bash
OTEL_TRACES_EXPORTER=console splitbrief start --json --mode quick "smoke test"
```

**Real OTLP setup:** SPLITBRIEF uses the global TracerProvider, so register one in a wrapper script before invoking SPLITBRIEF:

```ts
// otel-bootstrap.mjs
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace } from '@opentelemetry/api';

const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }))],
});
trace.setGlobalTracerProvider(provider);
```

Node's `--import` flag ensures the bootstrap runs before the main script, so the TracerProvider is registered before SPLITBRIEF starts.

**Run:**

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$HONEYCOMB_KEY" \
node --import ./otel-bootstrap.mjs ./node_modules/.bin/splitbrief start "..."
```

**You'll see (in your OTLP backend):**

```
splitbrief.workflow                6m12s   splitbrief.mode=standard
├─ splitbrief.phase.researching    0m38s
├─ splitbrief.phase.specifying     1m02s
├─ splitbrief.phase.planning       0m51s
├─ splitbrief.phase.implementing   3m14s
│  ├─ splitbrief.task              0m58s   splitbrief.task.id=T001  splitbrief.task.method=local
│  ├─ splitbrief.task              1m21s   splitbrief.task.id=T002  splitbrief.task.method=escalation
│  └─ splitbrief.task              0m55s   splitbrief.task.id=T003  splitbrief.task.method=local
└─ splitbrief.phase.final-review   0m27s
```

The sink (`src/engine/events/sinks/otel.ts`) maps engine events to spans; registration is gated by `otel.enabled: true`.

**Variations:** `--otel-exporter console` is the easiest way to confirm the sink is wired before configuring OTLP. `serviceName` sets the tracer/instrumentation scope name.

**See also:** [docs/OTEL.md](./OTEL.md), [docs/DEBUGGING.md](./DEBUGGING.md) §OpenTelemetry.

---

## TUI quick reference

### 42. Open the command palette

**When:** you want to discover or quickly invoke any of the slash commands from anywhere in the TUI.

**Run:**

Press `Ctrl+K` from any screen.

**You'll see:**

```
┌─ Commands ──────────────────────────────────────────────┐
│ > _                                                      │
│   /mode                 Change workflow mode             │
│   /effort               Change planner effort            │
│   /planner              Choose planner                   │
│   /revise-spec          Rewind to spec with comment      │
│   …                                                      │
└──────────────────────────────────────────────────────────┘
```

Start typing to fuzzy-filter the list. Press Enter on the highlighted entry to invoke. Press Escape to dismiss without invoking.

**Notes:**
- The palette is disabled while another overlay (help, settings, skills) is active.
- Commands whose `validScreens` excludes your current screen are hidden from the list.
- `/planner` and `/effort` select among admitted planner backends in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and API providers in [CONFIGURATION.md](./CONFIGURATION.md).
- `Ctrl+K` is handled by `src/app/keys.ts:178`.

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

---

### 43. Confirm a destructive file write (confirm tier)

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

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval.tiers, recipe 14.

---

### 44. Adapt the plan from a rejection

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

## See also

- [docs/WORKFLOW.md](./WORKFLOW.md) — phase machine, modes, abort/queue/continue.
- [docs/CONFIGURATION.md](./CONFIGURATION.md) — every config field with type, default, description.
- [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — full reference for the runtime slash commands.
- [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, payloads, security model.
- [docs/ARCHITECTURE.md](./ARCHITECTURE.md) — canonical inventory of CLI commands, runners, sinks, paths.
- [docs/DEBUGGING.md](./DEBUGGING.md) — JSONL inspection, headless mode, OTel console exporter.
- [docs/WORKTREES.md](./WORKTREES.md) — what worktrees do and don't isolate.
- [docs/OTEL.md](./OTEL.md) — span hierarchy, exporter setup, dual-resolution caveat.
- [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief schema, drift-report rules, evidence vocabulary.
