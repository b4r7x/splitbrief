# Task Contract

> **Status:** stable (state v4, config v3).
> **Audience:** implementer runners, reviewers, and advanced read-only integrations inspecting Task Brief state.

A brief that fails after its one retry, reports `blocked`, or is stale goes to a consult, not to a fixed tier chain. A plan task consults the planner; a fix task (`task.fix`) consults the review seat. The old `escalated-hint` / `escalated-intermediate` / `escalated-full` completion values and the old `escalate`, `hint_failed` and `task_scope_widened` events stay parseable so a saved `state.json` and `session.jsonl` still load.

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
| `validation` | `{ language, test, testPattern }` or null | Becomes `state.discoveredValidation` (`testCommand`, `testPattern`, `language`); it feeds only the planner's `test` checks. `testPattern` is a file name pattern with one `*`, such as `*.test.js` or `test_*.py`. It has no directory part (`/` or `\`) and no `..`. SPLITBRIEF searches beside the changed file and in the stack's test folders. SPLITBRIEF emits `discovered_validation_refused` when it refuses a discovered pattern. It uses the configured pattern, if present. Otherwise, it uses the stack's patterns. |
| `tasks` | `TaskSpec[]` | The tasks |

`state.plan` (`PlanSchema`) keeps the plan without its tasks; the tasks live in `state.tasks`.

**The decisions ledger.** An entry is `{ text, taskId }`. A plan's own decision carries `taskId: null`. When the implementer proposes a deviation in its report (`ImplementerReport.decisions`, `{ what, why }`), the planner confirms it with a decision-confirm before the attempt is validated (at most once per attempt, bounded by the brief's attempts, with no run counter; see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md)), and its `confirm` answer makes `CONFIRM_DECISIONS` append `{ text: '<what> — <why>', taskId }`, naming the task that reported it. Only a reported decision the `confirm` lists joins the ledger, in the implementer's own words; the match ignores a JSON escape the planner returns decoded (`\u0300` as its character). A reported decision the `confirm` leaves out or rewords is rejected: it never joins the ledger, and the attempt retries with the planner's diagnosis. The `consult_answered` event counts the two apart: `decisionCount` the accepted reported decisions, `rejectedCount` the rest. The ledger reaches every later brief's read-only Plan context, every consult and the review; the planner confirms a change of how only when the accepted criteria stay intact, and the user decides any change to what is built.

**`TaskSpec`.**

| Field | Type | Maps to `Task` |
|---|---|---|
| `id` | `TNNN` | `id` |
| `title` | string | `title` |
| `intent` | string | `description` |
| `criteria` | string[] (criterion ids) | `criteria` |
| `checks` | `Check[]` | `checks`; `tests` = the values of the `test` checks; `evidence` = one line per check (`<id> <kind>[ (optional)]: <value>`) |
| `suggestedFiles` | string[], at least one | `suggestedFiles` (the first is the anchor) |
| `contextFiles` | string[] | `contextFiles` (read-only: never in `scope`, never a write target) |
| `exclusions` | string[] | `exclusions`; `scope.outOfBounds` |
| `protectedOperations` | `{ path, operation: 'write' }[]` or null | `protectedOperations` (absent when null) |
| `steps` | string[] or null | `implementationSteps` (empty when null); advisory — the implementer may reach the same accepted behaviour another way |
| `dependsOn` | `TNNN[]` | `dependsOn` |
| `batch` | integer ≥ 1 | `batch` |

`taskFromSpec` (`src/engine/spec/plan-tasks.ts`) fills every older required `Task` field from that table, so every engine path reads a plan task as a brief. `action` is `modify` when the first suggested file exists inside the project, otherwise `create`. SPLITBRIEF derives it again before each brief starts, because an earlier brief can create the file. A retry, and a Continue past a consult limit that replays the brief on the files its last attempt left, keep the action the brief started with: the file its own earlier attempt wrote does not make a `create` brief a `modify` brief. `constraints` is empty and `typeDefs` is `''`. `taskFromSpec` throws when a task names no suggested file, so it runs only after the checks pass. `protectedOperations.operation` accepts only `write`, because the protected-path confirmation matches `write <path>`. The schema spells every `suggestedFiles`, `contextFiles` and `protectedOperations` path as the write gate names a changed file (`./src/a.ts` and `src/../src/a.ts` are `src/a.ts`), so every check and every engine path compares one spelling. A question's `default` is non-empty, and one of its `choices` when it has choices.

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
| `task-without-criterion` | Every task serves at least one criterion |
| `task-without-intent` | Every task has a non-blank intent |
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
| `refused-check-command` | The plan command policy runs every `cmd` check of the plan, judged from its text at the run's approve level (`commandTextRefusal`); whether `package.json` defines an npm script is left to the check run, since a task can add the script. `refusedCheckErrors` applies the same rule to the `cmd` checks of a review's fix tasks, as a contract error of the review answer, and to the `cmd` checks of a consult's `rewrite-task` or `split-task` answer, as a contract error of the consult answer (`answerContract`, `src/engine/orchestrator/consult/request.ts`) |
| `render-check-unconfigured` | Every render check of the plan needs `validation.render`; the plan goes back to the planner once with the reason, and when the planner keeps them the plan card opens with a "Before you approve" note naming them, since without the command the run halts before its review |

A task with no suggested file is refused by the schema, not by `checkPlan`. `checkFullPlan` (`src/engine/orchestrator/planning/session.ts`) runs `checkPlan` with the context fit; the session and the plan card's edit path both call it. The in-app editor's save check runs `checkPlan` without the context fit (`planSaveErrors`), and the engine checks the fit after the save.

## Task Brief v1: the semantic contract

A `Task` is the persisted, transport-stable form of a **Product Task Brief v1** — the durable contract the planner writes for the implementer. The brief is the meaning; `tasks.md` is the markdown rendering used to hand work between phases; `state.json` is the stable JSON that SPLITBRIEF and advanced read-only integrations consume.

A new run's planner does not write `tasks.md`: it answers a typed `TaskSpec` in `plan.json`, and `taskFromSpec` maps it onto these sections (see [The plan contract](#the-plan-contract)). `tasks.md` is rendered from the mapped tasks. The skills keep writing a Markdown brief rendered from the same `TaskSpec` fields.

Every Task Brief v1 covers nine semantic sections, even when a section is brief. Each section maps onto existing `Task` schema fields so external tools do not need a new shape:

| # | Brief section | Schema fields | Notes |
|---|---|---|---|
| 1 | **Identity** | `id`, `title`, `suggestedFiles`, `action` | Stable identity for the task. `suggestedFiles` is the slice the brief writes; its first path is the anchor. A brief saved before `suggestedFiles` named them in `file` and `files`; the schema reads those as `suggestedFiles`. |
| 2 | **Intent** | `description` | What change is needed and why it matters. |
| 3 | **Scope** | `description`, `constraints`, optional `scope.inBounds` / `scope.outOfBounds` | Guidance: `suggestedFiles` are suggestions, **In bounds** is context, and **Out of bounds** lists the explicit exclusions the reviewer checks. |
| 4 | **Code Context** | `signature`, `currentCode`, `typeDefs`, `pattern` | Existing code, signatures, types, or patterns the implementer needs. |
| 5 | **Implementation Plan** | `implementationSteps` | Ordered steps for the change. |
| 6 | **Validation** | `tests` | Concrete checks, tests, or assertions that define success. |
| 7 | **Constraints** | `constraints` | Invariants, dependencies, refusal conditions. |
| 8 | **Escalation** | optional `escalation` | When the implementer must stop and ask instead of guessing. |
| 9 | **Evidence** | optional `evidence` | Final reviewable proof preserved after the task completes. |

`tasks.md` is a projection for people, rendered from the compiled tasks (`formatTasks`, `src/engine/spec/formatter.ts`): one task block per brief, frontmatter for identity and dependencies, `### …` headings for each semantic section. Nothing parses it back. The implementer prompt may reformat a brief but must not change its meaning. `state.json` is the stable external JSON; consume that for machine-readable read-only workflows.

**How the Scope section is interpreted.** Scope is guidance, not a fence. The brief's `suggestedFiles` are suggestions, **In bounds** is context, and **Out of bounds** lists the explicit exclusions the reviewer checks. An implementer may edit another ordinary project file when the change needs it; SPLITBRIEF records it as touched, not suggested, runs its tests, and shows it to the reviewer. Only a protected path (dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`) asks the user (see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md)). A placeholder bullet — `None`, `None.`, `n/a` or `-` — is no entry at all: `scopeEntryPatterns` licenses nothing for it (`isScopePlaceholder`). Scope bullets are prose, not a file list. A brief's **declared set** is `suggestedFiles` plus every `scope.inBounds` and `scope.approvedOutOfBounds` bullet, and one module resolves it for every consumer — `taskDeclaredPatterns` / `isInDeclaredSet` in `src/core/scope/declared-set.ts`. When deciding whether a brief widens the write scope beyond its `suggestedFiles`, SPLITBRIEF extracts path tokens from each `scope.inBounds` / `scope.approvedOutOfBounds` bullet (`scopePathPatterns` in `src/utils/path-patterns.ts`): backtick-quoted tokens first, then — when the bullet has no backticks — the whole bullet if it contains no whitespace, otherwise concrete path patterns matched out of the prose. A token only counts as a path when it carries a directory separator or a glob; a bare filename with no directory cannot denote a file other than one of the task's own `suggestedFiles` in any recorded plan, so it never widens the write scope. A bullet that names a file the brief already declares does not widen it either.

**Approved out of bounds is planner-authored.** The run no longer appends to it: the hint rung's `widen` verdict and `WIDEN_TASK_SCOPE` are gone. When the consult decides a brief's scope was wrong, it answers `rewrite-task` or `split-task` and the replacement carries the scope the planner wrote; the entry is then an ordinary Scope bullet, read by `scopePathPatterns` exactly as any other, so the declared set, the write gate, the classifier, the preamble and drift widen together. `scope.approvedOutOfBounds` is visible in `state.json` and in the brief as rendered; old `task_scope_widened` events stay replayable.

**Create-then-modify chains are legal.** A brief may declare `action: modify` on a file an earlier brief in the same plan creates. Because the task loop runs in array order, the routing preview reports such a target as `pending-earlier-task` rather than `missing-current-code`: the file is expected to exist by the time the modifying task runs, and the missing current code is a non-event, not a stale estimate.

**What a direct-write implementer is told about scope and stopping.** Beyond the brief itself, a `direct` implementer receives a system preamble (`src/engine/spec/prompts/system.ts`) that restates the contract as hard rules: read, search, write and run shell commands only inside the isolation directory, which it names by absolute path, and never look for other copies of the project; use git only to read (status, diff, log, show), because the worktree shares refs, stash, hooks and config with the user's repository; never run a package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun), because dependencies are already installed and the worktree's `node_modules` is a symlink into the real checkout; start from the files the brief suggests, edit another project file only when the change needs it and name it with the reason, and never edit dependency manifests, lockfiles, CI configuration, env or key files, `.git` or `.splitbrief` unless the brief asks for that operation; stop and report instead of guessing when the brief's stop conditions are met, or when a declared file's current content contradicts the brief; start editing from the brief and read a file only for lines the brief does not show; SPLITBRIEF runs the checks after the hand-back and its verdict is the authority, so run no test, typecheck, lint, format, screenshot, render or other check command, not even the tests it writes or a command the brief names; and end the reply with one `ImplementerReport` JSON object and nothing after it — `{"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[{"file":"<file>","reason":"<reason>"}],"notes":null}`, with one `touchedNotSuggested` entry per file the brief did not suggest, or the blocked form `{"status":"blocked","question":"<question>","filesNeeded":["<file>"]}` when the brief cannot be completed without a file it does not provide. The report is advisory: a missing or invalid one changes nothing and the checks decide, while a blocked one starts a consult at once. The same rules are mirrored in the task's closing instruction (`src/engine/spec/prompt-formatter.ts`): "SPLITBRIEF runs the checks after you hand back, so run no test, typecheck, lint or other check command."

## Where tasks live on disk

`state.json` at `.splitbrief/sessions/<id>/state.json`. Tasks are at `state.tasks: Task[]`. Current task index at `state.currentTaskIndex: number`. Current retry count at `state.attempt: number`.

## Task shape

```ts
type Task = {
  id: TaskId;                        // branded string, e.g. "T001"
  parentId?: TaskId;                 // set on a split's subtask: the lineage's root task id
  title: string;                     // short human label
  suggestedFiles: [string, ...string[]];  // every path the brief may write, first the anchor (e.g. "src/foo.ts")
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
  contextFiles?: string[];           // read-only context; never a write target
  contextCodeByFile?: Record<string, string>;  // captured current code of contextFiles, keyed by path
  exclusions?: string[];             // explicit "do not" notes
  batch?: number;                    // the plan's batch, 1-based
  protectedOperations?: Array<{ path: string; operation: 'write' }>;  // confirmed when the plan card is approved
  revision?: number;                 // 1 at compile; raised by each consult rewrite
  inputHashes?: Record<string, string>;  // content hashes of this revision's suggested + context files
  checkResults?: Array<{ id: string; status: 'pass' | 'fail' | 'not-runnable' | 'refused' | 'unknown' }>;  // merged per check id; an older run's `passed` loads as pass or fail
  fix?: {                            // set on a task the review answer appended
    cycle: number;                   // the fix cycle that created it
    findings: Array<{
      id: string; text: string; acceptance: string | null;  // the finding or input, verbatim
      file?: string;                 // the file the red or finding names
      checkIds?: string[];           // the check that was red (`V1`, a plan or task check), or the finding's checks
      commands?: Record<string, string>;  // check id -> the exact command text it ran
      failureKeys?: Record<string, string[]>;  // check id -> own keys from the full capture
      redKeys?: Record<string, string[]>;      // check id -> all original red keys before the base split
      output?: string;               // the captured failing output
    }>;                              // the brief gate runs those checks again
  };
};
```

**Fresh code and read-only context.** Before each attempt the task's code is refreshed from disk (`src/engine/orchestrator/task/refresh-code.ts`). `UPDATE_TASK_CODE` replaces all three code fields — `currentCode`, `currentCodeByFile` and `contextCodeByFile` — so a stop and a resume never keep stale code. The code of `contextFiles` goes into `contextCodeByFile`, kept apart from the write targets. Context files share a budget of 40,000 characters per task (`CONTEXT_CODE_BUDGET_CHARS`, about 10K tokens); the file that crosses it is cut and ends with `…truncated`, and the context files after it are left out. Context files are read-only: they are not in the brief's Scope and never count as a write target. The prompt formatter adds each context file under `### Read-only context (do not modify) — <path>`. A prompt measured against a context length gives every target file and every context file an equal share of the code budget, so a large context file never crowds out the code the brief edits; the context-fit estimate counts what is sent. A task over BUILD's context fails the plan checks with its context files and their sizes named. The brief hash (`src/core/evidence/brief-hash.ts`) ignores captured code. It also ignores the run output that the run writes onto a brief: `checkResults` and `inputHashes`. A direct writer gets the read-only context code but not the code of the files it edits: it reads those in place.

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

The retry counter lives at **`state.attempt`** (top-level on `WorkflowState`), not on the individual task. The ladder's own counters live per lineage in `state.lineages` — `consults`, `attempts`, `consultAllowance`, `attemptAllowance`, `consultRecords`, `replacedParents` — and the run's consult count in `state.plannerCalls` (the name stays; planner and review-seat consults share it).

### Lifecycle guarantees

- **ID stability**: a task's `id` is the one the plan gives it (`T001`, `T002`, …). A revision before approval compiles the tasks again from the revised `plan.json`; once the plan is approved, an id never changes and is never reused within the session.
- **Terminal states**: `done | escalated | failed | skipped` — once set, the status does not move backwards within a session. `RESET_TASK` explicitly transitions to `pending` and is the only way out of a terminal state.

## The typed review contract

The review seat is a stateless, read-only call. It does not write `review.md`; it answers one typed `ReviewAnswer` containing `ReviewVerdict` and `TriageResult` (`src/core/schemas/review.ts`) through `requestTyped`, and SPLITBRIEF derives and renders the rest.

A task review prompt states the reviewed tasks, due criteria, and pending tasks.
Pending tasks provide context and do not represent missing implementation.

`findingInReviewScope` (`src/core/review/verdict.ts`) checks each finding against that scope.
A blocking finding must name a reviewed task or a due criterion. If it names both, both must be in scope.
Check ids alone do not place a finding in scope.
SPLITBRIEF records a finding outside the scope as a note, `Outside the task review scope: …`.
The finding does not block the review and never becomes a fix task.

The final review judges every task and every acceptance criterion, regardless of task status.
It still accepts a finding with no task or criterion id.

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

Coverage is a contract rule: the answer carries exactly one result for every task and criterion in scope, and an `unverified` finding names non-empty `checkIds` or a `criterionId` whose criterion has registered checks. A missing, duplicated or invented id, or a `partial`/`missed` task or `fail` criterion with no blocking finding naming it, fails the schema and the seat gets its one repair. The checks behind an unverified claim run through `runChecks`, a `render` check running the configured `validation.render` command; a render criterion stays unverified when no image of its check reached the reviewer. The reviewer gets at most 4 PNGs per render check: every `frame.png` first, then the other PNGs, each group in path order; the prompt names the PNGs not attached. `deriveReviewOutcome` turns the answer plus those results into `pass`, `pass-with-notes` or `fail`; a red check or Apply input that still blocks (`blockingRedInputs`) fails it and stays in the record as `redInputs`. A reviewer check of the review that was red at the run base too stays in the record as `preExistingChecks` (`{ id, command, keys }`, the failures that also fail before the run's changes); it raises no finding. When the checks behind an unverified claim fail only on those failures, they verify the claim. A minor finding is a note, also when it is unverified; a blocking unverified finding blocks until its checks verify it. The record lives in `state.review` and `review.json`; `review.md` is its rendering from `renderReviewMarkdown` (`src/core/review/render.ts`), with a `### Pre-existing failures` section that names each such check, its command and its first three failures. A session saved before the typed review still reads through `parseFinalReview()` (`src/engine/parsers/final-review.ts`).

The same review call also returns the fix part, with the persisted `TriageResult` shape:

```ts
type TriageResult = {
  fixTasks: Array<TaskSpec & { findingIds: string[] }>;
  rejected: Array<{ findingId: string; reason: string }>;
  verify: Array<{ findingId: string; checkIds: string[] }>;
  ask: { question: string; whyOnlyUserCanAnswer: string } | null;
};
```

Unless `ask` is set, the answer covers every blocking finding inside the review scope except an unverified finding.
It also covers every pending input. Each id appears exactly once in `fixTasks[].findingIds`, `rejected[].findingId` or `verify[].findingId`.
Rejections name pending inputs only. Findings outside the scope need no answer.

`triageContractErrors` (`src/engine/orchestrator/triage.ts`) refuses a fix task for a finding outside the task review scope.
It also refuses a fix task criterion outside the scope.
These rules also apply when `ask` is set or the fix task has no criteria.
Pending user, Apply, and check inputs keep their existing rules.

Unverified and minor findings never create fix tasks. A verification names registered plan or task checks. A fix task names only known criteria. A verdict finding assigned to a fix task names only registered checks. An unknown check id sends the answer back for its one schema repair.

SPLITBRIEF appends fix tasks to `state.tasks` with new `T###` ids. Their `batch` is the highest plan batch plus the fix cycle. Each task carries its cycle and findings in `task.fix`.

A finding that answers a red check also carries its `checkIds`, `commands`, `failureKeys`, `redKeys`, `file` and `output`. Each `commands` entry maps a check id to the exact command text it ran. Each optional `failureKeys` entry maps a check id to its own failure keys from the full capture. Each optional `redKeys` entry holds every failure key of that check's original red, before the base split. A verdict finding takes their union across all input files. An input finding carries its own `redKeys`. An incomplete capture gives one placeholder key and requires a passing command. Older tasks without own keys or original red keys load and must pass their commands. A verdict finding carries every reviewer command its `checkIds` name. A pending input supplies its single command for its named check.

The fix task's brief gate runs each check once through the same check runner and command policy. It never re-runs a fix check at the run base. A red passes only when no carried failure remains and the re-run still shows a key the original red showed that is not the task's own. Otherwise, the command must pass.

A diagnostic key includes its path, position and message. Match exact keys first, then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. Keys with no file match exactly.

This rule covers reviewer, plan and task checks. Every unmatched re-run key counts as another failure. The red must show an original other key before it can settle. A check with no carried keys, or a re-run with no named failure, must pass its command. A carried failure that remains fails the brief and enters the retry ladder. Each judged re-run gets a fix check verdict row. A green re-run shows that all carried failures are gone. A red without proof shows `your N failures not shown · not proven fixed`. Plan and task checks get only a done row, with no duration.

A settled check records `status: 'pass'` in `checkResults`. Its command evidence keeps the failure.

An older fix task that carries a `stage` loads without it. Completed tasks stay done. The reviewer supplies every fix task. A fix task may verify existing code and change nothing. Its recorded checks still decide completion.

A missing `touchedNotSuggested` reason never overturns a passing check. These reasons inform the reviewer. Rejected inputs reach the next review packet. SPLITBRIEF runs `verify` checks before it starts fix work.

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
| `suggestedFiles` | Custom field "Affected files" |
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
- The current persisted `stateVersion` is `4`. A v3 state migrates to v4 when it loads (`mapV3StateToV4`, `src/core/state/migration/map-v3.ts`). An older, malformed or future-versioned state does not load. Future bumps are documented in `CHANGELOG.md`.

**v4 additive fields.** These fields were added without a `stateVersion` bump; each is optional, and a state written before them reads identically:

| Field | Meaning when absent |
|---|---|
| `Task.files` | parse-only now: a saved `files`, else `[file]`, reads as `suggestedFiles` |
| `Task.currentCodeByFile` | only the anchor's `currentCode` was captured |
| `Task.fix` | the task is a plan task, not a fix task the review answer appended |
| `WorkflowState.reviewFixes` | no review fix cycle has run. Parse-only now: `fixCycles` is the live home, and `reviewFixes.cycle` is read only when `fixCycles` is absent |
| `WorkflowState.fixCycles` | no fix cycle has run; a state that carries only the older parse-only counter reads that instead |
| `WorkflowState.review` | no typed review has resolved; `review.json` is the review's other home |
| `WorkflowState.triage` | no review answer recorded fix work |
| `WorkflowState.pendingTriage` | no check, operator or Apply input waits for the reviewer |
| `WorkflowState.reviewStatus` | the final review has not resolved |
| `WorkflowState.interruptedStep` | nothing recorded where the run was cut; `cut` says which — `mid-step` inside a call, `boundary` where it cut nothing: between two briefs, or at a gate — and a record written before `cut` existed falls back to the presence of a `partialRef`. `source` is `user`, `watchdog` or `seat`, the last for a seat halt that cut a brief. `kept` lists the declared files a cut brief had changed when a stop parked it; a record without it claims no kept changes |
| `WorkflowState.closed` | the run was never explicitly ended, so it is still continuable |
| `WorkflowState.lastFailure` | the run recorded no failure; it stopped for some other reason |
| `WorkflowState.reviewChecks.skipped` | every chosen reviewer check ran or was refused. Present (`{ reason }`) when none of them ran: `validation.approve_checks: ask` and Skip all, a card closed without an answer, or a headless run. The `review_checks` event then has `status: 'skipped'` with the commands and the reason; SPLITBRIEF registers none of the skipped commands as a check, and the review never counts them as a pass |
| `WorkflowState.seatSwitches` | no seat moved in this run. Each record holds `seat`, `from`, `to`, `cause`, `auto`, `configRevision` and `ts`. `from` and `to` are display strings. New records also keep `switchId`, shared with the switch's logged event, and `fromSeat` and `toSeat`, each with the tool, model route id and configured effort or variant. Records without these fields still load. `auto` marks a switch the declared `fallback` applied; a run applies at most one per seat |
| evidence `skipped` / `skippedReason` | the stage ran; only an older ledger carries a skipped stage, and a planner `test` check with no command is now `not-runnable` |

**`Session.status`.** The session record's status is `open` \| `complete` \| `ended`, derived from the state by `deriveRunStatus` rather than from the exit path the run happened to take. The legacy literals `interrupted`, `failed` and `cancelled` still parse: they map to `open`, and `failed` additionally sets `stop: 'stopped'`. The row also carries optional `phase`, `mode`, `stop` (`waiting-for-you` \| `stopped`) and `apply` (`ready` \| `applied` \| `undone` \| `discarded`) (`SessionSchema`, `src/core/schemas/session.ts`). On an open row, `apply: 'ready'` marks a run that is ready to apply, and a row with neither `stop` nor `apply` is a run that is still going. On a closed row, `apply: 'undone'` marks a run whose Apply was undone. An older row's `stop` of `input-required`, `waiting` or `halted` reads as `waiting-for-you`, and `paused`, `failed` or `interrupted` reads as `stopped` (`StopKindSchema`, `src/core/schemas/run-step.ts`).

## What is NOT stable

- `summary.json` shape — the session row and its `Summary` can gain or change fields in any release (`SessionSchema`, `src/core/schemas/session.ts`). SPLITBRIEF saves it at the end of every run pass.
- `session.jsonl` event variants — we add new types regularly; consumers MUST tolerate unknown `type` values.
- `tasks.md` markdown structure — transport format; use `state.json` for machine consumption.
- Internal plan / spec artifact formats — change based on prompt evolution.
- `state.messageQueue` entries — internal coordination; structure may change.

## Example task entry

```json
{
  "id": "T003",
  "title": "Add email validation to SignupForm",
  "suggestedFiles": ["src/features/auth/SignupForm.tsx"],
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

A run planned before the typed plan session ran a brief-quality pass over `tasks.md` and wrote `brief-quality.json`. A new run writes no such file: its briefs are compiled from a plan that passed `checkPlan`. `BriefQualityReport` and `isBriefQualityReport` (`src/engine/spec/brief-quality.ts`) stay so that an older session folder still reads, but the `brief_quality_*` and `brief_readiness_*` events no longer replay, so such a session shows no rows for them. The scorer itself is deleted.

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
final review completes.

`persistApiApplyEvidence` records API bundle results in `apiApply` with
`workspacePath` before the caller handles the attempt outcome. Current build and
retry callers supply the workspace path. These results do not update
`promotedFiles`. When called without a workspace path, `recordApiApplyEvidence`
updates `promotedFiles` from the applied files. This collection keeps only the
latest receipt for each target path across all tasks. `promotedBriefHash` binds
it to the single brief definition, excluding runtime status, captured code and
run output (`checkResults`, `inputHashes`).

The next recorded target write resets the collection when the brief changes.
`withTargetWrites` replaces receipts for applied paths and removes those paths
from other tasks' collections. It also removes prior receipts for the failed
path of a partial or failed result. It does not invalidate receipts before a
write.

Historical `promotionAttempts` remain available for review, but never
authorize current ownership. Historical receipts do not prove current contents.
Direct workspace writes have separate completion evidence in
`review-changes.json`.

A promotion whose target changed from the acquisition baseline but now matches
the staged entry takes no write and gains no receipt. Staged promotion still
sets `created: true` on `appliedFiles` when a write creates a target that the
acquisition baseline proves absent. The evidence schema still accepts this flag
in `promotedFiles` and `promotionAttempts`. `withTargetWrites` does not copy the
flag into `apiCreatedPaths`.

`provenCreatedPaths` reads retained `apiCreatedPaths` and creation entries from
`apiApply.applied`. An entry proves creation when `action` is `create`,
`beforeSha256` is null, and its path is absent from `revertedPaths`. The receipt's
`workspacePath` must be absent or match the requested workspace. Checkout
recovery calls `recordApiRevertEvidence` to mark applied paths as reverted. Those
applied entries no longer prove creation; retained `apiCreatedPaths` stay
unchanged.

`recordApiApplyEvidence` and `withTargetWrites` retain existing `apiCreatedPaths`
and creations from an `apiApply` receipt without `workspacePath`.
Both call `provenCreatedPaths` without a workspace argument.
An API result recorded without `workspacePath` also adds its new creations there.
A receipt with `workspacePath` proves creation only while it is the current
`apiApply` for the same workspace. The next recorded API result replaces that
receipt. These calls do not retain that receipt's creations in `apiCreatedPaths`.

`recordedApiCreatedPaths` reads available creation proof for later build and
retry calls. They pass it as `createdByThisTask` so an API attempt can modify
its own created anchor. The creation check does not read `created: true` from
promotion receipts. A missing or unreadable ledger supplies no creation proof.

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
    durationMs?: number;        // the same value as the brief's task_completed.duration
    changedFiles: string[];
    validation: Array<{ stage: 'typecheck' | 'lint' | 'test'; passed: boolean; // only an older ledger writes stages; a new entry writes []
                        skipped?: boolean; skippedReason?: string; errorSummary?: string }>;
    checks?: Array<{             // one entry per brief check, plan check, task check or reviewer check run
      id: string;                // the check id, such as V1; only an older ledger holds stage ids
      command?: string;
      exitCode?: number;
      output?: string;           // bounded, redacted tail
      preExisting?: string[];    // failure keys the same reviewer command also shows at the run base
      base?: { exitCode?: number; output?: string };  // a returned base re-run result: its exit code and bounded output
      artifacts?: Array<{ path: string; sha256: string }>;
      workspaceSnapshotId?: string;
      ts: string;
    }>;
    expectedEvidence?: string[];  // retired; an older file's value loads and is ignored
    observedEvidence?: string[];  // retired; an older file's value loads and is ignored
    escalated: boolean;
    // hashTaskBrief([task]) of the brief whose work the entry last recorded. A seed carries null.
    // A ledger written before this rule keeps whole-plan stamps, and its briefs read as earlier work.
    // Absent on sessions written before this spec; readers treat absent and `null` identically.
    briefHash?: string | null;
    promotedBriefHash?: string; // hashTaskBrief([task]) of the brief that wrote promotedFiles
    promotedFiles?: Array<{ path: string; sha256: string | null; mode: number | null; created?: true }>;  // latest target writer receipt per path; API workspace results use apiApply; null digest and mode = deleted
  }>;
  validationSummary: { passed: number; failed: number; skipped: number; escalated: number };
  finalReview?: { path: string; status: 'written' | 'failed' | 'skipped' };
  reviews?: Array<{
    scope: 'task' | 'final';
    afterTaskId?: TaskId;
    cycle: number;
    outcome: 'pass' | 'pass-with-notes' | 'fail';
    blocking: Array<{ id: string; text: string }>;
    at: string;
  }>;
  briefHash?: string | null;  // the plan-level hash, hashTaskBrief(state.tasks); absent and `null` read the same
};
```

### Check kinds and policy

Any base-tree preparation failure, including directory creation, listing stale trees, checkout, submodule initialization, snapshot reconciliation or dependency linking, settles the base row as *not verified at the run base* with its error. The reviewer decides and the check has no `base` field. A cleanup failure during preparation appears alongside the original error. Cleanup failure after a completed base command settles the row as *not verified at the run base*, with the cleanup error visible. The review continues; its keys stay unverified and the check has no `base` field, even though the command completed. Callback errors propagate unchanged; cleanup failures alongside them are reported as warnings. Every base re-run sweeps dead-PID trees, including runs with no base commit. Registered trees are removed individually in their owning repository with `git worktree remove --force <dir>`; unrelated registrations and older names without a PID stay untouched. A tree whose `.git` file names a missing gitdir is deleted from disk because its registration is gone. A stale tree that cannot be removed is a warning that names it; the sweep and the current base re-run continue and compare keys as usual, so one broken leftover cannot block later base re-runs. See [Troubleshooting](./TROUBLESHOOTING.md#symptom-the-base-re-run-is-red-although-the-same-commit-passes-in-your-checkout) for one-time manual removal of those older trees.

A check is one of three kinds. A `test` check runs the named test file or pattern through the resolved test command (`resolveTestCommand`) and the stack's narrowing; on this repository that is `npm test -- <file>`, which finds only unit files, so an integration test is a `cmd` check (`npm run test:integration -- <file>`). A `package.json` test script that chains commands is not narrowed (`resolveTestTarget`): the check runs `npm test` as written, and a `cmd` check that runs the test runner on the file directly (`node --test <test file>`, `npx --no-install vitest run <test file>`) runs one test file. A `cmd` check runs its value as a command: `npm run <script>` is allowed only under an approved plan and only when `package.json` defines the script, `npx` is allowed only as `npx --no-install <stack tool>`, and `test` is allowed only as `test -e`, `-f`, `-x` or `-L` on one relative workspace file, which checks a file mode or a symbolic link. `checkCommandRefusal` (`src/engine/orchestrator/planning/sanitize-discovered-validation.ts`) decides this, and `checkPlan` sends a plan back to the planner when a `cmd` check fails the text part of that policy (`refused-check-command`); `planApprovesNpmScripts` reads the configured approval level and the run's recorded plan approval, and without approval every other command falls to `unsafeCommandReason`. The plan card lists approved `npm run` checks as confirmations (`planConfirmations`, `src/engine/orchestrator/approval/confirm.ts`). A `render` check runs the user's `validation.render` command — `{id}` is the check's value, one argv element matching `^[a-z0-9-]+$`, and `{out}` is a fresh directory under `<workspace>/.test-artifacts/ui/`, with cwd the workspace; it is not filtered by the planner command policy. Every `.png` under `{out}` is copied to `.splitbrief/sessions/<id>/renders/<check-id>/` and logged with its sha256. With no `validation.render` the check is `not-runnable` with `validation.render is not set`.

A check's status is `pass`, `fail`, `not-runnable`, `refused` or `unknown`. `checkResults`, the `checks_run` event and the evidence ledger record that status, so a check that did not run is neither a pass nor a failure. A brief's check that did not run gets a `refused` or not-run row with its reason, and the review prompt and its Checks Log mark it `refused` or `not-runnable`. A required check that cannot run — any status but `pass` or `fail` — halts before the review with `required-checks-unrunnable`, listing every check id; it never becomes a fix task. A required check that ran and failed reaches the reviewer as a pending `defect` input. The brief gate follows `workflow.review`. End cadence runs no check for ordinary briefs. Task cadence runs the task's checks and its due checks. A fix task also runs the checks of the red it answers. The final review runs all plan and task checks, including renders. Then the reviewer checks run (`validation.end_checks`): the reviewer chooses up to 6 reviewer checks, recorded as `cmd` checks `V1`, `V2`, … in `state.reviewChecks`, and SPLITBRIEF runs them under the reviewer command policy (`reviewerCommandRefusal`, `src/engine/orchestrator/validation/reviewer-command-policy.ts`), not `checkCommandRefusal`. That policy admits any installed program of any language and refuses only what breaks its danger rules ([CONFIGURATION.md §Reviewer checks](./CONFIGURATION.md#reviewer-checks)). It also refuses a reviewer check whose package script, task file, build wrapper or interpreter script this run changed or the run base does not hold; this refusal does not apply to plan and task checks. With `validation.approve_checks: ask`, a reviewer check runs only after Run all; a skipped plan records `state.reviewChecks.skipped` and registers no check. A refused or not-run reviewer check gets its own row and does not halt the review. The first reviewer check with new failures stops the list. Every new red reaches the reviewer, and so does a red that is not verified at the run base (a timeout, or no failure keys). Each run appends one entry to the task's `checks` log; the review packet prints them under `## Checks Log` with every path read outside the workspace.

A `test`, `cmd` or `render` check whose executable is missing is `not-runnable` with `<executable> not found`. It never becomes `fail` or a pending review input.

The reviewer prompt limits the Checks Log to 30,000 characters for a CLI seat. It selects outside reads first, then the latest execution of each check id if that execution failed. Next, it selects the other latest executions, then earlier failures, then the rest. The log keeps the selected entries in their recorded order. An omission line names the count and the path of `evidence.json`.

If size limits remove the Checks Log, its replacement names `evidence.json` for checks and `session.jsonl` for `isolation_outside_read` warnings. An API seat gets the whole log. The API review packet refuses with `insufficient-context` if the orchestrator cannot assemble the log. It also refuses if the whole input does not fit. Both seats get every `isolation_outside_read` path.

### Summary rollup

`Summary.evidenceSummary` (optional, additive) carries a compact rollup so the
closed run can render counts without re-reading the ledger:

```ts
{
  path: 'evidence.json',
  totalTasks: number,
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

Final-review attribution comes from `review-changes.json`, which records the before/after bytes and mode, or the symlink target, of each entry a passing brief changed in the run workspace, and their brief hashes. The full Git comparison remains workspace context, including unknown edits and independent changes within the same declared file. A missing expected file in the final drift report can mean that the brief's change capture was not recorded, rather than that the file was unchanged. Legacy sessions and direct writes without capture keep that uncertainty visible. The review packet's optional `changes.provenance` describes this evidence without changing the version-1 packet boundary.

### Shape

```ts
type DriftReport = {
  version: 1;
  passed: boolean;       // true when no error-severity findings
  changedFiles: string[];
  expectedFiles: string[];
  findings: Array<{
    severity: 'info' | 'warning' | 'error';
    code:
      | 'out_of_scope_file'
      | 'missing_expected_file'
      | 'orphan_diff'
      | 'missing_evidence'
      | 'failed_task_with_diff';
    taskId?: string;
    file?: string;
    message: string;
  }>;
  briefHash?: string | null;  // absent on sessions written before this spec; readers must treat absent and `null` identically.
};
```

An older report may carry a `score` and `out_of_bounds_text_match` findings. The reader drops those findings (`DriftFindingsSchema`, `src/core/schemas/drift.ts`); nothing reads the score.

### Detection rules

| Code | Severity | Trigger |
|---|---|---|
| `out_of_scope_file` | info | Changed file is outside every brief's declared set: `<file> touched, not suggested by any task.`, or a pre-existing note when the file was already changed before the run started. It never fails drift. |
| `missing_expected_file` | warning | Task is `done` / `escalated` but none of its suggested files is in the diff. |
| `failed_task_with_diff` | error | Task is `failed` but one of its suggested files appears in the diff. |
| `orphan_diff` | error | Diff contains files but every task is `failed` or `skipped`. |
| `missing_evidence` | warning | No current run produces it. An older saved report that has it still loads. |

### Event

The orchestrator publishes a `drift_report` event:

```ts
{ type: 'drift_report'; ts: number; phase: Phase; passed: boolean;
  errorCount: number; warningCount: number; findings?: DriftReport['findings'] }
```
