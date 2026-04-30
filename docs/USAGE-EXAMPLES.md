# diptych Cookbook — Usage Examples

A task-oriented reference for "how do I do X?". Every recipe is copy-paste ready against the current CLI surface and slash-command catalog (21 commands). Where a recipe references a config field, the field name matches the zod schema in `src/core/schemas/config.ts`.

If you're new to diptych, read this in order: recipes 1–5 cover the basic workflow, 6–9 cover cost, 10–15 cover safety, then jump to whatever you need.

> **Conventions.** Commands assume you're in the project root. Long YAML examples elide unrelated config; the loader fills in defaults. The TUI snippets below ("You'll see") use the same line shapes the workflow renders today; exact spacing and color may vary by terminal.

---

## Basic flows

### 1. First time setup

**When:** the project doesn't have a `.diptych/` directory yet.

**Run:**

```bash
npm install --global diptych        # or: npm install --save-dev diptych
diptych init                        # interactive wizard
diptych start "add a hello-world endpoint"
```

**You'll see:**

```
diptych init
  Detected: claude-code, codex, ollama
  Planner [claude-code] >  ↵
  Implementer [ollama qwen2.5-coder:7b] >  ↵
  Mode [standard] >  ↵
  Wrote .diptych/config.yaml
```

`init` writes `.diptych/config.yaml` (`version: 3`) and creates `.diptych/`. The first `diptych start` then creates `.diptych/sessions/<session-id>/` and writes `.diptych/active`.

**Variations:** `diptych init --reconfigure` overwrites an existing config. `diptych init --project ../other-repo` initializes a different project.

**See also:** [docs/CONFIG.md](./CONFIG.md), [docs/BOOTSTRAP.md](./BOOTSTRAP.md), [docs/API-KEYS.md](./API-KEYS.md).

---

### 2. Fix a typo

**When:** the change is a one-line edit in one file. No spec, no plan, no approval gate.

**Run:**

```bash
diptych start --mode instant "rename function calcualteTax to calculateTax in src/billing/tax.ts"
```

**You'll see:**

```
mode resolved: instant
planner_status: instant_plan
plan_done · 1 task
T001  modify  src/billing/tax.ts  rename function
implementer_generate_done
validate · tsc ✓ lint ✓ test ✓
task_completed T001
workflow_complete
```

`instant` mode does one planner call, parses `tasks.md` directly, and goes straight into the task loop — no `spec.md`, no `plan.md`, no approval gates.

**Variations:** `diptych start --mode quick "..."` if you want a brief generated but no approval gate. Set `workflow.mode: instant` in config to default new runs to instant.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.3.1, recipe 3.

---

### 3. Add a small feature

**When:** the change touches one file but you want a Task Brief written to disk for review.

**Run:**

```bash
diptych start --mode quick "add an isAdult helper that returns true when age >= 18"
```

**You'll see:**

```
mode resolved: quick
planner_status: quick_plan
plan_done · 1 task
brief_quality_passed
T001  create  src/utils/age.ts  add isAdult helper
validate · tsc ✓ lint ✓ test ✓
workflow_complete
```

`quick` mode produces a `tasks.md` transport in the session folder and runs the brief-quality gate, but skips the supporting `spec.md` / `plan.md` and the `reviewing-briefs` approval gate. Useful when you want the brief on disk for audit but don't need the ceremony of standard mode.

**Variations:** Add `--budget 0.50` to cap spend. Pair with `--implementer ollama` to keep the implementer free.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.2.

---

### 4. Refactor across files

**When:** the change touches several files and you want a planner→implementer split with one approval gate on the supporting spec.

**Run:**

```bash
diptych start "extract the duplicated date-formatting logic into a shared util"
```

**You'll see:**

```
mode resolved: standard
phase: researching
phase: specifying      → spec.md
phase: reviewing-spec  ← awaiting approval
  [a]pprove  [c]omment  [r]eject  [e]dit
> a
phase: planning        → plan.md, tasks.md
phase: reviewing-briefs ← brief approval (simple view)
> a
phase: implementing
  T001 ✓  T002 ✓  T003 ✓
phase: final-review    → review.md
workflow_complete
```

`standard` is the default mode (4 planner calls). The spec gate blocks by default (`approve: spec`). Press `a` to approve, `c <text>` to send a comment that triggers regeneration, `r` to reject, `e` to open `$EDITOR` for inline edits.

**Variations:** `--approve none` skips both gates. `--approve all` blocks on spec and plan (the speckit default). `/approve` at runtime updates the resolved level mid-run.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.3, recipe 5.

---

### 5. Add auth, migration, or security work

**When:** the change is large, risky, or externally visible. You want maximum ceremony: research, clarifications, constitution check, plan, analyze, then tasks.

**Run:**

```bash
diptych start --mode speckit "add JWT bearer auth to the public REST API"
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

**Setup (`.diptych/config.yaml`):**

```yaml
workflow:
  maxBudget: 2.00
  budgetPauseThreshold: 0.85   # pause prompt at 85% of maxBudget
```

**Run:**

```bash
diptych start "refactor the payments module"
```

**You'll see (status line):**

```
mode standard · spent $1.23 · proj $1.81 · budget $2.00 · plan 62% · cache 41%
budget_warning · spent $1.60 / $2.00 (80%)
budget_paused  · spent $1.70 / $2.00 (85%)  → continue? [y/N]
```

Three events fire as spend grows: `budget_warning` at 80%, `budget_paused` at the configured threshold, and `budget_exceeded` at 100% — the last halts the workflow.

**Variations:** `--budget 5.00` overrides the config field for one run. Omit `maxBudget` entirely to disable budget enforcement.

**See also:** [docs/CONFIG.md](./CONFIG.md) `workflow.maxBudget`, recipe 8.

---

### 7. Use a cheap implementer

**When:** you want an expensive planner (Claude / GPT) to compile briefs but a free local model to execute them.

**Setup (`.diptych/config.yaml`):**

```yaml
version: 3
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: lm-studio
  apiBase: http://localhost:1234/v1
  model: qwen2.5-coder-7b-instruct
  contextLength: 32768
  temperature: 0.3
```

**Run:**

```bash
lms server start              # start LM Studio API
diptych start "add a CSV exporter"
```

**You'll see:**

```
planner: claude-code
implementer: lm-studio · qwen2.5-coder-7b-instruct (local)
cost_update: planner $0.41 · implementer local
```

The footer renders `local` instead of a dollar amount when the implementer is unpriced — diptych never invents fake savings.

**Variations:** Swap `lm-studio` for `ollama` (`apiBase: http://localhost:11434/v1`) for an Ollama backend. Use Sonnet or Opus on the planner via `kind: api, provider: anthropic, model: claude-sonnet-4-6`.

**See also:** [docs/CONFIG.md](./CONFIG.md) §planner / §implementer.

---

### 8. Review cost breakdown

**When:** the run is over (or paused) and you want to see where the spend went.

**Run:**

In the TUI, press `$` to open the cost drilldown. Or post-hoc:

```bash
jq 'select(.type == "cost_update")' .diptych/sessions/<id>/session.jsonl | tail -20
diptych status --history
```

**You'll see:**

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

**Variations:** `diptych status` prints just the active-session totals. `diptych status --history` walks every `summary.json` under `.diptych/sessions/`.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md) §Event log, recipe 36.

---

### 9. Use Claude Code subscription as planner

**When:** you have a Claude Pro / Max subscription and don't want to pay per-token through the API.

**Setup (`.diptych/config.yaml`):**

```yaml
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b
```

**Run:**

```bash
diptych start "add input validation to the signup form"
```

**You'll see:**

```
planner: claude-code (cli)  · subscription, no API spend tracked
```

`kind: cli` spawns `claude` as a subprocess with the brief on stdin. Spend goes through your subscription, so diptych shows `local` for planner cost too.

**Variations:** Other CLI tools: `tool: codex`, `opencode`, `aider`, `copilot`, `kilo-code`. Each is auto-detected by `diptych init`.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §7 Runner abstraction.

---

## Safety

### 10. Create a snapshot before risky work

**When:** you're about to start a refactor and want a known-good restore point.

**Run:**

```bash
diptych snapshot create --name "before-refactor"
```

**You'll see:**

```
Snapshot created: 2026-04-26T14-30-00-000Z
  Name: before-refactor
  Files: 412
  Location: .diptych/sessions/<id>/snapshots/2026-04-26T14-30-00-000Z
```

Snapshots use a baseline + delta layout under `.diptych/sessions/<id>/snapshots/`. The first snapshot copies every tracked file (honouring `.gitignore` plus the always-excluded set `.git`, `.diptych`, `node_modules`); later snapshots only store changed files.

**Variations:** Omit `--name` to get an unnamed snapshot keyed only by ISO timestamp. `--session <id>` snapshots a specific session (default: active).

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §6 Persistence layout, recipes 11–13.

---

### 11. Restore after a bad run

**When:** the implementer rewrote a file you wanted to keep and you snapshotted before.

**Run:**

```bash
diptych snapshot list
diptych snapshot restore before-refactor
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
diptych snapshot diff before-refactor
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

**Setup (`.diptych/config.yaml`):**

```yaml
snapshots:
  auto:
    preTask: true
    postTask: true
    preFinalReview: true
```

**Run:**

```bash
diptych start "rewrite the auth flow"
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

**See also:** [docs/CONFIG.md](./CONFIG.md) §snapshots, [docs/WORKFLOW.md](./WORKFLOW.md) §Auto-snapshots.

---

### 14. Approve every destructive action explicitly

**When:** you want diptych to confirm before the implementer runs `rm`, `npm install`, or anything outside the task's declared scope.

**Setup (`.diptych/config.yaml`):**

```yaml
approval:
  enabled: true
  tiers:
    read:               auto       # silent
    write_in_scope:     auto       # silent (file in task.targetFiles)
    validation:         auto
    write_out_of_scope: confirm    # always prompt
    destructive:        confirm    # rm, drop database, etc.
    network:            sticky     # prompt once, remember for session
    package_change:     confirm    # npm install / yarn add / etc.
  feedRejectionsToPlanner: true
```

**Run:**

```bash
diptych start "consolidate the test fixtures"
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

Sticky grants persist to `.diptych/approvals.json`; revoke with `diptych approval clear`.

**Variations:** Set every class to `auto` for legacy YOLO behavior; set everything to `confirm` for paranoid mode. `approval.headless: true` fails closed in CI when a `confirm` would have prompted.

**See also:** [docs/CONFIG.md](./CONFIG.md) §approval, recipes 15, 25.

---

### 15. Catch agent drift early

**When:** you suspect the implementer is editing files outside the brief's scope across multiple tasks.

**Setup (`.diptych/config.yaml`):**

```yaml
workflow:
  driftChainThreshold: 0.6    # 0.0–1.0; emit drift_chain_detected at/above
```

**Run:**

```bash
diptych start "tidy up the UI"
diptych status     # after a few tasks
```

**You'll see:**

```
drift_report · T002  passed=true  errors=0  warnings=2
drift_chain_detected
  score: 0.71
  representativePath: src/utils/format.ts
  tasks: T001, T002, T003 all touched src/utils/format.ts (out of scope)
```

The drift chain detector tracks out-of-bounds files across tasks. A high score indicates the implementer is repeatedly straying into the same off-scope area — usually a sign the brief was wrong about scope.

**Variations:** Inspect the per-task report directly: `cat .diptych/sessions/<id>/drift-report.json | jq`. The summary screen shows a `Drift` row with the latest score.

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
  [a]pprove  [c]omment  [r]eject  [e]dit
> e
```

Pressing `e` opens `$EDITOR` with the brief markdown. Save and exit; diptych re-parses on the way back.

**You'll see:**

```
Opened in editor (vim) … saved.
brief_quality_passed
phase: implementing
```

**Variations:** `c <text>` triggers planner regeneration with the comment as feedback. The comment goes through `planner.regenerate(...)` exactly the same way `/revise-spec <text>` does.

**See also:** [docs/SLASH-COMMANDS.md](./SLASH-COMMANDS.md) `/revise-spec`, recipe 17.

---

### 17. Reject the brief and regenerate

**When:** the brief got the architecture wrong and you want a do-over.

**Run:**

At the `reviewing-spec` gate:

```
phase: reviewing-spec
> c the validator should be a plain function, not a class. Reuse the existing isEmail helper.
```

**You'll see:**

```
spec_regenerated
phase: reviewing-spec    ← second pass
> a
spec_approved
```

A non-empty comment regenerates; an empty comment skips back to the gate without regenerating. Hard reject (`r`) ends the workflow.

**Variations:** Mid-run, `/revise-spec <text>` rewinds to the spec gate from any phase from `reviewing-spec` onward. `/revise-plan <text>` rewinds only the plan (spec preserved).

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.1, [docs/SLASH-COMMANDS.md](./SLASH-COMMANDS.md).

---

### 18. Edit a single task in the rich plan editor

**When:** the brief is 80% right but one task needs its scope or evidence rewritten.

**Setup (`.diptych/config.yaml`):**

```yaml
workflow:
  briefReview: rich      # default is 'simple'
```

Or just press `e` from the simple view to opt into rich mode for the current session.

**Run:**

```bash
diptych start "add login form"
# at reviewing-briefs gate, press: e
```

**You'll see:**

```
[plan editor]
  ▶ T001 add validator     │ scope: src/auth/validate.ts
    T002 wire validator    │ scope: src/auth/middleware.ts
    T003 add tests         │ scope: src/auth/validate.test.ts

  Use ↑↓ to select, Enter to edit task, ? for keys
```

Per-task editor lets you rewrite signature, implementationSteps, constraints, and validation evidence inline. Save with `Ctrl+S`, discard with `Esc`.

**Variations:** The rich editor is opt-in because most briefs only need approve / comment. Set it as the default with `briefReview: rich` if you typically need to tweak.

**See also:** [docs/CONFIG.md](./CONFIG.md) `workflow.briefReview`.

---

### 19. Skip a task

**When:** one task in the brief is wrong and you want to move on without running it.

**Run:**

The cleanest way is a `pre_task` hook that returns `decision: deny`. Add to `.diptych/config.yaml`:

```yaml
hooks:
  pre_task:
    - kind: module
      path: ./.diptych/hooks/skip-by-id.js
      on_failure: block
```

`./.diptych/hooks/skip-by-id.js`:

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

**See also:** [docs/SLASH-COMMANDS.md](./SLASH-COMMANDS.md) `/redo-task`, [docs/WORKFLOW.md](./WORKFLOW.md) §1.1.

---

### 21. Switch mode mid-workflow

**When:** the run is taking longer than expected, or the planner classified the task wrong.

**Run:**

```
> /mode quick
```

**You'll see:**

```
Mode set to 'quick'. Saved to .diptych/config.yaml.
```

`/mode <name>` accepts `instant`, `quick`, `standard`, or `speckit` and persists the value to config. `/mode` with no argument opens the mode-selector overlay.

**Variations:** `--mode <name>` on `start` / `resume` is the same setting at the CLI boundary. The mode advisor (`mode_advice` event) hints when the current mode looks wrong but never auto-switches.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.2.

---

### 22. Abort cleanly

**When:** something is wrong and you want to stop without losing the partial transcript.

**Run:**

- **Ctrl-C once** during a live phase: aborts the current planner / implementer call. Partial output preserved with `interrupted: true` in `session.jsonl`. Workflow enters `awaitingContinue: true`. Press Enter to continue, or type a message and Enter to inject context on resume.
- **Ctrl-C twice within 2 seconds:** saves state, clears `.diptych/active`, exits the process. Resume later with `diptych resume`.

**You'll see:**

```
^C  Aborting current turn… (press again within 2s to exit)
phase: planning · awaitingContinue
> what about edge case X?
phase: planning  ← resumes with the message folded in
```

`Esc` does **not** abort — it only closes overlays. This is deliberate (avoid accidental aborts).

**Variations:** `diptych resume` re-enters the saved phase. Phases that aren't safely resumable (`researching`, `specifying`, `planning` without `awaitingContinue`) refuse resume with a clear error.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §1.5, §1.6.

---

## Handoff to external agent

### 23. Export brief to Claude Code

**When:** you used diptych to compile the brief but want Claude Code to do the actual coding.

**Run:**

```bash
diptych spec "add JWT auth"            # plan only, no implementation
diptych handoff claude-code
cd handoff/claude-code
claude                                  # opens Claude Code in a primed dir
```

**You'll see:**

```
Handoff written to: handoff/claude-code
  manifest.json
  README.md
  spec.md
  plan.md
  tasks/T001.md
  tasks/T002.md
  tasks/T003.md
```

The Claude Code renderer drops a `CLAUDE.md` and per-task `.md` files structured to be picked up by Claude's auto-context.

**Variations:** `--out path/to/dir` redirects the output. `--mode overwrite` clobbers an existing pack; `--mode append` adds task files alongside.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §1 Handoff packs, recipes 24–27.

---

### 24. Export to GitHub issue body

**When:** you want a bug-tracker-shaped issue body that Copilot or a human contributor can pick up.

**Run:**

```bash
diptych handoff copilot-issue --out handoff/issue
gh issue create \
  --title "Add JWT auth" \
  --body-file handoff/issue/issue-body.md
```

**You'll see:**

```
Handoff written to: handoff/issue
  manifest.json
  issue-body.md
```

The `copilot-issue` renderer flattens the brief into a single Markdown body with task checkboxes, scope notes, and the supporting spec collapsed into a `<details>` block.

**Variations:** `--task T001,T003` only includes a subset of tasks. Pair with `gh issue edit` to update an existing issue.

**See also:** recipes 23, 25.

---

### 25. Export universal Spec Kit folder

**When:** you want a tool-neutral handoff matching the [Spec Kit](https://github.com/github/spec-kit) layout (`spec.md`, `plan.md`, `tasks/`).

**Run:**

```bash
diptych handoff spec-kit
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

`spec-kit` is the default target (`diptych handoff` with no argument). The manifest carries `briefHash` so downstream tools can detect drift.

**Variations:** `agents-md` produces an `AGENTS.md` instead — the emerging cross-tool agent context standard.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §8 `engine/handoff/`.

---

### 26. Handoff a single task

**When:** you want to delegate just one task to an external agent without exporting the full brief.

**Run:**

```bash
diptych handoff claude-code --task T003 --out handoff/T003
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

**See also:** [docs/SLASH-COMMANDS.md](./SLASH-COMMANDS.md) `/handoff`.

---

### 27. Define a custom renderer

**When:** none of the four built-in targets fit and you want a Linear ticket / Jira issue / Slack post format.

**Setup:** create `.diptych/handoff-renderers/linear-ticket.ts`:

```ts
import type { HandoffInput, HandoffPack } from 'diptych/handoff';

export default function render(input: HandoffInput): HandoffPack {
  const body =
    `## Tasks\n\n` +
    input.tasks
      .map(t => `- [ ] **${t.id}** — ${t.title} (\`${t.targetFiles.join(', ')}\`)`)
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
diptych handoff --list                  # confirm the custom target appears
diptych handoff linear-ticket --out handoff/linear
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

Custom renderers are dynamically imported — `.ts` files use the project's tsx loader. They can be sync or async.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §8 `engine/handoff/load-renderer.ts`.

---

## Live MCP

### 28. Expose session over MCP

**When:** you want Claude Code, Cursor, or another MCP-aware client to read the active session's spec / plan / evidence as resources.

**Run:**

```bash
diptych mcp serve --port 4321
```

**You'll see:**

```
diptych MCP server ready

  URL:    http://127.0.0.1:4321/mcp
  Token:  3b9a8c…
  Sessions: 2026-04-26-add-jwt-auth

To configure in Claude Code (.claude/settings.json):
  {
    "mcpServers": {
      "diptych": {
        "type": "http",
        "url": "http://127.0.0.1:4321/mcp",
        "headers": { "Authorization": "Bearer 3b9a8c…" }
      }
    }
  }

Press Ctrl+C to stop.
```

The bearer token is generated per invocation and only printed once. Restart the server to rotate.

This endpoint is read-only. It lets MCP-aware clients inspect session artifacts through resources, but it does not expose MCP tools, run shell commands, write files, or execute tasks.

**Variations:** `--session <id>` serves a specific session (otherwise the active session). Default port is 4321; choose a concrete port with `--port <number>` when 4321 is unavailable.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §1 MCP server.

---

### 29. Multi-session MCP discovery

**When:** you want one MCP endpoint to expose every session under a project (handy when running parallel worktrees).

**Run:**

```bash
diptych mcp serve --all-sessions --port 4321
```

**You'll see:**

```
diptych MCP server ready
  Sessions: all
```

The MCP resource list now includes every session's `state.json`, `tasks.md`, `evidence.json`, `drift-report.json`, and snapshot manifests. It remains a read-only resource list, not a multi-session execution or mutation surface.

**Variations:** `--session` and `--all-sessions` are mutually exclusive.

**See also:** recipe 28.

---

## Worktrees & parallel

### 30. Try a feature in isolation

**When:** you want to start a workflow on a branch in its own directory without touching the main checkout.

**Run:**

```bash
diptych start --worktree my-feature "experiment with a streaming parser"
```

**You'll see:**

```
Starting session in worktree .trees/my-feature (branch diptych/my-feature)
mode resolved: standard
phase: researching
…
```

The worktree lives at `.trees/my-feature/`, on branch `diptych/my-feature`. Each worktree has its own `.diptych/` directory and own session lockfile, so two parallel runs cannot collide.

**Variations:** `--worktree` (no value) auto-slugifies the feature description. Worktrees do not isolate dev-server ports or `node_modules` — see [docs/WORKTREES.md](./WORKTREES.md) for mitigations.

**See also:** recipe 31.

---

### 31. List and clean up worktrees

**Run:**

```bash
diptych worktree list
diptych worktree remove my-feature --delete-branch
```

**You'll see:**

```
NAME              BRANCH                       STATUS
my-feature        diptych/my-feature           idle
old-experiment    diptych/old-experiment       running  (2026-04-25-…)

Removed worktree ".trees/my-feature".
Deleted branch diptych/my-feature.
```

Remove refuses to delete a worktree with a live session or uncommitted changes; `--force` overrides both guards.

**Variations:** `diptych worktree switch <name>` prints the `cd` command (worktree switching can't actually change the parent shell's CWD).

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

## Server-client / detach

### 32. Run a long planner job in the background

**When:** the planner phase will take a while and you want to keep your terminal free.

**Run:**

```bash
diptych start --detach "rewrite the billing pipeline"
```

**You'll see:**

```
Session 2026-04-26-rewrite-billing started (pid 38291).
Run: diptych attach 2026-04-26-rewrite-billing
```

`--detach` spawns the workflow as a background server with its own IPC socket at `.diptych/sessions/<id>/ipc.sock`. Logs go to `.diptych/sessions/<id>/server.log`. The lockfile records pid + heartbeat for `diptych ps`.

**Variations:** `diptych ps` lists every running, exited, and crashed session in the project. `--detach` cannot be combined with `--json`.

**See also:** recipe 33, [docs/ARCHITECTURE.md](./ARCHITECTURE.md) §1 IPC server.

---

### 33. List background sessions and check status

**When:** you forgot which sessions are still running.

**Run:**

```bash
diptych ps
```

**You'll see:**

```
SESSION-ID                              STATUS    PID    MODE       ELAPSED   FEATURE
2026-04-26-rewrite-billing              running   38291  speckit    01:14:22  rewrite the billing pipeline
2026-04-26-add-jwt-auth                 exited    -      standard   00:42:11  add JWT auth
2026-04-25-flaky-experiment             crashed   -      standard   00:08:05  try a streaming parser
```

A `crashed` row means the server died without writing a clean exit. `diptych attach <id>` on a crashed session prints a post-mortem from `server.log`.

**Variations:** `diptych ps` is read-only and does not acquire the active-session lock.

**See also:** recipe 34, [docs/DEBUGGING.md](./DEBUGGING.md).

---

### 34. Recover from a crashed session

**When:** `diptych ps` shows `crashed` and you want to know what happened.

**Run:**

```bash
diptych attach 2026-04-25-flaky-experiment
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

Once you've inspected the diagnostic, re-run with `diptych resume` (if the phase is resumable) or start fresh.

**Variations:** `cat .diptych/sessions/<id>/server.log` for the full server log; `cat .diptych/sessions/<id>/session.jsonl | jq '.type'` for the event stream up to the crash.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md), recipe 36.

---

## Headless / CI

### 35. Run in CI without TUI

**When:** you want diptych to run unattended in GitHub Actions or another CI runner.

**Run:**

```bash
diptych start --json --allow-hooks "regenerate API client from openapi.yaml" \
  | tee events.ndjson
```

**You'll see (NDJSON, one event per line):**

```
{"type":"workflow_started","ts":1745692800000,"phase":"researching","feature":"regenerate API client from openapi.yaml"}
{"type":"planner_status","ts":1745692801200,"phase":"researching","status":"researching"}
{"type":"plan_done","ts":1745692840100,"phase":"planning","taskCount":4}
{"type":"task_completed","ts":1745692902300,"phase":"implementing","taskId":"T001"}
…
{"type":"workflow_complete","ts":1745692980000,"phase":"complete"}
```

`--json` requires a feature argument and replaces the TUI sink with NDJSON-on-stdout. The on-disk JSONL log is still written. `--allow-hooks` skips the interactive trust prompt.

**Variations:** `CI=1` env var auto-disables fullscreen mode even without `--json`.

**See also:** recipes 36–37.

---

### 36. Parse cost in CI

**When:** you want to extract the final cost from a CI run and post it as a build comment.

**Run:**

```bash
diptych start --json "..." 2>/dev/null > events.ndjson

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

The same data lives in `.diptych/sessions/<id>/summary.json` once the run finishes.

**Variations:** Filter for failures: `jq 'select(.type == "task_failed" or .type == "task_full_fail")' events.ndjson`.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md) §Event log, recipe 8.

---

### 37. Fail CI on budget exceeded

**When:** you want CI to bail when spend exceeds the configured ceiling.

**Setup (`.diptych/config.yaml`):**

```yaml
workflow:
  maxBudget: 1.50
```

**CI script:**

```bash
diptych start --json --allow-hooks --approve none "..." | tee events.ndjson
status=$?

if jq -e 'select(.type == "budget_exceeded")' events.ndjson > /dev/null; then
  echo "::error::diptych budget exceeded; failing build"
  exit 1
fi

exit $status
```

**You'll see:**

```
{"type":"budget_warning","ts":...,"spent":1.20,"budget":1.50}
{"type":"budget_exceeded","ts":...,"spent":1.51,"budget":1.50}
::error::diptych budget exceeded; failing build
```

`--json` exit code is 0 on `workflow_complete`, non-zero on workflow errors. The grep above adds an extra gate on the soft budget signal.

**Variations:** Combine with `--approve none` for unattended runs (no spec / plan prompts).

**See also:** recipes 6, 35.

---

## Power user

### 38. Define project-level coding rules

**When:** you want speckit's constitution-check to enforce project conventions (no React Context, ESM `.js` suffix, etc.).

**Setup:** write `.specify/memory/constitution.md`:

```markdown
# Project Constitution

## Principle 1 — Zero classes
TypeScript code must use pure functions and module-scoped state.
The `class` keyword does not appear in `src/`.

## Principle 2 — ESM .js suffix
Every internal import uses the `.js` suffix: `'./foo.js'` not `'./foo'`.

## Principle 3 — No barrels
Re-export-only `index.ts` files are forbidden under `src/`.
```

**Run:**

```bash
diptych start --mode speckit "add a new HTTP client"
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

### 39. Run pre/post task shell hooks

**When:** you want to format with Prettier and run Biome after every task without modifying the validation pipeline.

**Setup (`.diptych/config.yaml`):**

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
    - command: ".diptych/hooks/scan.sh"
      args: ["${event.file}"]
      on_failure: block
```

**Run:**

```bash
diptych start --allow-hooks "add the User model"
```

**You'll see (first run only):**

```
Trust these hooks for this project? [y/N]
> y
hooks trusted (sha256 stored in .diptych/hooks-trust.json)
```

`--allow-hooks` skips the prompt in non-TTY (CI). Editing the hooks block invalidates trust and re-prompts on the next run.

**Variations:** `kind: module` for in-process JS / TS hooks. `on_failure: block` aborts; `warn` (default) logs; `ignore` is silent. Mandatory `timeout_ms` ceiling: 300_000 ms.

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md), recipe 19.

---

### 40. Use OpenTelemetry for tracing

**When:** you want span-level visibility (workflow → phase → task → validation) in Honeycomb, Tempo, or any OTLP-compatible backend.

**Setup (`.diptych/config.yaml`):**

```yaml
otel:
  enabled: true
  serviceName: diptych
```

**Quick local check (console exporter):**

```bash
OTEL_TRACES_EXPORTER=console diptych start --json --mode quick "smoke test"
```

**Real OTLP setup:** diptych uses the global TracerProvider, so register one in a wrapper script before invoking diptych:

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

await import('diptych/cli');
```

**Run:**

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$HONEYCOMB_KEY" \
node --import ./otel-bootstrap.mjs ./node_modules/.bin/diptych start "..."
```

**You'll see (in your OTLP backend):**

```
workflow.run            6m12s   service.name=diptych  workflow.mode=standard
├─ phase.researching    0m38s
├─ phase.specifying     1m02s
├─ phase.planning       0m51s
├─ phase.implementing   3m14s
│  ├─ task.T001         0m58s   task.method=local
│  ├─ task.T002         1m21s   task.method=escalation
│  └─ task.T003         0m55s   task.method=local
└─ phase.final-review   0m27s
```

Engine code never imports `@opentelemetry/*` directly — the sink (`src/engine/events/sinks/otel.ts`) is the only OTel-aware file and is dynamically imported only when `otel.enabled: true`.

**Variations:** `--otel-exporter console` is the easiest way to confirm the sink is wired before configuring OTLP. `serviceName` overrides the `service.name` resource attribute.

**See also:** [docs/OTEL.md](./OTEL.md), [docs/DEBUGGING.md](./DEBUGGING.md) §OpenTelemetry.

---

## TUI quick reference

### 41. Open the command palette

**When:** you want to discover or quickly invoke any of the 21 slash commands from anywhere in the TUI.

**Run:**

Press `Ctrl+K` from any screen.

**You'll see:**

```
┌─ Commands ──────────────────────────────────────────────┐
│ > _                                                      │
│   /approve              Approve current gate             │
│   /clarify              Force a clarification pass       │
│   /mode                 Change workflow mode             │
│   /revise-spec          Rewind to spec with comment      │
│   …                                                      │
└──────────────────────────────────────────────────────────┘
```

Start typing to fuzzy-filter the list. Press Enter on the highlighted entry to invoke. Press Escape to dismiss without invoking.

**Notes:**
- The palette is disabled while another overlay (help, settings, skills) is active.
- Commands whose `validScreens` excludes your current screen are hidden from the list.
- `Ctrl+K` is handled by `src/hooks/use-app-keys.ts:82`.

**See also:** [docs/SLASH-COMMANDS.md](./SLASH-COMMANDS.md).

---

### 42. Confirm a destructive action (confirm tier)

**When:** an implementer action is classified as `destructive` (e.g. `rm`, `drop table`) and the `approval.tiers.destructive` is set to `confirm`.

**You'll see:**

```
┌─────────────────────────────────────────────────────────┐
│ [!] Destructive action: remove legacy migration files   │
│     Type "I confirm" to proceed, or press Escape to     │
│     cancel.                                             │
│     Phrase: _                                           │
└─────────────────────────────────────────────────────────┘
```

**Steps:**
1. Type the literal string `I confirm` (capital I, space, lowercase confirm) and press Enter.
2. The prompt advances to the reason step:

```
│     Phrase accepted. Enter reason:                      │
│     Reason: _                                           │
```

3. Type a non-empty reason (e.g. `files superseded by new schema`) and press Enter.

**Rejection cases:**
- Wrong phrase → `Incorrect phrase. Try again.` — input cleared, try again.
- Empty reason → no action taken, cursor stays in reason field.
- Escape at either step → action denied (`user_cancelled`).

**Notes:**
- Confirm-tier approvals are one-shot and are NOT persisted to `.diptych/approvals.json`.
- Only `sticky`-tier grants are saved to `approvals.json`.

**See also:** [docs/CONFIG.md](./CONFIG.md) §approval.tiers, recipe 14.

---

### 43. Adapt the plan from a rejection

**When:** the implementer proposed an action you rejected, and you want the planner to take that rejection into account on the next run.

**Setup (`.diptych/config.yaml`):**

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
plan_done · 3 tasks  ← T002 now avoids the rejected path
```

**Variations:** Set `approval.feedRejectionsToPlanner: false` to keep rejections out of planner context (useful when you want to deny an action once without influencing the plan).

**See also:** [docs/CONFIG.md](./CONFIG.md) §approval, [docs/SLASH-COMMANDS.md](./SLASH-COMMANDS.md) `/revise-plan`.

---

## See also

- [docs/WORKFLOW.md](./WORKFLOW.md) — phase machine, modes, abort/queue/continue.
- [docs/CONFIG.md](./CONFIG.md) — every config field with type, default, description.
- [docs/SLASH-COMMANDS.md](./SLASH-COMMANDS.md) — full reference for the 21 runtime slash commands.
- [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, payloads, security model.
- [docs/ARCHITECTURE.md](./ARCHITECTURE.md) — canonical inventory of CLI commands, runners, sinks, paths.
- [docs/DEBUGGING.md](./DEBUGGING.md) — JSONL inspection, headless mode, OTel console exporter.
- [docs/WORKTREES.md](./WORKTREES.md) — what worktrees do and don't isolate.
- [docs/OTEL.md](./OTEL.md) — span hierarchy, exporter setup, dual-resolution caveat.
- [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief schema, drift-report rules, evidence vocabulary.
