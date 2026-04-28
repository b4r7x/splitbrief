# Specification

## User Stories

### Story 1: Readiness At A Glance

As a user reviewing Task Briefs before implementation, I want a compact scorecard so I can tell whether the plan is ready without reading every task line.

Acceptance:

- The scorecard appears in both simple Brief Review and rich Plan Editor.
- It shows counts for:
  - `ready`
  - `routing pending`
  - `needs split/overflow`
  - `risky/tight`
  - `stale/conflict`
  - `missing validation/evidence`
- Counts update after tasks are loaded, edited, saved, or routing metadata is refreshed.

### Story 2: Spot Work That Will Fail Cheap Context

As a user using local or cheap implementers, I want overflow and tight-context tasks called out before approval so I can split, reroute, or regenerate them before spending tokens.

Acceptance:

- `overflow` tasks are counted under `needs split/overflow`.
- `tight` tasks are counted under `risky/tight`.
- Tasks with missing, stale, pending, or unknown routing/context fit metadata are counted under `routing pending` and are not shown as ready.
- Missing current code for a modify task is counted as risky and stale/missing context.
- A task with no capable worker profile is not shown as ready.

### Story 3: Inspect The Worker Packet

As a user, I want to preview the exact prompt/context shape the cheap implementer will receive for the selected task so I can trust what will happen after approval.

Acceptance:

- Rich Plan Editor has a read-only Worker Packet Preview for the selected task.
- The preview is optional and can be toggled without changing task content.
- It includes:
  - selected worker profile and cost tier,
  - required write mode and selected write mode when known,
  - context fit and token estimate,
  - context length,
  - current-code reduction mode (`none`, `whole-file`, `function-level`, `truncated`),
  - system preamble preview,
  - task prompt preview.
- The preview is generated from the same formatter/routing inputs as worker dispatch.

### Story 4: See Trust Gaps Without New Project Management

As a user, I want readiness warnings to be execution-focused rather than plan-management-focused, so the review surface stays narrow and actionable.

Acceptance:

- No lanes, kanban columns, archive views, assignment fields, or cross-plan dependency fields are introduced.
- Scorecard categories are derived from current-session Task Briefs and execution metadata only.
- Durable sessions remain execution/session history; this feature must not turn them into plan archive or project-management tooling.
- The user can still approve, edit, comment, reject, and save exactly as before.

## Functional Requirements

### Scorecard

- Derive scorecard counts from:
  - parsed `Task[]`,
  - `BriefQualityReport.issues`,
  - `PlanTaskReviewMetadata`,
  - routing preview decisions, including freshness/checkpoint information when available.
- Classify a task as `ready` only when:
  - no error-level brief-quality issue exists,
  - fresh routing metadata exists for the current task content,
  - context fit is known and `fits`,
  - worker profile is selected,
  - validation is present and not `fail`,
  - evidence is present,
  - stale and conflict metadata are absent.
- Classify a task as `routing pending` when:
  - no metadata entry exists for the task,
  - routing metadata is stale, pending, or tied to an older task checkpoint,
  - context fit is missing or unknown,
  - selected worker profile is unknown because routing has not completed,
  - token estimate status is pending or unavailable for the current task content.
- Classify a task as `needs split/overflow` when:
  - `metadata.contextFit === 'overflow'`,
  - no capable worker profile exists because every profile overflows,
  - a brief-quality issue indicates non-atomic or multi-file work.
- Classify a task as `risky/tight` when:
  - `metadata.contextFit === 'tight'`,
  - `metadata.risk === 'high'`,
  - `metadata.validationStatus === 'warn'`,
  - the selected route used truncated or function-level current-code reduction and the untruncated estimate would not fit.
- Classify a task as `stale/conflict` when:
  - `metadata.stale === true`,
  - `metadata.conflict` is present,
  - current code could not be refreshed for a modify task.
- Classify a task as `missing validation/evidence` when:
  - `task.tests.length === 0`,
  - `task.evidence` is absent or empty,
  - brief-quality issues include `missing_validation`, `vague_validation`, or `missing_evidence`.
- `routing pending` and `unknown fit` are trust gaps. They may overlap with other warning buckets, but they must never contribute to the green-ready count.
- Counts are not mutually exclusive except `ready`; a non-ready task may increment multiple warning buckets.
- The scorecard should prefer short terminal labels and stable order:
  - `ready N`
  - `routing pending N`
  - `split/overflow N`
  - `risky/tight N`
  - `stale/conflict N`
  - `missing checks N`

### Worker Packet Preview

- Preview is read-only and selected-task scoped.
- Preview should be available only in rich Plan Editor for v1; simple Brief Review can defer it.
- It must not mutate `tasks.md`, `state.json`, config, or session artifacts.
- It should use `formatTaskPrompt`, `SYSTEM_PREAMBLE`, token estimation, and routing metadata instead of duplicating prompt construction.
- If current code is refreshed for preview, it should use the same refresh policy already used by routing preview.
- The preview should clearly distinguish:
  - full dispatch shape,
  - terminal-truncated display,
  - redacted sensitive-looking lines.
- It should not expose environment variables or secrets in full if they appear in current code or task text. Redact common secret patterns conservatively.
- It should show truncation markers and token counts so users understand the packet shape is larger than the visible terminal panel.

## Edge Cases

- Empty task list: scorecard shows zero counts and no preview.
- Metadata pending: affected tasks increment `routing pending`, do not increment `ready`, and still reflect task validation/evidence and brief-quality issues.
- Edited unsaved tasks: scorecard recalculates from in-memory tasks; preview should either reflect in-memory state or show a clear `save/refresh required` status. Prefer in-memory preview if implementation can reuse existing parsing safely.
- Deleted selected task: preview closes or switches to the next selected task.
- Very narrow terminal: scorecard compacts to one line or wraps across two lines; task rows should remain readable.
- Very small terminal height: preview is hidden or reduced before it crowds out the task list.
- Missing target file for `modify`: scorecard marks stale/missing context; preview shows no current code and the estimate status.
- No implementer profile can write required scope: scorecard marks split/overflow or risky depending on rejection reason; preview shows rejected profiles if there is room.
- Secret-looking content in task/current code: visible preview redacts values while keeping section structure.

## Key Entities

- `PlanReviewScorecard`: derived view model with counts and task ids per bucket.
- `PlanReviewScorecardBucket`: `ready | routingPending | splitOverflow | riskyTight | staleConflict | missingChecks`.
- `WorkerPacketPreview`: derived view model for selected task, routing decision, prompt text, token estimates, context fit, and redaction/truncation flags.
- `PlanTaskReviewMetadata`: existing store metadata for worker, cost tier, context fit, estimate status, routing reason, validation, risk, stale, conflict, and checkpoint.
- `RoutingDecision`: existing context-routing output with selected profile, rejected profiles, write mode, fit, token estimates, and current-code mode.

## Success Criteria

- A user can decide whether to approve or edit the plan faster from the scorecard alone.
- A user can inspect a selected task and understand what the cheap implementer will receive before approving.
- Overflow/tight/stale/missing-check cases are visible before implementation.
- Unknown or stale routing/context fit never appears as green-ready.
- Future code remains aligned with diptych's core identity: expensive planner creates executable briefs, cheap implementer receives bounded fresh context, diptych guards safety and trust.
