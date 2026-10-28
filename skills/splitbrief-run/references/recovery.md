# Recovery

The host session remains the planner. It chooses the next action without taking over implementation.
Keep the accepted outcome and durable evidence throughout recovery.
Seat failures use the diagnoses and halt rules in references/tool-recipes.md.

## Answer validation

Validate consult and review answers against their schemas before applying an action.
Use ConsultAnswerSchema for consults and ReviewAnswerSchema for the complete review answer.
If validation fails, send the invalid answer and schema errors in one repair request.
Validate the repaired answer. If it is still invalid, record a failure of the seat that answered and apply no action.
Use references/tool-recipes.md for seat recovery.
A direct writer's completion report follows the contract in references/implementer-prompt.md (Completion report); the one recovery rule here: it receives no repair request.

## Retry

Construct retry prompts with the exact errors, commands, and output.
Keep the task's criteria and brief. Do not replace errors with a paraphrase.
Use this shape:

    <preamble>
    Your previous attempt had an error. Fix it:
    Error from previous attempt:
    <exact error output>
    <fresh brief and Plan context>
    <closing line and report contract>

A fix brief's first retry asks it to fix only what the error names as its own.
Failures the error names as not this brief's job go to their fix tasks or the next review.

A failed post-consult attempt consults again while bounds permit.
A recipe error is seat trouble. Halt with its diagnosis; do not improvise permission flags or change adapters mid-run.

## Task consult

Consult immediately on proposed decisions before the next dispatch.
Apply confirmed decisions with references/planning.md.
Keep the consult read-only. The seat that owns the task chooses the next action and never edits implementation code.
Plan tasks use the planner's session. Fix tasks use the reviewer with the full fix context and no session.
Decision-confirm stays with the planner. Record each answer with its seat and diagnosis.

<!-- generated: consult-table -->
Attempt → 1 local retry with the exact errors → a consult.
A plan task consults the planner. A fix task the reviewer wrote consults the reviewer, also after a rewrite or a split.
Every decision-confirm stays with the planner.
The planner continues its planning session. The reviewer reads the full fix context without a session.
Record a malformed answer as a failure of the seat that answered. Apply no action.

| Action | Next step |
|---|---|
| `guidance` | Keep the brief. Attach instructions and context for one more implementer attempt. |
| `rewrite-task` | Replace the TaskSpec at the same id and the same criteria. Raise its revision. |
| `split-task` | Replace with 2–4 subtasks. Keep all criteria. Re-point pending dependents to all children. |
| `verify` | Run the brief gate and named registered checks. Make no implementer call. |
| `ask-user` | Ask only when the user alone can answer. Record why, choices and a default. |
| `confirm` | Decision-confirm only: record the accepted decisions, then run the brief gate. |

Keep lineage counters across splits and resume: 2 consults and 8 attempts.
Keep the run counter: 10 planner decisions after planning. Reviewer consults and review answers spend no planner decision.
Before dispatch, changed inputs get one successful stale consult per revision: guidance or rewrite-task.
A stale consult spends no run planner decision. A blocked report consults at once.
A thrown or malformed stale consult halts on the seat that answered. Never dispatch the unchanged brief.
A guarded rewrite or split asks the operator on the consulted seat before dispatch.
An unanswered stale guard question halts on that seat, keeps input hashes unchanged, and dispatches no implementer.
A failed stale call, malformed answer or unanswered guard leaves the stale revision marker unchanged. Retry consults the same seat before dispatch.
Successful stale guidance records fresh input hashes and marks the revision in one transition. A rewrite records hashes on its new revision.
An answered stale guard question records fresh input hashes and sends the operator's answer as guidance on the first attempt.
A hand-back with new decisions gets one decision-confirm before validation: confirm (how) or ask-user (what).
The confirm names the accepted decisions by id (d1, d2, …). A decision whose id it leaves out is rejected. The attempt retries with the diagnosis and never validates.
Decision-confirm runs at most once per attempt, bounded by the brief's attempts.
It spends no run counter, never a lineage consult or a planner decision.
A failed or malformed confirm answer warns, leaves the decisions out of the ledger and validates. It never pauses.
When a bound is spent, halt as needs you and keep the work. Ask: continue with a note / skip / end.
Continuing grants 1 more consult and 4 more attempts, or 5 more planner decisions, and replays the brief as a retry with the last failing output.
<!-- /generated -->

The consult input includes the plan, task revisions, the task diff since the task started (every attempt, not only the latest: the diff of the brief's own files, and the names of the other files the task changed: the first 20, then a count of the rest), one line per failed attempt, the latest exact errors, report, earlier consults and other task statuses.
Use this typed engine contract. Register no render checks despite their presence in the engine schema.

<!-- generated: consult-contract -->
    # Consult on a failing task

    One task of this run did not land, and SPLITBRIEF asks you to decide T001's next step from the evidence below.

    ## Plan
    ### Criteria
    - **<C1>**: <what the criterion verifies> — checks: <K1>

    ### Checks
    - `<K1>` (test `<the check file or command>`)

    ### Decisions
    None.

    ## Task T001 (revision 1)
    **Title**: <title>
    **Action**: create
    **Files**: `<file>`
    **Depends on**: nothing
    **Criteria**: none recorded

    ### Description
    <the brief's Description>
    **Tests:**
    - <the brief's Tests bullets>
    **Constraints:**
    - <the brief's Constraints bullets>

    ## Reason
    failed — The task failed: its last attempt or one of its checks did not pass.

    ## Task Diff

    What is on disk now against the start of this task, for the files of this brief: the changes of all its attempts, revisions and split subtasks, not only the latest attempt.

    ```diff
    <the diff from the task's start to now>
    ```

    This task also changed other files, not shown here: `<other changed file>`. Read these files in the run workspace.

    ## Failed Attempts

    Each failed attempt of this task, oldest first, with its first error line.

    - Attempt 1 (T001 revision 1): <the first error line of that attempt>

    ## Failing Output

    ```
    <gate tail>
    ```

    ## Implementer Report

    ```
    Files changed: <file>
    Touched not suggested: none
    Decisions: none
    Notes: none
    ```

    ## Instructions
    You are the run's planner. SPLITBRIEF asks you, not the user, for the decision that unblocks this task. This call is read-only: do not write, edit or delete any file, and do not run commands that change the project.

    Answer with exactly one JSON object `{ "answer": { "diagnosis": …, "action": … } }`. `answer.diagnosis` states what actually went wrong, in one or two sentences, and is always present. Exactly one action follows it:
    - `guidance` — `instructions` the implementer retries with, and `context`: the project file or fact the retry needs attached, or null. The brief is kept.
    - `rewrite-task` — `task`: one complete replacement TaskSpec that fixes the brief itself.
    - `split-task` — `tasks`: 2 to 4 complete TaskSpecs that together replace the task.
    - `verify` — `checkIds` and `reason`: re-run exactly those checks before any retry, for when the failure may predate this task's own edits.
    - `ask-user` — `question`, `whyOnlyUserCanAnswer`, `choices` (or null) and `default` (or null): only when no other action can unblock the task and the user alone holds the missing decision.

    The operator rule: the Operator Instructions are the user's own decisions for this task. No action undoes one of them. A question that concerns one of them quotes it, and its default keeps it.

    The answer rule: SPLITBRIEF gives the user's answer to an `ask-user` question to the same implementer, as an instruction for its next attempt. An answer cannot change a seat's tool or model, buy credits, or wait for a limit to reset. Offer only choices that the next attempt can carry out. When the seat cannot serve the call at all, say so in `answer.diagnosis`: the user changes a seat with `/crew`.

    The criteria rule: a rewrite or a split never drops a criterion id; a split never splits a subtask. Every criterion id the task serves stays with its replacement, or with the union of the split tasks, and each replacement keeps a complete, verifiable brief. The checks rule: a defective check command may be repaired under the same check id, but a rewrite or a split never drops a check id that one of the task's criteria names; removing the requirement it checks needs `ask-user`. A `cmd` check follows the plan check policy, with no shell operator. A package manager runs only its bare `test`, or `npm run <script>` for a script `package.json` defines when the user approved the plan. `make` or `just` runs only one bare `typecheck`, `lint` or `test` target. A test runner, linter or type checker of the project's stack, such as `vitest`, `tsc`, `pytest`, `go` or `cargo`, runs directly with its arguments. `node` runs only as `node --test <test file>` or `node --check <file>`. `npx` runs only as `npx --no-install <stack tool>`. As a `cmd` check, `test -e <file>`, `test -f <file>`, `test -x <file>` and `test -L <file>` check that a file exists, is a regular file, is executable or is a symbolic link; use them to check a file mode or a symbolic link instead of a new test file. SPLITBRIEF refuses any other command, such as `grep` or `node build.js`, and sends the refusal back for one repair. Prefer a `test` check that names a test file. A `test` check's value is one test file path, never a command.

    The run workspace is `<the run workspace>`. Read project files from this directory and resolve project-relative code paths there.

    Reply with exactly one JSON object that matches this schema: {"type":"object","properties":{"answer":{"anyOf":[{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"guidance"},"instructions":{"type":"string"},"context":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["diagnosis","action","instructions","context"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"rewrite-task"},"task":{"type":"object","properties":{"id":{"type":"string","pattern":"^T\\d{3}$"},"title":{"type":"string"},"intent":{"type":"string"},"criteria":{"type":"array","items":{"type":"string"}},"checks":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["test","cmd","render"]},"value":{"type":"string"},"required":{"type":"boolean"}},"required":["id","kind","value","required"],"additionalProperties":false}},"suggestedFiles":{"minItems":1,"type":"array","items":{"type":"string"}},"contextFiles":{"type":"array","items":{"type":"string"}},"exclusions":{"type":"array","items":{"type":"string"}},"protectedOperations":{"anyOf":[{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"operation":{"type":"string","const":"write"}},"required":["path","operation"],"additionalProperties":false}},{"type":"null"}]},"steps":{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"null"}]},"dependsOn":{"type":"array","items":{"type":"string","pattern":"^T\\d{3}$"}},"batch":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["id","title","intent","criteria","checks","suggestedFiles","contextFiles","exclusions","protectedOperations","steps","dependsOn","batch"],"additionalProperties":false}},"required":["diagnosis","action","task"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"split-task"},"tasks":{"minItems":2,"maxItems":4,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^T\\d{3}$"},"title":{"type":"string"},"intent":{"type":"string"},"criteria":{"type":"array","items":{"type":"string"}},"checks":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["test","cmd","render"]},"value":{"type":"string"},"required":{"type":"boolean"}},"required":["id","kind","value","required"],"additionalProperties":false}},"suggestedFiles":{"minItems":1,"type":"array","items":{"type":"string"}},"contextFiles":{"type":"array","items":{"type":"string"}},"exclusions":{"type":"array","items":{"type":"string"}},"protectedOperations":{"anyOf":[{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"operation":{"type":"string","const":"write"}},"required":["path","operation"],"additionalProperties":false}},{"type":"null"}]},"steps":{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"null"}]},"dependsOn":{"type":"array","items":{"type":"string","pattern":"^T\\d{3}$"}},"batch":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["id","title","intent","criteria","checks","suggestedFiles","contextFiles","exclusions","protectedOperations","steps","dependsOn","batch"],"additionalProperties":false}}},"required":["diagnosis","action","tasks"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"verify"},"checkIds":{"type":"array","items":{"type":"string"}},"reason":{"type":"string"}},"required":["diagnosis","action","checkIds","reason"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"ask-user"},"question":{"type":"string"},"whyOnlyUserCanAnswer":{"type":"string"},"choices":{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"null"}]},"default":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["diagnosis","action","question","whyOnlyUserCanAnswer","choices","default"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"confirm"},"decisionIds":{"type":"array","items":{"type":"string"}}},"required":["diagnosis","action","decisionIds"],"additionalProperties":false}]}},"required":["answer"],"additionalProperties":false}. No prose after it.

The guidance of a `guidance` or `ask-user` answer is appended to the failed attempt's error block, not prefixed to it:

    <gate tail>

    ## Guidance from the planner:
    <the instructions and context>

The composed error block is truncated to 4000 characters.

Attach Plan context: the summary, confirmed decisions with task ids, and the task's criterion text.
Attach proposed decisions from the report.
<!-- /generated -->

Use new free task ids for children. Record their lineage root. The current engine does not split an existing subtask.
Compare suggested/context input hashes before dispatch.
For changed inputs, apply a stale consult to that task and record fresh hashes after refreshing it.
Use references/gates.md for selected verification checks. Green selected checks can complete the task; review still applies.
Ask-user includes why only the user can answer, choices and a default. Feed the answer back as guidance.

Rollback, when needed for rewrite or split, restores only the current attempt's own changed bytes.
Never restore an earlier task's snapshot over accepted changes. Never use a git write command for rollback.

Record each consult in `consults.jsonl` and `evidence.md`, including diagnosis, action, and its counter effect.
Persist lineage roots, revisions, consults, attempts, run decisions, fix cycles, and extra allowances in saved progress.

## Review fix work

The reviewer returns tasks, criteria, findings, fixTasks, rejected, verify and ask in one review answer.
The session saves the whole answer in `review.json`. It makes no separate planner call for fix work.
The session writes no new `triage.json`.

On continuation, use the fix part from `review.json` when present.
If absent, read `fixTasks`, `rejected`, `verify` and `ask` from an older run's saved `triage.json`.
Use those fields as that review's fix part without a planner call.
Run the review again only when neither file holds a fix part.

fixTasks are complete TaskSpecs with new ids and findingIds. rejected entries use findingId and reason.
verify entries use findingId and registered checkIds. ask is null or a user-only question with question and whyOnlyUserCanAnswer.
At task cadence, pending criteria stay pending.
SPLITBRIEF records a finding outside the task review scope as a note and refuses fix work for it.
The reviewer addresses blocking findings inside the scope by kind:

| Kind | Reviewer action |
|---|---|
| defect | Append a fix task for the concrete code or test defect. |
| plan-gap | Append a task within the accepted outcome; ask the user before changing what is built. |
| unverified | Run the registered checks on the current candidate. Unavailable required checks block pass. |
| question | Answer from the plan and code first. Ask the user only when the user holds the missing decision. |

Never route by a path substring or assign an unmatched finding to the last task.
Carry rejected finding ids and reasons from the saved fix part into the next review packet.
Use references/planning.md and references/brief-format.md to admit and render complete fix briefs.
Use references/run-protocol.md to execute authorized fixes and prepare a fresh review.
Before starting a fix cycle, persist its number and the blockers it fixes. Never start the same saved cycle twice on continuation.

<!-- generated: fix-cycle -->
- Read fixTasks, rejected, verify and ask from the saved review fix part. Append fix tasks with new ids; done tasks stay done.
- Run registered checks for unverified findings. The reviewer answers question findings from the plan and code before asking the user.
- Keep criteria when repairing a check command. Ask the user before changing the accepted outcome.
- Run fix cycles until the review passes, at end and at task cadence.
- Prepare each fresh review with references/gates.md.
- When a review answer fixes nothing, or a fix cycle leaves the same blockers, halt as needs you and name them. Preserve open findings and never claim verification passed.
<!-- /generated -->

When the review halts, show the remaining findings and ask whether to fix again with a note, accept as is, or end.
Fix again with a note starts one more fix cycle. Acceptance records an override, never a verified pass.
Standalone review saves the complete review answer and new briefs. It never edits source or executes the fixes itself.
