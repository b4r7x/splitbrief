# Brief 09 — Task JSON contract documentation

> **STATUS: ✅ ALREADY IMPLEMENTED — SKIP THIS BRIEF.**
>
> `docs/TASK-CONTRACT.md` already exists with the correct schema matching `src/core/schemas/task.ts`. JSDoc on `task.ts` is already in place. The implementer should verify the file exists and move on.
>
> **WARNING:** The task schema shown below in this brief is STALE and WRONG. It shows fields (`acceptanceCriteria`, `attempt`, `error`, `escalatedAt`, `completedAt`) that do not exist on the real `Task` type. The actual schema has: `description`, `dependsOn`, `tests`, `constraints`, `implementationSteps`, `typeDefs`, `signature?`, `currentCode?`, `pattern?`. See `docs/TASK-CONTRACT.md` on disk for the correct schema.
>
> **You are a fresh AI context.** Do NOT commit (see `../../../../CLAUDE.md`).

## Goal (ALREADY ACHIEVED)

Document the stable JSON shape of the `Task` type so external tooling (Kanban viewers, Jira exporters, report generators) can consume `state.json` reliably. No code change beyond JSDoc. Add `docs/TASK-CONTRACT.md`.

## Dependencies

- None.

## Files to touch

Write-authoritative:

- `docs/TASK-CONTRACT.md` (NEW)
- `src/core/schemas/task.ts` (JSDoc only)

## Step-by-step

### 1. Read the current Task schema

File: `src/core/schemas/task.ts`

Read the schema. Record every field, every status value, every type. If anything is unclear (e.g., the meaning of `action: 'modify' | 'create'`), grep for usages and document from code.

### 2. Write the contract doc

File: `docs/TASK-CONTRACT.md`

```md
# Task Contract

> **Status:** stable as of diptych v0.7 (config v3).
> **Audience:** external tool authors reading `state.json` to render Kanban boards, export to Jira/Linear/GitHub Issues, generate reports, or drive custom UIs.

## Where tasks live on disk

`state.json` at `.diptych/sessions/<id>/state.json`. Tasks are at `state.tasks: Task[]`. Current task index at `state.currentTaskIndex: number`.

Also: `tasks.md` is a human-readable rendering of the same content. The JSON is the source of truth; the markdown is generated.

## Task shape

\`\`\`ts
type Task = {
  id: TaskId;                // branded string, e.g. "T-001"
  title: string;             // short human label
  file: string;              // project-relative path (e.g. "src/foo.ts")
  action: 'create' | 'modify';
  acceptanceCriteria: string[];
  status: TaskStatus;
  attempt?: number;          // retry counter, 0..maxRetries
  error?: string;            // last validation error, if any
  escalatedAt?: number;      // epoch ms when escalation started, if applicable
  completedAt?: number;      // epoch ms when status hit done/failed/escalated
};
\`\`\`

### `TaskId`

A branded string. Format: `T-NNN` where `NNN` is zero-padded sequential starting at `001`. IDs are stable across retries and reorderings. IDs are never reused within a session.

### `TaskStatus`

\`\`\`ts
type TaskStatus =
  | 'pending'        // not yet attempted
  | 'in_progress'    // implementer is generating code
  | 'done'           // validation passed
  | 'escalated'      // full escalation path succeeded
  | 'failed'         // all retry / escalation tiers exhausted
  | 'skipped';       // user skipped via /redo-task or programmatic skip
\`\`\`

Transitions (simplified; full state-machine in `src/core/state/machine.ts`):

\`\`\`
pending --[START_TASK]--> in_progress
in_progress --[VALIDATION_PASS]--> done
in_progress --[VALIDATION_FAIL (attempt < max)]--> in_progress  (attempt++)
in_progress --[VALIDATION_FAIL (attempt ≥ max)]--> escalated or failed (see escalation tiers)
any --[SKIP_TASK]--> skipped
any --[RESET_TASK]--> pending
\`\`\`

### Lifecycle guarantees

- **ID stability**: a task's `id` never changes once assigned. Subsequent regenerations keep the same ID if the title/file match, or drop the old ID and emit a fresh one.
- **Monotonic timestamps**: `completedAt` is always ≥ `escalatedAt` ≥ session start time.
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
| `acceptanceCriteria` | Description bullets |
| `status` | Workflow state (mapped per project) |
| `file` | Custom field "Affected file" |
| `action` | Custom field "Change type" |
| `error` | Comment (if present and terminal state) |

### Polling cadence

`state.json` is rewritten on every phase transition and every task status change. Polling at 500 ms is safe. File writes are atomic (write-then-rename). Readers should tolerate a momentary `ENOENT` between rename ticks on macOS — retry with a 50 ms backoff.

## External metadata (side-channel)

External tools may attach their own metadata in `state.external` under a namespaced key. diptych does NOT read, validate, or serialize these fields — they are passthrough.

\`\`\`json
{
  "tasks": [...],
  "external": {
    "my-kanban": { "lanes": { "T-001": "in-review" } }
  }
}
\`\`\`

Guarantees:

- diptych preserves `state.external` on round-trip read/write.
- diptych never inspects the contents of `state.external`.
- External keys should be URL-slug-safe identifiers. `diptych.*` is reserved.

If two tools need to coordinate, they agree on a key (e.g., `external.vcs-sync`). diptych takes no position.

## Breaking-change policy

- **Non-breaking changes** (new optional fields, new status values that are ignored by old consumers) can happen in any minor release.
- **Breaking changes** (field rename, status removal, type change) trigger a `stateVersion` bump. Consumers should check `state.stateVersion` and refuse to read unfamiliar versions.
- The current `stateVersion` is `1`. It has not changed since diptych v0.1. Future bumps are documented in `CHANGELOG.md`.

## What is NOT stable

- `summary.json` shape — still evolving.
- `session.jsonl` event variants — we add new types regularly; consumers MUST tolerate unknown `type` values.
- `tasks.md` markdown structure — render format; use `state.json` for machine consumption.
- Internal plan / spec artifact formats — change based on prompt evolution.

## Example task entry

\`\`\`json
{
  "id": "T-003",
  "title": "Add email validation to SignupForm",
  "file": "src/features/auth/SignupForm.tsx",
  "action": "modify",
  "acceptanceCriteria": [
    "trims whitespace before validation",
    "rejects missing @ sign",
    "rejects more than one @ sign"
  ],
  "status": "done",
  "attempt": 1,
  "completedAt": 1744041600000
}
\`\`\`

## Verifying against a real session

\`\`\`bash
# Pick a session
session=$(ls -t .diptych/sessions/ | head -1)
cat .diptych/sessions/$session/state.json | jq '.tasks[0]'
\`\`\`

The output must match the shape above.

## See also

- `src/core/schemas/task.ts` — authoritative Zod schema.
- `src/core/types/state-actions.ts` — state-machine actions that mutate tasks.
- `docs/WORKFLOW.md` §1.1 — full phase-transition table.
- `docs/CONCEPTS.md` — session folder structure.
```

### 3. JSDoc on the schema

File: `src/core/schemas/task.ts`

Add a top-of-file comment block:

```ts
/**
 * Task schema.
 *
 * This shape is documented as a **stable contract** in `docs/TASK-CONTRACT.md`.
 * External tools (Kanban viewers, Jira exporters, custom UIs) rely on it.
 * Breaking changes require a `stateVersion` bump.
 *
 * When adding fields: prefer optional fields so old consumers keep working.
 * When renaming or changing types: bump `stateVersion` in `src/core/schemas/state.ts`
 * and add a migration entry to `CHANGELOG.md`.
 *
 * @see docs/TASK-CONTRACT.md
 */
```

Add JSDoc on each field in the schema, cross-referencing the contract doc.

### 4. Verification

```bash
# Markdown link check (if the project has a tool).
# Otherwise visual inspection.
cat docs/TASK-CONTRACT.md | head -40
```

Typecheck + lint + test (nothing should fail because only JSDoc changed):

```bash
npm run test-ci
```

## Rollback

Delete `docs/TASK-CONTRACT.md`. Remove JSDoc additions.

## Checkpoint

- `docs/TASK-CONTRACT.md` exists.
- JSDoc on `src/core/schemas/task.ts` points to the contract.
- No code behaviour change.
