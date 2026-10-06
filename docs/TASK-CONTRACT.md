# Task Contract

> **Status:** stable (state/config v4).
> **Audience:** implementer runners, reviewers, and advanced read-only integrations inspecting Task Brief state.

A brief that fails after its one retry, reports `blocked`, or is stale goes to the planner's consult, not to a fixed tier chain. The old `escalated-hint` / `escalated-intermediate` / `escalated-full` completion values and the old `escalate`, `hint_failed` and `task_scope_widened` events stay parseable so a saved `state.json` and `session.jsonl` still load; S9 removes those readers.

## v4 contract boundary

`state.json` is a versioned contract. The current persisted `stateVersion` is
`4`, and `stateRevision` identifies the state head. Only the
state-operations/controller path may mutate it. Every mutation rebases complete
state, supplies the expected revision, and refuses a stale, future, or
malformed write. All callers
(TUI and headless) consume the same v4 projection and command policy. Read-only
integrations may observe state but never promote a local migration, retry a
provider, or bypass the revision check. Queue reads keep unsaved workflow fields while the caller and disk share a committed revision. Once the disk revision advances, its workflow state wins, including rewinds and recovery; queue delivery state is merged separately. The keys `stateFence`,
`authorityRevision`, `generation`, `permit`, `briefRecovery` and
`budgetPauseAcknowledgedAtCost` are legacy (`LEGACY_STATE_KEYS`,
`src/core/schemas/workflow.ts`): a loaded state that still carries them has them
stripped, so a state written before those subsystems were removed still loads.
The version number itself has one home, `WORKFLOW_STATE_VERSION`; no reader and
no writer spells `4`.

A Task Brief may enter implementation only when the plan it was compiled from passed `checkPlan` and the context fit.
A plan that fails `checkPlan` never reaches the plan card, and an edited `plan.json` that fails its checks is not applied.
Approving the plan card never overrides a failed check.

## The plan contract

The planning session's answer is typed. Its schemas live in `src/core/schemas/plan.ts`; the checked plan is written to the session folder as `plan.json` (`PLAN_JSON_FILE`, `src/core/paths.ts`; read and written by `src/core/sessions/plan-file.ts`, whose reader validates with the schema). `plan.md` and `tasks.md` are renderings of it (`formatPlanMarkdown`, `formatTasks`). `stateVersion` did not change for the plan: `state.plan` is an optional field, and a state without it still parses.

**The answer.** The planner answers `{ result: PlanResult }` (`PlanAnswerSchema`). `PlanResult` is either `{ kind: 'questions', questions }` (1 to 3 questions, each `{ id, text, choices, default }`) or `{ kind: 'plan', summary, decisions, criteria, checks, validation, tasks }` (`PlanProposalSchema`). OpenAI strict mode takes only an object at the root, so the union travels under `result`, and every optional value is `nullable` with its key required. This differs from the type in the design note, which had optional keys and a bare union. `PLAN_ANSWER_JSON_SCHEMA` passes strict mode, so `claude-code`, `codex` and the `api` kind use their native schema flag.

| Plan field | Type | Meaning |
|---|---|---|
| `summary` | string | One paragraph the plan card shows first |
| `decisions` | string[] | Choices the planner made; `state.plan` stores the ledger as `{ text, taskId }` entries, and a plain string reads as `taskId: null` |
| `criteria` | `{ id, text, checkIds }[]` | Acceptance criteria, each served by named checks |
| `checks` | `{ id, kind: 'test' \| 'cmd' \| 'render', value, required }[]` | The checks the criteria and tasks name |
| `validation` | `{ language, typecheck, lint, test, testPattern }` or null | Becomes `state.discoveredValidation` (`typecheckCommand`, `lintCommand`, `testCommand`, `testPattern`, `language`) |
| `tasks` | `TaskSpec[]` | The tasks |

`state.plan` (`PlanSchema`) keeps the plan without its tasks; the tasks live in `state.tasks`.

**The decisions ledger.** An entry is `{ text, taskId }`. A plan's own decision carries `taskId: null`. When the implementer proposes a deviation in its report (`ImplementerReport.decisions`, `{ what, why }`), the planner confirms it with a decision-confirm before the attempt is validated (at most once per attempt, bounded by the brief's attempts, with no run counter; see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md)), and its `confirm` answer makes `CONFIRM_DECISIONS` append `{ text: '<what> — <why>', taskId }`, naming the task that reported it. The ledger reaches every later brief's read-only Plan context, every consult and the review; the planner confirms a change of how only when the accepted criteria stay intact, and the user decides any change to what is built.

**`TaskSpec`.**

| Field | Type | Maps to `Task` |
|---|---|---|
| `id` | `TNNN` | `id` |
| `title` | string | `title` |
| `intent` | string | `description` |
| `criteria` | string[] (criterion ids) | `criteria` |
| `checks` | `Check[]` | `checks`; `tests` = the values of the `test` checks; `evidence` = one line per check (`<id> <kind>[ (optional)]: <value>`) |
| `suggestedFiles` | string[], at least one | `suggestedFiles`; `files` = all of them; `file` = the first |
| `contextFiles` | string[] | `contextFiles` (read-only: never in `scope`, never a write target) |
| `exclusions` | string[] | `exclusions`; `scope.outOfBounds` |
| `protectedOperations` | `{ path, operation: 'write' }[]` or null | `protectedOperations` (absent when null) |
| `steps` | string[] or null | `implementationSteps` (empty when null); advisory — the implementer may reach the same accepted behaviour another way |
| `dependsOn` | `TNNN[]` | `dependsOn` |
| `batch` | integer ≥ 1 | `batch` |

`taskFromSpec` (`src/engine/spec/plan-tasks.ts`) fills every older required `Task` field from that table, so every engine path reads a plan task as a brief. `action` is `modify` when the first suggested file exists inside the project, otherwise `create`. `constraints` is empty and `typeDefs` is `''`. `taskFromSpec` throws when a task names no suggested file, so it runs only after the checks pass. `protectedOperations.operation` accepts only `write`, because the protected-path confirmation matches `write <path>`. The schema spells every `suggestedFiles`, `contextFiles` and `protectedOperations` path as the write gate names a changed file (`./src/a.ts` and `src/../src/a.ts` are `src/a.ts`), so every check and every engine path compares one spelling. A question's `default` is non-empty, and one of its `choices` when it has choices.

### Plan checks

`checkPlan(plan, projectDir, taskFits)` (`src/engine/spec/plan-checks.ts`) is pure. It returns `{ code, message }` errors, which go back to the planner for its one repair. The operator sees the messages only, never the codes.

| Code | Rule |
|---|---|
| `empty-plan` | The plan has at least one task and at least one criterion |
| `duplicate-task-id` | Task ids are unique |
| `duplicate-check-id` | Check ids are unique |
| `duplicate-criterion-id` | Criterion ids are unique |
| `criterion-without-check` | Every criterion names at least one check |
| `unknown-check` | A criterion names only checks the plan defines |
| `uncovered-criterion` | Every criterion is served by at least one task |
| `unknown-criterion` | A task names only criteria the plan defines |
| `task-without-check` | Every task carries at least one check |
| `path-outside-project` | No suggested or context file resolves outside the project; these paths come from the model |
| `path-not-file` | A suggested or context file that exists is a regular file, not a directory or a symlink (`lstat`); `estimatePlanContextFits` skips the same tasks (`pathsNotFiles`) |
| `missing-context-file` | A context file exists, or this task or an earlier listed task names it as a suggested file; a suggested file may not exist yet |
| `protected-path-not-file` | Each `protectedOperations` path is one exact file: no glob, no trailing `/`, not an existing directory, and spelled in the case the checkout spells it |
| `unprotected-operation` | Each `protectedOperations` path is a write the protected-path confirmation asks about (`protectedWriteClass`) |
| `unlisted-protected-operation` | Each suggested file whose write the protected-path confirmation asks about (`protectedWriteClass`) is listed in the task's `protectedOperations` |
| `unknown-dependency` | `dependsOn` names only tasks of the plan |
| `dependency-later-batch` | A task depends only on tasks in an earlier or the same batch |
| `batch-out-of-order` | The tasks are listed in batch order |
| `dependency-later-task` | A task in the same batch as its dependency is listed after it |
| `dependency-cycle` | The dependencies have no cycle (`topoSort`) |
| `context-overflow` | The task fits the implementer's context (`estimatePlanContextFits`, which refreshes each task's code and reuses the routing preview); the message names the task's context files and their sizes |
| `no-capable-worker` | Some implementer can take the task (credentials, write mode, single-file contract); the message carries the routing reason |
| `render-check-unconfigured` | Every render check of the plan needs `validation.render`; the plan goes back to the planner once with the reason, and when the planner keeps them the plan card opens with a "Before you approve" note naming them, since without the command the run halts before its review |

A task with no suggested file is refused by the schema, not by `checkPlan`. `checkFullPlan` (`src/engine/orchestrator/planning/session.ts`) runs `checkPlan` with the context fit; the session and the plan card's edit path both call it. The in-app editor's save check runs `checkPlan` without the context fit (`planSaveErrors`), and the engine checks the fit after the save.

## Task Brief v1: the semantic contract

A `Task` is the persisted, transport-stable form of a **Product Task Brief v1** — the durable contract the planner writes for the implementer. The brief is the meaning; `tasks.md` is the markdown rendering used to hand work between phases; `state.json` is the stable JSON that SPLITBRIEF and advanced read-only integrations consume.

A new run's planner does not write `tasks.md`: it answers a typed `TaskSpec` in `plan.json`, and `taskFromSpec` maps it onto these sections (see [The plan contract](#the-plan-contract)). `tasks.md` is rendered from the mapped tasks. The skills keep writing a Markdown brief rendered from the same `TaskSpec` fields.

Every Task Brief v1 covers nine semantic sections, even when a section is brief. Each section maps onto existing `Task` schema fields so external tools do not need a new shape:

| # | Brief section | Schema fields | Notes |
|---|---|---|---|
| 1 | **Identity** | `id`, `title`, `file`, `files`, `action` | Stable identity for the task. `files` is the slice the brief writes; `file` is its anchor and must be a member of `files`. When `files` is absent it resolves to `[file]`. |
| 2 | **Intent** | `description` | What change is needed and why it matters. |
| 3 | **Scope** | `description`, `constraints`, optional `scope.inBounds` / `scope.outOfBounds` | Guidance: `files` are the suggested files, **In bounds** is context, and **Out of bounds** lists the explicit exclusions the reviewer checks. |
| 4 | **Code Context** | `signature`, `currentCode`, `typeDefs`, `pattern` | Existing code, signatures, types, or patterns the implementer needs. |
| 5 | **Implementation Plan** | `implementationSteps` | Ordered steps for the change. |
| 6 | **Validation** | `tests` | Concrete checks, tests, or assertions that define success. |
| 7 | **Constraints** | `constraints` | Invariants, dependencies, refusal conditions. |
| 8 | **Escalation** | optional `escalation` | When the implementer must stop and ask instead of guessing. |
| 9 | **Evidence** | optional `evidence` | Final reviewable proof preserved after the task completes. |

`tasks.md` is the markdown transport: one task block per brief, frontmatter for identity and dependencies, `### …` headings for each semantic section. The parser also reads the planner spellings it meets: a `##` or `####` heading that names a section (numbered or bold), `**Label**:` scope labels, `*` or indented bullets (a nested bullet stays with its item), `1)` steps, or bulleted steps. The frontmatter reads `action` in any case, pads `T1` to `T001` in `id` and `depends_on`, and splits a `depends_on: T001, T002` string. Any other id is still rejected. The implementer prompt may reformat a brief but must not change its meaning. `state.json` is the stable external JSON; consume that for machine-readable read-only workflows.

**How the Scope section is interpreted.** Scope is guidance, not a fence. The brief's `files` are the suggested files, **In bounds** is context, and **Out of bounds** lists the explicit exclusions the reviewer checks. An implementer may edit another ordinary project file when the change needs it; SPLITBRIEF records it as touched, not suggested, runs its tests, and shows it to the reviewer. Only a protected path (dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`) asks the user (see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md)). A placeholder bullet — `None`, `None.`, `n/a` or `-` — is no entry at all: the parser drops it and `scopeEntryPatterns` licenses nothing for it (`isScopePlaceholder`). Scope bullets are prose, not a file list. A brief's **declared set** is `files` plus every `scope.inBounds` and `scope.approvedOutOfBounds` bullet, and one module resolves it for every consumer — `taskDeclaredPatterns` / `isInDeclaredSet` in `src/core/scope/declared-set.ts`. When deciding whether a brief widens the write scope beyond its `files`, SPLITBRIEF extracts path tokens from each `scope.inBounds` / `scope.approvedOutOfBounds` bullet (`scopePathPatterns` in `src/utils/path-patterns.ts`): backtick-quoted tokens first, then — when the bullet has no backticks — the whole bullet if it contains no whitespace, otherwise concrete path patterns matched out of the prose. A token only counts as a path when it carries a directory separator or a glob; a bare filename with no directory cannot denote a file other than one of the task's own `files` in any recorded plan, so it never widens the write scope. A bullet that names a file the brief already declares does not widen it either.

**Approved out of bounds is planner-authored.** The run no longer appends to it: the hint rung's `widen` verdict and `WIDEN_TASK_SCOPE` are gone. When the consult decides a brief's scope was wrong, it answers `rewrite-task` or `split-task` and the replacement carries the scope the planner wrote; the entry is then an ordinary Scope bullet, read by `scopePathPatterns` exactly as any other, so the declared set, the write gate, the classifier, the preamble and drift widen together. `scope.approvedOutOfBounds` is visible in `state.json` and in the brief as rendered; old `task_scope_widened` events stay replayable.

**Create-then-modify chains are legal.** A brief may declare `action: modify` on a file an earlier brief in the same plan creates. Because the task loop runs in array order, the routing preview reports such a target as `pending-earlier-task` rather than `missing-current-code`: the file is expected to exist by the time the modifying task runs, and the missing current code is a non-event, not a stale estimate.

**What a direct-write implementer is told about scope and stopping.** Beyond the brief itself, a `direct` implementer receives a system preamble (`src/engine/spec/prompts/system.ts`) that restates the contract as hard rules: read, search, write and run shell commands only inside the isolation directory, which it names by absolute path, and never look for other copies of the project; use git only to read (status, diff, log, show), because the worktree shares refs, stash, hooks and config with the user's repository; never run a package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun), because dependencies are already installed and the worktree's `node_modules` is a symlink into the real checkout; start from the files the brief suggests, edit another project file only when the change needs it and name it with the reason, and never edit dependency manifests, lockfiles, CI configuration, env or key files, `.git` or `.splitbrief` unless the brief asks for that operation; stop and report instead of guessing when the brief's stop conditions are met, or when a declared file's current content contradicts the brief; start editing from the brief and read a file only for lines the brief does not show; leave the typecheck, lint, format and test gates, the whole suite and render tools to SPLITBRIEF, and run at most the focused test files the brief lists, once; and end the reply with one `ImplementerReport` JSON object and nothing after it — `{"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[{"file":"<file>","reason":"<reason>"}],"notes":null}`, with one `touchedNotSuggested` entry per file the brief did not suggest, or the blocked form `{"status":"blocked","question":"<question>","filesNeeded":["<file>"]}` when the brief cannot be completed without a file it does not provide. The report is advisory: a missing or invalid one changes nothing and the checks decide, while a blocked one starts a consult at once. The same rules are mirrored in the task's closing instruction (`src/engine/spec/prompt-formatter.ts`).

## Where tasks live on disk

`state.json` at `.splitbrief/sessions/<id>/state.json`. Tasks are at `state.tasks: Task[]`. Current task index at `state.currentTaskIndex: number`. Current retry count at `state.attempt: number`.

## Task shape

```ts
type Task = {
  id: TaskId;                        // branded string, e.g. "T001"
  parentId?: TaskId;                 // set on a split's subtask: the lineage's root task id
  title: string;                     // short human label
  file: string;                      // project-relative anchor path (e.g. "src/foo.ts")
  files?: string[];                  // optional: the whole slice; defaults to [file], and file is a member
  action: 'create' | 'modify';
  description: string;               // full task description
  dependsOn: TaskId[];               // IDs of tasks that must complete first
  tests: string[];                   // test cases / acceptance criteria
  constraints: string[];             // additional constraints or requirements
  implementationSteps: string[];     // step-by-step guide for the implementer; advisory, not a fence
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
  // Plan fields: set by taskFromSpec on a task compiled from plan.json; absent on older briefs
  criteria?: string[];               // criterion ids the task serves
  checks?: Check[];                  // { id, kind: 'test' | 'cmd' | 'render', value, required }
  suggestedFiles?: string[];         // guidance; mapped onto files
  contextFiles?: string[];           // read-only context; never a write target
  contextCodeByFile?: Record<string, string>;  // captured current code of contextFiles, keyed by path
  exclusions?: string[];             // explicit "do not" notes
  batch?: number;                    // the plan's batch, 1-based
  protectedOperations?: Array<{ path: string; operation: 'write' }>;  // confirmed when the plan card is approved
  revision?: number;                 // 1 at compile; raised by each consult rewrite
  inputHashes?: Record<string, string>;  // content hashes of this revision's suggested + context files
  checkResults?: Array<{ id: string; passed: boolean }>;  // a consult's verify answer, merged per check id
  fix?: {                            // set on a task the review triage appended
    cycle: number;                   // the fix cycle that created it
    findings: Array<{ id: string; text: string; acceptance: string | null }>;  // the verdict's findings, verbatim
  };
};
```

**Fresh code and read-only context.** Before each attempt the task's code is refreshed from disk (`src/engine/orchestrator/task/refresh-code.ts`). `UPDATE_TASK_CODE` replaces all three code fields — `currentCode`, `currentCodeByFile` and `contextCodeByFile` — so a stop and a resume never keep stale code. The code of `contextFiles` goes into `contextCodeByFile`, kept apart from the write targets. Context files share a budget of 40,000 characters per task (`CONTEXT_CODE_BUDGET_CHARS`, about 10K tokens); the file that crosses it is cut and ends with `…truncated`, and the context files after it are left out. Context files are read-only: they are not in the brief's Scope and never count as a write target. The prompt formatter adds each context file under `### Read-only context (do not modify) — <path>`. A prompt measured against a context length gives every target file and every context file an equal share of the code budget, so a large context file never crowds out the code the brief edits; the context-fit estimate counts what is sent. A task over BUILD's context fails the plan checks with its context files and their sizes named. The brief hash (`brief-hash.ts`) ignores captured code. A direct writer gets the read-only context code but not the code of the files it edits: it reads those in place.

### `TaskId`

A branded string. Format: `TNNN` where `NNN` is zero-padded sequential starting at `001`. IDs are stable across retries and reorderings. IDs are never reused within a session.

### `TaskStatus`

```ts
type TaskStatus =
  | 'pending'        // not yet attempted
  | 'in_progress'    // implementer is generating code
  | 'done'           // validation passed: the attempt, a consult-guided attempt, or a consult verify
  | 'escalated'      // no producer now; kept so an older state.json still loads
  | 'failed'         // the ladder halted with a pending recovery
  | 'skipped';       // task denied by a pre_task hook or programmatic skip
```

Transitions (simplified; full state-machine in `src/core/state/machine.ts`):

```
pending --[START_TASK]--> in_progress
in_progress --[VALIDATION_PASS]--> done
in_progress --[VALIDATION_FAIL (retry available)]--> in_progress  (state.attempt++)
in_progress --[VALIDATION_FAIL (retry spent)]--> phase escalating; the consult's answer decides:
                                                    guidance → one more attempt → done
                                                    rewrite-task → REPLACE_TASK (revision+1)
                                                    split-task → INSERT_TASKS (parentId, next free ids)
                                                    verify → validation + checks → done
                                                    ask-user → the user's answer continues as guidance
in_progress --[a ladder halt with a pending recovery]--> failed
any --[SKIP_TASK]--> skipped
any --[RESET_TASK]--> pending
```

The retry counter lives at **`state.attempt`** (top-level on `WorkflowState`), not on the individual task. The ladder's own counters live per lineage in `state.lineages` — `consults`, `attempts`, `consultAllowance`, `attemptAllowance`, `consultRecords`, `replacedParents` — and the run's planner-call count in `state.plannerCalls`.

### Lifecycle guarantees

- **ID stability**: a task's `id` is the one the plan gives it (`T001`, `T002`, …). A revision before approval compiles the tasks again from the revised `plan.json`; once the plan is approved, an id never changes and is never reused within the session.
- **Terminal states**: `done | escalated | failed | skipped` — once set, the status does not move backwards within a session. `RESET_TASK` explicitly transitions to `pending` and is the only way out of a terminal state.

## The typed review contract

The review seat is a stateless, read-only call. It does not write `review.md`; it answers one typed `ReviewVerdict` (`src/core/schemas/review.ts`) through `requestTyped`, and SPLITBRIEF derives and renders the rest.

```ts
type ReviewVerdict = {
  tasks: Array<{ id: TaskId; plan: 'met' | 'partial' | 'missed'; note: string }>;
  criteria: Array<{ id: string; status: 'pass' | 'fail' | 'unverified'; evidence: string }>;
  findings: Array<{
    id: string;
    kind: 'defect' | 'plan-gap' | 'unverified' | 'question';
    severity: 'blocking' | 'minor';
    taskId: string | null;
    file: string | null;
    line: number | null;
    text: string;
    acceptance: string | null;
    checkIds: string[] | null;
    criterionId: string | null;
  }>;
};
```

Coverage is a contract rule: the answer carries exactly one result for every task and criterion in scope, and an `unverified` finding names non-empty `checkIds` or a `criterionId` whose criterion has registered checks. A missing, duplicated or invented id, or a `partial`/`missed` task or `fail` criterion with no blocking finding naming it, fails the schema and the seat gets its one repair. The checks behind an unverified claim run through `runChecks`, a `render` check running the configured `validation.render` command; a render criterion stays unverified when no image reached the reviewer. `deriveReviewOutcome` turns the answer plus those results into `pass`, `pass-with-notes` or `fail`. The record lives in `state.review` and `review.json`; `review.md` is its rendering from `renderReviewMarkdown` (`src/core/review/render.ts`). A session saved before the typed review still reads through `parseFinalReview()` (`src/engine/parsers/final-review.ts`).

A failed review goes to one planner triage call, which answers one typed `TriageResult`:

```ts
type TriageResult = {
  fixTasks: Array<TaskSpec & { findingIds: string[] }>;
  rejected: Array<{ findingId: string; reason: string }>;
  verify: Array<{ findingId: string; checkIds: string[] }>;
  ask: { question: string; whyOnlyUserCanAnswer: string } | null;
};
```

Unless `ask` suspends the rule, each blocking finding and pending triage input is answered by exactly one `fixTasks` entry (naming the findings it fixes), `rejected` entry, or `verify` entry; a `verify` check id must be a plan check, and a fix task names only known criteria. A fix task is appended to `state.tasks` with a new `T###` id and `batch` = the highest plan batch + the fix cycle, and `task.fix` carries its cycle and its findings verbatim. Done tasks stay done; nothing is reopened. A task with `fix` may verify existing code and change nothing — the recorded checks still decide completion. A missing `touchedNotSuggested` reason never overturns a passing check: such reasons are recorded for the reviewer, not required for a pass. Rejected findings reach the next review's packet; `verify` runs its named checks before any fix call.

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
| `Task.fix` | the task is a plan task, not a fix task the review triage appended |
| `WorkflowState.reviewFixes` | no review fix cycle has run. Parse-only now: `fixCycles` is the live home, and `reviewFixes.cycle` is read only when `fixCycles` is absent |
| `WorkflowState.fixCycles` | no fix cycle has run; a state that carries only the older parse-only counter reads that instead |
| `WorkflowState.review` | no typed review has resolved; `review.json` is the review's other home |
| `WorkflowState.triage` | the review never went to triage |
| `WorkflowState.pendingTriage` | no operator or Apply input waits for a triage |
| `WorkflowState.reviewStatus` | the final review has not resolved |
| `WorkflowState.validationBaseline` | the run-start gate probe is re-run on resume instead of reused |
| `WorkflowState.interruptedStep` | nothing recorded where the run was cut; `cut` says which — `mid-step` inside a call, `boundary` where it cut nothing: between two briefs, or at a gate — and a record written before `cut` existed falls back to the presence of a `partialRef` |
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

## Older runs: `brief-quality.json`

A run planned before the typed plan session ran a brief-quality pass over `tasks.md` and wrote `brief-quality.json`. A new run writes no such file: its briefs are compiled from a plan that passed `checkPlan`. `BriefQualityReport` and `isBriefQualityReport` (`src/engine/spec/brief-quality.ts`) stay so that an older session folder still reads, and the `brief_quality_*` and `brief_readiness_*` events stay in the event schema for replay. The scorer itself is deleted.

## API BUILD file bundles

API file bundles support at most 32 declared text targets, 1 MiB UTF-8 per file, and 4 MiB of raw response.

The backend selects `file-bundle-v1` before every API BUILD call, including one-file tasks, retries and continuation. The entire completed response must parse as strict JSON with `version: 1` and either a nonempty `files` array or a `blocked` object. Each entry has exactly `path`, `action` (`create` or `modify`) and complete `content`. A single enclosing JSON code fence is accepted by the parser; surrounding prose, mixed fragments, duplicate paths and unknown fields are refused. Other extracted-output backends keep their legacy grammar.

```json
{
  "version": 1,
  "files": [
    {"path": "src/example.ts", "action": "modify", "content": "export const answer = 42;\n"}
  ]
}
```

```json
{"version":1,"blocked":{"question":"<question>","filesNeeded":["<file>"]}}
```

A blocked bundle applies nothing and starts a consult with reason `blocked` and no local retry.

Targets must be declared, confined relative paths and regular UTF-8 text files or explicitly new files. API bundles do not support delete, rename, chmod or binary operations. Omitted declared targets stay untouched; unchanged entries are no-ops. An empty effective change is not successful implementation.

The application captures target baselines before dispatch, parses and preflights the full response and approval set before mutation, then rechecks each baseline before writing. It preserves concurrent user edits by refusing conflicts. If a later write fails or cancellation interrupts application, earlier writes remain; there is no rollback claim. Validation runs once after the whole bundle succeeds, with aggregate diffs and line counts for actual changed paths. A partial result cannot publish successful completion or advance the brief. The bundle is applied in the run workspace like every other writer's output; the checkout receives it only through Apply.

The existing task evidence entry has optional `apiApply` with `callId`, `grammar: 'file-bundle-v1'`, `status`, `candidatePaths`, `applied`, `noops`, `untouched`, optional `failedPath` and `code`. Each applied entry records `path`, `action`, nullable `beforeSha256`, `afterSha256`, and optional `afterMode`, without storing baseline contents. Status is `applied`, `rejected`, `partial` or `failed`; a pre-dispatch refusal has a null call ID. Persisted partial effects remain available to retry and recovery. Older evidence without this field means unknown, not applied. If a process crashes before the receipt is persisted, existing task snapshots and disk state support reconciliation, but attribution may remain unknown and require recovery.

## Checks log

Every run writes a per-session evidence ledger to `.splitbrief/sessions/<id>/evidence.json`
(constant `EVIDENCE_FILE`, file mode `0o600`). The ledger is the durable record of
what each check actually did, per task, alongside the writer receipts below. It is
written incrementally as tasks reach a terminal state and amended once the
final review completes. API bundle applications in the run workspace update `promotedFiles` (the name
predates the run workspace) from the writer's result before validation. This collection keeps only the latest receipt for each target path
across all tasks. `promotedBriefHash` binds it to the single brief definition,
excluding runtime status and current code. A changed brief resets its receipt
collection. Historical `promotionAttempts` from older runs remain available for
review, but never authorize current ownership. Before a possible target write, the orchestrator invalidates prior ownership
for the affected paths. If invalidation cannot persist, the writer does not run.
A missing later receipt therefore cannot revive an earlier version. Unknown
failed writes also invalidate earlier ownership for their path. Legacy receipts without this identity, or API results
without a verified mode, cannot prove ownership. Direct writes without writer
receipts stay unproved; the approval gate does not infer authorship by rereading
the target. A target that already matches staged bytes takes no write and gains
no new receipt. An actual write that creates an absent target also records
`created: true` on its writer receipt. The ledger retains that fact separately
in `apiCreatedPaths`, so a later API attempt can modify its own created anchor.
Losing a receipt leaves that creation unproved.

### Shape

```ts
type EvidenceLedger = {
  version: 1;
  sessionId: string;
  feature: string;
  mode?: 'quick' | 'standard' | 'speckit';   // older runs only; a new run writes none
  generatedAt: string;
  tasks: Array<{
    id: string;
    title: string;
    file: string;
    status: 'pending' | 'in_progress' | 'done' | 'escalated' | 'failed' | 'skipped';
    method?: 'local' | 'consulted' | 'escalated-hint' | 'escalated-intermediate' | 'escalated-full' | 'failed' | 'skipped';
    retries: number;
    durationMs?: number;
    changedFiles: string[];
    validation: Array<{ stage: 'typecheck' | 'lint' | 'test'; passed: boolean;
                        skipped?: boolean; skippedReason?: string; errorSummary?: string }>;
    checks?: Array<{             // one entry per check run: a stage, the suite, or a registered check
      id: string;                // the stage name or the registered check id
      command?: string;
      exitCode?: number;
      output?: string;           // bounded, redacted tail
      artifacts?: Array<{ path: string; sha256: string }>;
      workspaceSnapshotId?: string;
      ts: string;
    }>;
    expectedEvidence?: string[];  // retired; an older file's value loads and is ignored
    observedEvidence?: string[];  // retired; an older file's value loads and is ignored
    escalated: boolean;
    briefHash?: string | null;  // absent on sessions written before this spec; readers must treat absent and `null` identically.
    promotedBriefHash?: string; // hashTaskBrief([task]); independent of the whole-plan briefHash
    promotedFiles?: Array<{ path: string; sha256: string | null; mode: number | null; created?: true }>;  // latest writer receipt per target path; null digest and mode = deleted
  }>;
  validationSummary: { passed: number; failed: number; skipped: number; escalated: number };
  finalReview?: { path: string; status: 'written' | 'failed' | 'skipped' };
  briefHash?: string | null;  // absent on sessions written before this spec; readers must treat absent and `null` identically.
};
```

### Check kinds and policy

A check is one of three kinds. A `test` check runs the named test file or pattern through the validation stage's own resolved command and narrowing. A `cmd` check runs its value as a command: `npm run <script>` is allowed only under an approved plan and only when `package.json` defines the script, and `npx` is allowed only as `npx --no-install <stack tool>`. `checkCommandRefusal` (`src/engine/orchestrator/planning/sanitize-discovered-validation.ts`) decides this; `planApprovesNpmScripts` reads the configured approval level and the run's recorded plan approval, and without approval every other command falls to `unsafeCommandReason`. The plan card lists approved `npm run` checks as confirmations (`planConfirmations`, `src/engine/orchestrator/approval/confirm.ts`). A `render` check runs the user's `validation.render` command — `{id}` is the check's value, one argv element matching `^[a-z0-9-]+$`, and `{out}` is a fresh directory under `<workspace>/.test-artifacts/ui/`, with cwd the workspace; it is not filtered by the planner command policy. Every `.png` under `{out}` is copied to `.splitbrief/sessions/<id>/renders/<check-id>/` and logged with its sha256. With no `validation.render` the check is `not-runnable` with `validation.render is not set`.

A check's status is `pass`, `fail`, `not-runnable`, `refused` or `unknown`. A required check that cannot run — any status but `pass` or `fail` — halts before the review with `required-checks-unrunnable`, listing every check id; it never becomes a fix task. A required check that ran and failed enters the pre-review triage as a `defect`, keyed to the file it names. The scheduler runs typecheck, lint, the affected tests and the task's own checks after every task; the full suite at each batch boundary; and the full suite plus every required check before every review. Each run appends one entry to the task's `checks` log; the review packet prints them under `## Checks Log` with every path read outside the workspace.

A `test`, `cmd` or `render` check whose executable is missing is `not-runnable` with `<executable> not found`. It never becomes `fail` and never enters triage.

The reviewer prompt limits the Checks Log to 30,000 characters for a CLI seat. It selects outside reads first, then the latest execution of each check id if that execution failed. Next, it selects the other latest executions, then earlier failures, then the rest. The log keeps the selected entries in their recorded order. An omission line names the count and the path of `evidence.json`.

If size limits remove the Checks Log, its replacement names `evidence.json` for checks and `session.jsonl` for `isolation_outside_read` warnings. An API seat gets the whole log. The API review packet refuses with `insufficient-context` if the orchestrator cannot assemble the log. It also refuses if the whole input does not fit. Both seats get every `isolation_outside_read` path.

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
drift report comparing the Task Brief against the captured brief diffs and the
evidence ledger. The report is persisted as `drift-report.json` in the session
directory and is also injected as a section into the final-review prompt.

Final-review attribution comes from `review-changes.json`, which records the before/after bytes each passing brief changed in the run workspace, and their brief hashes. The full Git comparison remains workspace context, including unknown edits and independent changes within the same declared file. A missing expected file in the final drift report can mean that the brief's change capture was not recorded, rather than that the file was unchanged. Legacy sessions and direct writes without capture keep that uncertainty visible. The review packet's optional `changes.provenance` describes this evidence without changing the version-1 packet boundary.

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
| `out_of_scope_file` | info | Changed file is outside every brief's declared set: `<file> touched, not suggested by any task.`, or a pre-existing note when the file was already changed before the run started. It never fails drift. |
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
