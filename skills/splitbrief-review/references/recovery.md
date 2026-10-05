# Recovery

The host session remains the planner. It chooses the next action without taking over implementation.
Keep the accepted outcome and durable evidence throughout recovery.
Seat failures use the diagnoses and halt rules in references/tool-recipes.md.

## Answer validation

Validate consult and triage answers against their schemas before applying an action.
Use ConsultAnswerSchema for consults and the typed triage contract below.
If validation fails, send the invalid answer and schema errors in one repair request.
Validate the repaired answer. If it is still invalid, record a planner seat failure and apply no action.
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

A failed post-consult attempt consults again while bounds permit.
A recipe error is seat trouble. Halt with its diagnosis; do not improvise permission flags or change adapters mid-run.

## Planner consult

Consult immediately on proposed decisions before the next dispatch.
Apply confirmed decisions with references/planning.md.
Keep the consult read-only. The planner chooses the next action and never edits implementation code.
Use the same planning session and record the answer with its diagnosis.

<!-- generated: consult-table -->
Attempt → 1 local retry with the exact errors → a planner consult.

| Action | Next step |
|---|---|
| `guidance` | Keep the brief. Attach instructions and context for one more implementer attempt. |
| `rewrite-task` | Replace the TaskSpec at the same id and the same criteria. Raise its revision. |
| `split-task` | Replace with 2–4 subtasks. Keep all criteria. Re-point pending dependents to all children. |
| `verify` | Run the named registered checks and validation. Make no implementer call. |
| `ask-user` | Ask only when the user alone can answer. Record why, choices and a default. |
| `confirm` | Decision-confirm only: record the accepted decisions, then validate the attempt. |

Keep lineage counters across splits and resume: 2 consults and 8 attempts.
Keep the run counter: 10 planner decisions after planning, including consults and triage.
Before dispatch, changed inputs get one stale consult per revision: guidance or rewrite-task.
A stale consult spends no run planner decision. A blocked report consults at once.
A hand-back with new decisions gets one decision-confirm before validation: confirm (how) or ask-user (what).
Decision-confirm runs at most once per attempt, bounded by the brief's attempts.
It spends no run counter, never a lineage consult or a planner decision.
A failed or malformed confirm answer warns, leaves the decisions out of the ledger and validates. It never pauses.
When a bound is spent, pause and keep the work. Ask: continue with a note / skip / end.
Continuing grants 1 more consult and 4 more attempts, or 5 more planner decisions, and replays the brief as a retry with the last failing output.
<!-- /generated -->

The consult input includes the plan, task revisions, attempt diff, exact errors, report, earlier consults and other task statuses.
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

    ## Attempt Diff

    ```diff
    <the diff from the attempt's start snapshot to now>
    ```

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

    The criteria rule: a rewrite or a split never drops a criterion id; a split never splits a subtask. Every criterion id the task serves stays with its replacement, or with the union of the split tasks, and each replacement keeps a complete, verifiable brief. The checks rule: a defective check command may be repaired under the same check id, but a rewrite or a split never drops a check id that one of the task's criteria names; removing the requirement it checks needs `ask-user`.

    The run workspace is `<the run workspace>`. Read project files from this directory and resolve project-relative code paths there.

    Reply with exactly one JSON object that matches this schema: {"type":"object","properties":{"answer":{"anyOf":[{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"guidance"},"instructions":{"type":"string"},"context":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["diagnosis","action","instructions","context"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"rewrite-task"},"task":{"type":"object","properties":{"id":{"type":"string","pattern":"^T\\d{3}$"},"title":{"type":"string"},"intent":{"type":"string"},"criteria":{"type":"array","items":{"type":"string"}},"checks":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["test","cmd","render"]},"value":{"type":"string"},"required":{"type":"boolean"}},"required":["id","kind","value","required"],"additionalProperties":false}},"suggestedFiles":{"minItems":1,"type":"array","items":{"type":"string"}},"contextFiles":{"type":"array","items":{"type":"string"}},"exclusions":{"type":"array","items":{"type":"string"}},"protectedOperations":{"anyOf":[{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"operation":{"type":"string","const":"write"}},"required":["path","operation"],"additionalProperties":false}},{"type":"null"}]},"steps":{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"null"}]},"dependsOn":{"type":"array","items":{"type":"string","pattern":"^T\\d{3}$"}},"batch":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["id","title","intent","criteria","checks","suggestedFiles","contextFiles","exclusions","protectedOperations","steps","dependsOn","batch"],"additionalProperties":false}},"required":["diagnosis","action","task"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"split-task"},"tasks":{"minItems":2,"maxItems":4,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^T\\d{3}$"},"title":{"type":"string"},"intent":{"type":"string"},"criteria":{"type":"array","items":{"type":"string"}},"checks":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["test","cmd","render"]},"value":{"type":"string"},"required":{"type":"boolean"}},"required":["id","kind","value","required"],"additionalProperties":false}},"suggestedFiles":{"minItems":1,"type":"array","items":{"type":"string"}},"contextFiles":{"type":"array","items":{"type":"string"}},"exclusions":{"type":"array","items":{"type":"string"}},"protectedOperations":{"anyOf":[{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"operation":{"type":"string","const":"write"}},"required":["path","operation"],"additionalProperties":false}},{"type":"null"}]},"steps":{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"null"}]},"dependsOn":{"type":"array","items":{"type":"string","pattern":"^T\\d{3}$"}},"batch":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["id","title","intent","criteria","checks","suggestedFiles","contextFiles","exclusions","protectedOperations","steps","dependsOn","batch"],"additionalProperties":false}}},"required":["diagnosis","action","tasks"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"verify"},"checkIds":{"type":"array","items":{"type":"string"}},"reason":{"type":"string"}},"required":["diagnosis","action","checkIds","reason"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"ask-user"},"question":{"type":"string"},"whyOnlyUserCanAnswer":{"type":"string"},"choices":{"anyOf":[{"type":"array","items":{"type":"string"}},{"type":"null"}]},"default":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["diagnosis","action","question","whyOnlyUserCanAnswer","choices","default"],"additionalProperties":false},{"type":"object","properties":{"diagnosis":{"type":"string"},"action":{"type":"string","const":"confirm"},"decisions":{"type":"array","items":{"type":"object","properties":{"what":{"type":"string"},"why":{"type":"string"}},"required":["what","why"],"additionalProperties":false}}},"required":["diagnosis","action","decisions"],"additionalProperties":false}]}},"required":["answer"],"additionalProperties":false}. No prose after it.

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

## Finding triage

The session answers typed triage as `{fixTasks, rejected, verify, ask}`.
fixTasks are complete TaskSpecs with new ids. rejected entries use findingId and reason.
verify entries use findingId and registered checkIds. ask is null or a user-only question with whyOnlyUserCanAnswer.
Route blocking findings by kind:

| Kind | Planner action |
|---|---|
| defect | Append a fix task for the concrete code or test defect. |
| plan-gap | Append a task within the accepted outcome; ask the user before changing what is built. |
| unverified | Run the registered checks on the current candidate. Unavailable required checks block pass. |
| question | Answer from the plan and code first. Ask the user only when the planner cannot answer. |

Never route by a path substring or assign an unmatched finding to the last task.
Save the typed answer in `triage.json`. Carry rejected finding ids and reasons into the next review packet.
Use references/planning.md and references/brief-format.md to admit and render complete fix briefs.
Use references/run-protocol.md to execute authorized fixes and prepare a fresh review.
Before starting a fix cycle, persist its allowance use. Never charge the same saved cycle twice on continuation.

<!-- generated: fix-cycle -->
- Send blocking findings to the session for triage. Append fix tasks with new ids; done tasks stay done.
- Run registered checks for unverified findings. Answer question findings as the planner before asking the user.
- Keep criteria when repairing a check command. Ask the user before changing the accepted outcome.
- Allow 2 fix cycles across the run, up to 3 reviews at end cadence. Task cadence adds reviews and shares this fix cap.
- Prepare each fresh review with references/gates.md.
- After the cap, pause for the user. Preserve open findings and never claim verification passed.
<!-- /generated -->

When the cap is spent, show remaining findings and ask whether to fix again with a note, accept as is, or end.
An explicit extra cycle adds one recorded allowance. Acceptance records an override, never a verified pass.
Standalone review writes triage and new briefs; it never edits source or executes the fixes itself.
