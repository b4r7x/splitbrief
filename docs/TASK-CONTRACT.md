# Task Contract

> **Status:** stable as of diptych v0.7 (config v3).
> **Audience:** external tool authors reading `state.json` to render Kanban boards, export to Jira/Linear/GitHub Issues, generate reports, or drive custom UIs.

## Task Brief v1: the semantic contract

A `Task` is the persisted, transport-stable form of a **Product Task Brief v1** — the durable contract the planner writes for the implementer. The brief is the meaning; `tasks.md` is the markdown rendering used to hand work between phases; `state.json` is the stable external JSON that downstream tools consume.

Every Task Brief v1 covers nine semantic sections, even when a section is brief. Each section maps onto existing `Task` schema fields so external tools do not need a new shape:

| # | Brief section | Schema fields | Notes |
|---|---|---|---|
| 1 | **Identity** | `id`, `title`, `file`, `action` | Stable identity for the task. |
| 2 | **Intent** | `description` | What change is needed and why it matters. |
| 3 | **Scope** | `description`, `constraints`, optional `scope.inBounds` / `scope.outOfBounds` | What is in bounds and what is out of bounds. |
| 4 | **Code Context** | `signature`, `currentCode`, `typeDefs`, `pattern` | Existing code, signatures, types, or patterns the implementer needs. |
| 5 | **Implementation Plan** | `implementationSteps` | Ordered steps for the change. |
| 6 | **Validation** | `tests` | Concrete checks, tests, or assertions that define success. |
| 7 | **Constraints** | `constraints` | Invariants, dependencies, refusal conditions. |
| 8 | **Escalation** | optional `escalation` | When the implementer must stop and ask instead of guessing. |
| 9 | **Evidence** | optional `evidence` | Final reviewable proof preserved after the task completes. |

`tasks.md` is the markdown transport: one task block per brief, frontmatter for identity and dependencies, `### …` headings for each semantic section. The implementer prompt may reformat a brief but must not change its meaning. `state.json` is the stable external JSON; consume that for machine-readable workflows.

## Where tasks live on disk

`state.json` at `.diptych/sessions/<id>/state.json`. Tasks are at `state.tasks: Task[]`. Current task index at `state.currentTaskIndex: number`. Current retry count at `state.attempt: number`.

## Task shape

```ts
type Task = {
  id: TaskId;                        // branded string, e.g. "T001"
  title: string;                     // short human label
  file: string;                      // project-relative path (e.g. "src/foo.ts")
  action: 'create' | 'modify';
  description: string;               // full task description
  dependsOn: TaskId[];               // IDs of tasks that must complete first
  tests: string[];                   // test cases / acceptance criteria
  constraints: string[];             // additional constraints or requirements
  implementationSteps: string[];     // step-by-step guide for the implementer
  typeDefs: string;                  // TypeScript type definitions / signatures
  signature?: string;                // optional: function/interface signature hint
  currentCode?: string;              // optional: captured existing code at task start
  pattern?: string;                  // optional: code pattern hint
  scope?: {                          // optional: Task Brief v1 §Scope
    inBounds?: string[];
    outOfBounds?: string[];
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
  | 'skipped';       // user skipped via /skip-task or programmatic skip
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

## Consumer examples

### Kanban (read-only)

Watch `.diptych/sessions/<id>/state.json` for changes. Group tasks by status:

- **Backlog**: `status === 'pending'`
- **In progress**: `status === 'in_progress'`
- **Done**: `status === 'done' || status === 'escalated'`
- **Failed**: `status === 'failed'`
- **Skipped**: `status === 'skipped'`

The current task (the one the implementer is working on right now) is `tasks[state.currentTaskIndex]`.

### Jira / Linear export

Recommended mapping:

| Task field | Jira / Linear field |
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

External tools may attach their own metadata in `state.external` under a namespaced key. diptych does NOT read, validate, or serialize these fields — they are passthrough.

```json
{
  "tasks": [...],
  "external": {
    "my-kanban": { "lanes": { "T001": "in-review" } }
  }
}
```

Guarantees:

- diptych preserves `state.external` on round-trip read/write.
- diptych never inspects the contents of `state.external`.
- External keys should be URL-slug-safe identifiers. `diptych.*` is reserved.

If two tools need to coordinate, they agree on a key (e.g., `external.vcs-sync`). diptych takes no position.

## Breaking-change policy

- **Non-breaking changes** (new optional fields, new status values that are ignored by old consumers) can happen in any minor release.
- **Breaking changes** (field rename, status removal, type change) trigger a `stateVersion` bump. Consumers should check `state.stateVersion` and refuse to read unfamiliar versions.
- The current `stateVersion` is `3`. Future bumps are documented in `CHANGELOG.md`.

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
session=$(ls -t .diptych/sessions/ | head -1)
cat .diptych/sessions/$session/state.json | jq '.tasks[0]'
```

The output must match the shape above.

## See also

- `src/core/schemas/task.ts` — authoritative Zod schema.
- `src/core/types/state-actions.ts` — state-machine actions that mutate tasks.
- `docs/WORKFLOW.md` §1.1 — full phase-transition table.
- `docs/CONCEPTS.md` — session folder structure.
