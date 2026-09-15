# Task Contract

> **Status:** stable (state/config v4).
> **Audience:** implementer runners, reviewers, and advanced read-only integrations inspecting Task Brief state.

## v4 contract boundary

`state.json` is a versioned contract. The current persisted `stateVersion` is
`4`, and `stateRevision` identifies the state head. Only the
state-operations/controller path may mutate it. Every mutation rebases complete
state, supplies the expected revision, and refuses a stale, future, or
malformed write. All modes (`quick`, `standard`, and `speckit`) and all callers
(TUI and headless) consume the same v4 projection and command policy. Read-only
integrations may observe state but never promote a local migration, retry a
provider, or bypass the revision check. The keys `stateFence`,
`authorityRevision`, `generation`, `permit`, `briefRecovery` and
`budgetPauseAcknowledgedAtCost` are legacy (`LEGACY_STATE_KEYS`,
`src/core/schemas/workflow.ts`): a loaded state that still carries them has them
stripped, so a state written before those subsystems were removed still loads.
The version number itself has one home, `WORKFLOW_STATE_VERSION`; no reader and
no writer spells `4`.

A Task Brief may enter implementation only when the current deterministic Brief Quality report has zero errors.
Warnings remain non-blocking, and an invalid brief must never be advanced through an approval override.
The report is written to the session folder as `brief-quality.json`.

## Task Brief v1: the semantic contract

A `Task` is the persisted, transport-stable form of a **Product Task Brief v1** — the durable contract the planner writes for the implementer. The brief is the meaning; `tasks.md` is the markdown rendering used to hand work between phases; `state.json` is the stable JSON that SPLITBRIEF and advanced read-only integrations consume.

Every Task Brief v1 covers nine semantic sections, even when a section is brief. Each section maps onto existing `Task` schema fields so external tools do not need a new shape:

| # | Brief section | Schema fields | Notes |
|---|---|---|---|
| 1 | **Identity** | `id`, `title`, `file`, `files`, `action` | Stable identity for the task. `files` is the slice the brief writes; `file` is its anchor and must be a member of `files`. When `files` is absent it resolves to `[file]`. |
| 2 | **Intent** | `description` | What change is needed and why it matters. |
| 3 | **Scope** | `description`, `constraints`, optional `scope.inBounds` / `scope.outOfBounds` | What is in bounds and what is out of bounds. |
| 4 | **Code Context** | `signature`, `currentCode`, `typeDefs`, `pattern` | Existing code, signatures, types, or patterns the implementer needs. |
| 5 | **Implementation Plan** | `implementationSteps` | Ordered steps for the change. |
| 6 | **Validation** | `tests` | Concrete checks, tests, or assertions that define success. |
| 7 | **Constraints** | `constraints` | Invariants, dependencies, refusal conditions. |
| 8 | **Escalation** | optional `escalation` | When the implementer must stop and ask instead of guessing. |
| 9 | **Evidence** | optional `evidence` | Final reviewable proof preserved after the task completes. |

`tasks.md` is the markdown transport: one task block per brief, frontmatter for identity and dependencies, `### …` headings for each semantic section. The implementer prompt may reformat a brief but must not change its meaning. `state.json` is the stable external JSON; consume that for machine-readable read-only workflows.

**How the Scope section is interpreted.** Scope bullets are prose, not a file list. A brief's **declared set** is `files` plus every `scope.inBounds` and `scope.approvedOutOfBounds` bullet, and one module resolves it for every consumer — `taskDeclaredPatterns` / `isInDeclaredSet` in `src/core/scope/declared-set.ts`. When deciding whether a brief widens the write scope beyond its `files`, SPLITBRIEF extracts path tokens from each `scope.inBounds` / `scope.approvedOutOfBounds` bullet (`scopePathPatterns` in `src/utils/path-patterns.ts`): backtick-quoted tokens first, then — when the bullet has no backticks — the whole bullet if it contains no whitespace, otherwise concrete path patterns matched out of the prose. A token only counts as a path when it carries a directory separator or a glob; a bare filename with no directory cannot denote a file other than one of the task's own `files` in any recorded plan, so it never widens the write scope. A bullet that names a file the brief already declares does not widen it either.

**Create-then-modify chains are legal.** A brief may declare `action: modify` on a file an earlier brief in the same plan creates. Because the task loop runs in array order, the routing preview reports such a target as `pending-earlier-task` rather than `missing-current-code`: the file is expected to exist by the time the modifying task runs, and the missing current code is a non-event, not a stale estimate.

**What a direct-write implementer is told about scope and stopping.** Beyond the brief itself, a `direct` implementer receives a system preamble (`src/engine/spec/prompts/system.ts`) that restates the contract as hard rules: edit only the files the brief lists under Files, plus every path its Scope names under In bounds or Approved out of bounds, and nothing else; stop and report instead of guessing when the brief's stop conditions are met, when a declared file's current content contradicts the brief, or when the change would require touching a file outside scope; run the brief's validation commands when available and report any failure SPLITBRIEF will re-verify after promotion rather than working around it; and end with a completion report naming the files written and whether the steps were completed. The same rules are mirrored in the task's closing instruction (`src/engine/spec/prompt-formatter.ts`).

## Where tasks live on disk

`state.json` at `.splitbrief/sessions/<id>/state.json`. Tasks are at `state.tasks: Task[]`. Current task index at `state.currentTaskIndex: number`. Current retry count at `state.attempt: number`.

## Task shape

```ts
type Task = {
  id: TaskId;                        // branded string, e.g. "T001"
  title: string;                     // short human label
  file: string;                      // project-relative anchor path (e.g. "src/foo.ts")
  files?: string[];                  // optional: the whole slice; defaults to [file], and file is a member
  action: 'create' | 'modify';
  description: string;               // full task description
  dependsOn: TaskId[];               // IDs of tasks that must complete first
  tests: string[];                   // test cases / acceptance criteria
  constraints: string[];             // additional constraints or requirements
  implementationSteps: string[];     // step-by-step guide for the implementer
  typeDefs: string;                  // language-specific type declarations / signatures
  signature?: string;                // optional: function/interface signature hint
  currentCode?: string;              // optional: captured existing code of the anchor at task start
  currentCodeByFile?: Record<string, string>;  // optional: captured existing code of the non-anchor files
  pattern?: string;                  // optional: code pattern hint
  scope?: {                          // optional: Task Brief v1 §Scope
    inBounds?: string[];
    outOfBounds?: string[];
    approvedOutOfBounds?: string[];
  };
  escalation?: string[];             // optional: Task Brief v1 §Escalation
  evidence?: string[];               // optional: Task Brief v1 §Evidence
  status: TaskStatus;
};
```

### `TaskId`

A branded string. Format: `TNNN` where `NNN` is zero-padded sequential starting at `001`. IDs are stable across retries and reorderings. IDs are never reused within a session.

### `TaskStatus`

```ts
type TaskStatus =
  | 'pending'        // not yet attempted
  | 'in_progress'    // implementer is generating code
  | 'done'           // validation passed
  | 'escalated'      // full escalation path succeeded
  | 'failed'         // all retry / escalation tiers exhausted
  | 'skipped';       // task denied by a pre_task hook or programmatic skip
```

Transitions (simplified; full state-machine in `src/core/state/machine.ts`):

```
pending --[START_TASK]--> in_progress
in_progress --[VALIDATION_PASS]--> done
in_progress --[VALIDATION_FAIL (attempt < maxRetries)]--> in_progress  (state.attempt++)
in_progress --[VALIDATION_FAIL (attempt ≥ maxRetries)]--> escalated or failed (see escalation tiers)
any --[SKIP_TASK]--> skipped
any --[RESET_TASK]--> pending
```

The retry counter lives at **`state.attempt`** (top-level on `WorkflowState`), not on the individual task.

### Lifecycle guarantees

- **ID stability**: a task's `id` never changes once assigned. Subsequent regenerations keep the same ID if the title/file match, or drop the old ID and emit a fresh one.
- **Terminal states**: `done | escalated | failed | skipped` — once set, the status does not move backwards within a session. `RESET_TASK` explicitly transitions to `pending` and is the only way out of a terminal state.

## Advanced read-only consumer examples

These examples are side-channel integrations: read-only consumers of session state. They must not mutate the Task Brief contract while a run is active.

### Status board (read-only)

Watch `.splitbrief/sessions/<id>/state.json` for changes. Group tasks by status:

- **Backlog**: `status === 'pending'`
- **In progress**: `status === 'in_progress'`
- **Done**: `status === 'done' || status === 'escalated'`
- **Failed**: `status === 'failed'`
- **Skipped**: `status === 'skipped'`

The current task (the one the implementer is working on right now) is `tasks[state.currentTaskIndex]`.

### Issue tracker export

Recommended mapping:

| Task field | Issue tracker field |
|---|---|
| `id` | External key (prefix with session id: `<session>-<id>`) |
| `title` | Summary / Title |
| `description` | Description (prose) |
| `tests` | Acceptance criteria bullets |
| `constraints` | Additional requirements bullets |
| `status` | Workflow state (mapped per project) |
| `file` | Custom field "Affected file" |
| `action` | Custom field "Change type" |
| `dependsOn` | Issue links (blocked-by) |

### Polling cadence

`state.json` is rewritten on every phase transition and every task status change. Polling at 500 ms is safe. File writes are atomic (write-then-rename). Readers should tolerate a momentary `ENOENT` between rename ticks on macOS — retry with a 50 ms backoff.

## External metadata (side-channel)

External tools may attach their own metadata in `state.external` under a namespaced key. SPLITBRIEF does not read or validate these fields — they are opaque passthrough metadata.

```json
{
  "tasks": [...],
  "external": {
    "my-board": { "lanes": { "T001": "in-review" } }
  }
}
```

Guarantees:

- SPLITBRIEF preserves `state.external` on round-trip read/write.
- SPLITBRIEF never inspects the contents of `state.external`.
- External keys should be URL-slug-safe identifiers. `splitbrief.*` is reserved.

If two tools need to coordinate, they agree on a key (e.g., `external.vcs-sync`). SPLITBRIEF takes no position.

## Breaking-change policy

- **Non-breaking changes** (new optional fields, new status values that are ignored by old consumers) can happen in any minor release.
- **Breaking changes** (field rename, status removal, type change) trigger a `stateVersion` bump. Consumers should check `state.stateVersion` and refuse to read unfamiliar versions.
- The current persisted `stateVersion` is `4`. A v3 state is promoted only by the fenced owner during resume; malformed or future state is refusal/read-only state. Future bumps are documented in `CHANGELOG.md`.

**v4 additive fields (2026-09-13).** These fields were added without a `stateVersion` bump; each is optional, and a state written before them reads identically:

| Field | Meaning when absent |
|---|---|
| `Task.files` | the slice is `[task.file]` |
| `Task.currentCodeByFile` | only the anchor's `currentCode` was captured |
| `WorkflowState.reviewFixes` | no review fix cycle has run |
| `WorkflowState.reviewStatus` | the final review has not resolved |
| `WorkflowState.validationBaseline` | the run-start gate probe is re-run on resume instead of reused |
| `WorkflowState.interruptedStep` | nothing recorded where the run was cut; `cut` says which — `mid-step` inside a call, `boundary` between two briefs — and a record written before `cut` existed falls back to the presence of a `partialRef` |
| `WorkflowState.closed` | the run was never explicitly ended, so it is still continuable |
| `WorkflowState.lastFailure` | the run recorded no failure; it stopped for some other reason |
| evidence `skipped` / `skippedReason` | the stage ran (a skipped stage was previously indistinguishable from a pass) |

**`Session.status` (2026-09-15).** The session record's status is now `open` \| `complete` \| `ended`, derived from the state by `deriveRunStatus` rather than from the exit path the run happened to take. The legacy literals `interrupted`, `failed` and `cancelled` still parse: they map to `open`, and `failed` additionally sets `stop: 'failed'`. The row also carries optional `phase`, `mode` and `stop` (`paused` \| `waiting` \| `halted` \| `failed` \| `interrupted`); an absent `stop` on an open row means the run is still going.

## What is NOT stable

- `summary.json` shape — still evolving.
- `session.jsonl` event variants — we add new types regularly; consumers MUST tolerate unknown `type` values.
- `tasks.md` markdown structure — transport format; use `state.json` for machine consumption.
- Internal plan / spec artifact formats — change based on prompt evolution.
- `state.messageQueue` entries — internal coordination; structure may change.

## Example task entry

```json
{
  "id": "T003",
  "title": "Add email validation to SignupForm",
  "file": "src/features/auth/SignupForm.tsx",
  "action": "modify",
  "description": "Validate the email field in the signup form before submission.",
  "dependsOn": [],
  "tests": [
    "trims whitespace before validation",
    "rejects missing @ sign",
    "rejects more than one @ sign"
  ],
  "constraints": [
    "must not introduce a new dependency",
    "existing tests must continue to pass"
  ],
  "implementationSteps": [
    "Add a validateEmail helper in src/utils/validate.ts",
    "Call it from SignupForm's onSubmit handler",
    "Display an inline error message on failure"
  ],
  "typeDefs": "function validateEmail(value: string): string | null",
  "status": "done"
}
```

## Verifying against a real session

```bash
# Pick a session
session=$(ls -t .splitbrief/sessions/ | head -1)
cat .splitbrief/sessions/$session/state.json | jq '.tasks[0]'
```

The output must match the shape above.

## See also

- `src/core/schemas/task.ts` — authoritative Zod schema.
- `src/core/state/types.ts` — state-machine actions that mutate tasks.
- `docs/WORKFLOW.md` §1.1 — full phase-transition table.
- `docs/CONCEPTS.md` — session folder structure.

## Brief quality gate

After each planning phase produces its Task Brief, the orchestrator runs a quality gate before transitioning to `implementing`. The gate is implemented in `src/engine/spec/brief-quality.ts` and produces `brief-quality.json` in the session directory. The gate is a binary contract decision; its score and issue list are diagnostic evidence only.

### Errors (gate blocks when any error is present)

| Code | Condition |
|---|---|
| `missing_validation` | `task.tests` is empty |
| `empty_task_list` | The planner returned zero parseable Task Briefs |
| `vague_validation` | every test matches a known vague pattern ("works", "validate", …) |
| `missing_implementation_steps` | `task.implementationSteps` is empty |
| `write_outside_declared_files` | description/steps direct a write to a path outside the brief's declared set |
| `anchor_not_in_files` | `files` is present and `file` is not one of its entries |
| `missing_code_context` | `action === 'modify'` with no `currentCode`, `signature`, or `pattern` |
| `missing_escalation` | description/steps contain risk keywords (auth, token, secret, …) and `escalation` is absent |
| `missing_scope` | `task.scope` absent or empty |
| `missing_evidence` | `task.evidence` absent or empty |

### Warnings (reported but do not block)

| Code | Condition |
|---|---|
| `missing_type_definitions` | `task.typeDefs` is empty |
| `test_without_code` | the brief only creates a test for a sibling another brief creates; fold it into that brief's slice |

`write_outside_declared_files` counts write targets, not mentions: a path governed by a write verb ("update `src/api.ts`", "create `src/utils/helpers.ts`") that the declared set does not cover. Referenced paths do not count: a pattern exemplar to follow, an import or type source ("importing `titleCase` from `src/text.ts`"), a negated verb ("do not modify `src/slug.ts`"), or a bare mention. A brief whose steps write three paths, all of them listed under `files`, produces no error — the slice is the unit, not the file.

### Artifact

`brief-quality.json` shape (written with mode 0o600):

```json
{
  "version": 1,
  "passed": true,
  "score": 0.85,
  "issues": [
    { "taskId": "T001", "severity": "warning", "code": "missing_scope", "message": "..." }
  ]
}
```

`score` ranges from 0–1: `1 - (errorCount × 0.2) - (warningCount × 0.05)`, clamped to `[0, 1]`. A score never authorizes a quality override: any error keeps the brief out of implementation.

## Evidence ledger

Every run writes a per-session evidence ledger to `.splitbrief/sessions/<id>/evidence.json`
(constant `EVIDENCE_FILE`, file mode `0o600`). The ledger is the durable record
of what each task was supposed to prove and what was actually observed. It is
written incrementally as tasks reach a terminal state and amended once the
final review completes.

### Shape

```ts
type EvidenceLedger = {
  version: 1;
  sessionId: string;
  feature: string;
  mode?: 'quick' | 'standard' | 'speckit';
  generatedAt: string;
  tasks: Array<{
    id: string;
    title: string;
    file: string;
    status: 'pending' | 'in_progress' | 'done' | 'escalated' | 'failed' | 'skipped';
    method?: 'local' | 'escalated-hint' | 'escalated-intermediate' | 'escalated-full' | 'failed' | 'skipped';
    retries: number;
    durationMs?: number;
    changedFiles: string[];
    validation: Array<{ stage: 'typecheck' | 'lint' | 'test'; passed: boolean;
                        skipped?: boolean; skippedReason?: string; errorSummary?: string }>;
    expectedEvidence: string[];   // task.evidence ++ task.tests
    observedEvidence: string[];   // produced by orchestrator
    escalated: boolean;
    briefHash?: string | null;  // absent on sessions written before this spec; readers must treat absent and `null` identically.
  }>;
  validationSummary: { passed: number; failed: number; skipped: number; escalated: number };
  finalReview?: { path: string; status: 'written' | 'failed' | 'skipped' };
  briefHash?: string | null;  // absent on sessions written before this spec; readers must treat absent and `null` identically.
};
```

### Observed evidence vocabulary

Strings appended to `observedEvidence` are stable. UI and tests may match on them.

| String | When it is appended |
|---|---|
| `task reached done` | Task transitions to `done` (local implementation or escalation success) |
| `task reached escalated` | Task transitions to `escalated` |
| `typecheck passed` / `lint passed` / `test passed` | Validation stage reported `passed: true` |
| `diff written for <file>` | Task produced exactly one changed file |
| `diff written for <n> files` | Task produced more than one changed file |
| `<stage> skipped` / `<stage> skipped (<reason>)` | The stage resolved to no command; it is recorded as skipped, never as passed |
| `final review written` | Final review succeeded; appended to every completed task |
| `skipped: <reason>` | `pre_task` hook denied the task |
| `skipped: dependency failed: ...` | `handleSkippedTask(...)` skipped the task because a dependency was already failed or skipped |

### Summary rollup

`Summary.evidenceSummary` (optional, additive) carries a compact rollup so the
closed run can render counts without re-reading the ledger:

```ts
{
  path: 'evidence.json',
  totalTasks: number,
  tasksWithValidationEvidence: number,
  escalatedTasks: number,
  failedTasks: number,
}
```

The full ledger is read directly from disk by UI that needs per-task detail.


## Deterministic drift report

Before the final review runs, the orchestrator computes a deterministic
drift report comparing the Task Brief against the actual git diff and the
evidence ledger. The report is persisted as `drift-report.json` in the session
directory and is also injected as a section into the final-review prompt.

### Shape

```ts
type DriftReport = {
  version: 1;
  passed: boolean;       // true when no error-severity findings
  score: number;         // 1 - 0.25*errors - 0.08*warnings, clamped to [0,1]
  changedFiles: string[];
  expectedFiles: string[];
  findings: Array<{
    severity: 'info' | 'warning' | 'error';
    code:
      | 'out_of_scope_file'
      | 'missing_expected_file'
      | 'orphan_diff'
      | 'out_of_bounds_text_match'
      | 'missing_evidence'
      | 'failed_task_with_diff';
    taskId?: string;
    file?: string;
    message: string;
  }>;
  briefHash?: string | null;  // absent on sessions written before this spec; readers must treat absent and `null` identically.
};
```

### Detection rules

| Code | Severity | Trigger |
|---|---|---|
| `out_of_scope_file` | error (info when the file was already changed before the run started) | Changed file is outside every brief's declared set. |
| `missing_expected_file` | warning | Task is `done` / `escalated` but its target file is not in the diff. |
| `failed_task_with_diff` | error | Task is `failed` but its target file appears in the diff. |
| `orphan_diff` | error | Diff contains files but every task is `failed` or `skipped`. |
| `out_of_bounds_text_match` | error | A `task.scope.outOfBounds` pattern matches a changed-file path or appears in the raw diff text. Match literally as a substring; do not use regex or semantic matching. |
| `missing_evidence` | warning | Task `done`/`escalated` declared expected evidence but the ledger observed none — or observed the test stage as `skipped`, which is absence of proof, not proof. |

### Event

The orchestrator publishes a `drift_report` event:

```ts
{ type: 'drift_report'; ts: number; phase: Phase; passed: boolean;
  score: number; errorCount: number; warningCount: number }
```
