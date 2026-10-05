# Review format

Use one stateless read-only call per review. The session reviews from the packet when no reviewer is configured.

## Review procedure

1. Select tasks and criteria using references/run-protocol.md for cadence or one-task scope.
2. Run current validation and required checks with references/gates.md.
3. Write the packet below from the current candidate.
4. Spawn one stateless read-only reviewer with references/tool-recipes.md, or review in this session.
5. Use references/run-protocol.md for waiting, with `review` as the task id and the reviewer deadline.
6. Save the typed answer in `review.json` and render `review.md`.
7. Derive the verdict from exact coverage and current evidence using the generated rules below.
8. Send unresolved findings to planner triage in references/recovery.md.

Write review-packet.md with this shape:

<!-- generated: review-packet -->
    # Implementation review

    Read the workspace without editing it. Answer from this packet and the current code.

    ## Approved plan
    <plan.json, completed tasks and the criteria due at this review>

    ## Plan context
    <summary, confirmed decisions with task ids, and criterion text>

    ## Task Briefs
    <completed tasks' Markdown briefs in full; pending tasks listed separately>

    ## Implementation Diff
    <current run diff against the saved baseline, grouped by task>

    ## Changed files
    <per-task changed paths and touchedNotSuggested entries with reasons>

    ## Recorded Validation Output
    <current full-suite output and required checks by id, with commands, exits and artifact paths>

    ## Consults and user answers
    <consult log, triage log, rejected findings with reasons, and user answers>

    ## Instructions
    Check the accepted behaviour, exclusions, edge cases, tests and repository rules.
    Quote recorded output for each validation claim. State when evidence is absent.
    Only registered check ids can verify a criterion. Old evidence cannot verify changed code.
    Pending criteria are pending. Do not report them as a plan gap.
    Render checks are unavailable in these skills. A required render criterion stays unverified.

    ## Typed answer
    Return one JSON object with tasks, criteria and findings.
    Tasks use plan: met, partial or missed. Criteria use status: pass, fail or unverified, with evidence.
    Findings use kind: defect, plan-gap, unverified or question; severity: blocking or minor.
    Use taskId to identify a task. Use checkIds or criterionId for an unverified finding.
    Include exactly one result for each completed task and each criterion due now.
    Use this example shape, with real ids and evidence:

    {"tasks":[{"id":"T001","plan":"met","note":"<evidence>"}],"criteria":[{"id":"C1","status":"pass","evidence":"<recorded proof>"}],"findings":[{"id":"F1","kind":"question","severity":"blocking","taskId":"T001","text":"<question>"}]}

    Use an empty findings array when there are no findings. The session derives the verdict.
<!-- /generated -->

Include approved plan.json, all confirmed decisions, criterion text, relevant briefs and the current run diff.
Group changes by task. Include touchedNotSuggested paths and their reasons, check results, consults, triage and user answers.
Use baseline bytes and hashes for the run diff. Exclude unchanged pre-existing edits and run artifacts.
Save the current full-suite and required-check output with commands, exits, ids and artifact paths.
Reject an oversized packet rather than silently dropping files or evidence.
For a malformed answer, attach the invalid answer and parser errors to the permitted fresh repair call.

## Typed reply and derived pass

Write review.json with tasks, criteria and findings. Render review.md from that answer.

| Field | Typed entries |
|---|---|
| tasks | `{id, plan: met / partial / missed, note}` |
| criteria | `{id, status: pass / fail / unverified, evidence}` |
| findings | `{id, kind: defect / plan-gap / unverified / question, severity: blocking / minor, text}` |
| finding references | taskId, file, line, acceptance, checkIds, criterionId when applicable |

Unverified findings name non-empty valid checkIds or a criterionId with registered checks.
The session never guesses a check from a finding's text. The reviewer cannot supply arbitrary commands.

<!-- generated: verdict-rules -->
- Derive pass: every task met, every criterion pass, no blocking finding.
- Reject missing, duplicated or unknown task and criterion ids. Unverified criteria block pass.
- At task cadence, cover completed tasks and criteria due so far. Pending criteria are pending, never a gap.
- Generic validation does not prove an unrelated criterion. Evidence must cover the current candidate.
- Repair malformed typed output once. A second failure pauses the seat; it produces no verdict.
- Keep minor findings as notes.
<!-- /generated -->

A pass with minor findings is `pass_with_notes`.

## Review by this session

Read review-packet.md and the current workspace in one fresh pass. Never cite memory of earlier attempts.
Write the same typed answer a reviewer CLI would return. Keep every evidence claim tied to the current candidate.
