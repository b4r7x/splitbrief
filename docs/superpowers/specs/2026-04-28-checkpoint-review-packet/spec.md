# Spec: Checkpoint / Restore UX + Post-run Review Packet

## Summary

Make existing run safety artifacts visible and actionable. Diptych should present checkpoints as trustworthy session milestones and produce a final review packet that a human can use for local review or PR preparation.

The feature does not add a plan archive. All data belongs to one execution session under `.diptych/sessions/{sessionId}/`.

## Terminology

| Term | Meaning |
|---|---|
| Snapshot | Existing storage primitive under `.diptych/sessions/{sessionId}/snapshots/`. |
| Checkpoint | User-facing name for a meaningful snapshot in a run: manual, pre-task, post-task, pre-final-review, accepted-run, or run-ledger snapshot. |
| Restore | Hash-guarded rewrite from a snapshot/checkpoint. Conflicts are skipped unless the user explicitly passes `--force`. |
| Review packet | End-of-run session artifact that aggregates summary, final planner review, evidence, drift, checkpoints, validation, recovery decisions, escalations, cost/routing, and a reviewer checklist. |

## User Stories

1. As a user finishing a run, I want to see the checkpoints created during the run so I know where I can inspect, diff, or restore.
2. As a user considering restore, I want diptych to explain what will be overwritten, what is conflicted, and what command performs the action.
3. As a PR author, I want one packet that summarizes what changed, what was validated, what drifted, and what a reviewer should inspect.
4. As a reviewer, I want a stable Markdown packet and machine-readable JSON that point to the underlying session artifacts.
5. As a maintainer, I want this to remain session history, not a plan archive or PM system.

## Product Behavior

### Checkpoint Visibility

Checkpoint visibility is layered over the existing snapshot system.

Required checkpoint fields:

- `id`: snapshot ID.
- `name`: manifest name when present, such as `pre-task-0`, `post-task-0`, `pre-final-review`, or `accepted-run`.
- `createdAt`: ISO timestamp from the manifest.
- `phase`: snapshot phase.
- `taskIndex`: optional task index from the manifest.
- `trackedFileCount`: file count from the manifest.
- `kind`: display kind: `manual`, `pre-task`, `post-task`, `pre-final-review`, `accepted-run`, or `other`. Prefer run-ledger classification when available.
- `inferredKind`: optional name-derived display fallback when the run ledger is missing or does not classify the snapshot. This can be derived from names such as `pre-task-0`, but must be labeled/treated as inferred.
- `restoreCommand`: exact CLI command using snapshot ID.
- `diffCommand`: exact CLI command using snapshot ID.
- `isRunCheckpoint`: true only when the snapshot ID is recorded in `run-ledger.json`. Do not infer this from names; a manual snapshot can be named like an auto checkpoint.
- `safety`: display metadata describing that restore is hash-guarded and conflicts are skipped by default.

Baseline snapshots remain internal and are not shown in normal user lists.

### Restore Trust UX

Restore remains explicit. This spec does not add automatic restore after final review and does not make `/reject-run` broader than its existing run-ledger behavior.

User-facing restore surfaces should communicate:

- Restore command: `diptych snapshot restore SNAPSHOT_ID`.
- Preview command: `diptych snapshot diff SNAPSHOT_ID`.
- Conflict rule: files modified since the checkpoint are skipped by default.
- Force rule: `--force` overwrites conflicts and must be called out as destructive.
- Partial restore rule: restoring safe files while listing conflicts is expected behavior.
- Scope rule: `.git/`, `.diptych/`, `node_modules/`, and `.trees/` are excluded from snapshot storage.

The UI should not hide the CLI command. A terminal user should be able to copy the exact command or retype it from the summary.

### Post-run Review Packet

At the end of a run, diptych should write:

```text
.diptych/sessions/{sessionId}/review-packet.json
.diptych/sessions/{sessionId}/review-packet.md
```

`review-packet.json` is canonical for machine reads. `review-packet.md` is the human/PR review artifact.

The packet is generated from existing session artifacts and deterministic state where possible:

- `summary.json`
- `review.md`
- `evidence.json`
- `drift-report.json`
- `drift-chains.json` when present
- `brief-quality.json` when present
- `state.json`
- snapshot manifests under `snapshots/`
- `snapshots/run-ledger.json` when present
- session events from `session.jsonl` when needed for retries, escalations, warnings, approvals, and restore events
- recovery state/events from `state.json`, `session.jsonl`, and evidence when Recovery Flow is implemented or partially present

The packet should not invent confidence. If an artifact is missing, the packet records that it was unavailable.

### Packet Content

The packet must include these sections.

#### 1. Run Header

- session ID
- feature prompt/title
- workflow mode
- planner and implementer display names/models when available
- start/end timestamps when available
- total time
- total tasks, completed locally, escalated, skipped, failed
- packet generation timestamp and schema version

#### 2. Change Summary

- changed files from the final git diff
- expected task target files
- out-of-scope changed files from drift findings
- task-to-file mapping from Task Briefs and evidence
- pointer to raw diff inspection, not an embedded full diff

The packet is a review index, not a full diff viewer.

#### 3. Checkpoints And Restore

- checkpoint list with kind, name, ID, timestamp, task index, and file count
- latest run checkpoint
- pre-final-review checkpoint when present
- accepted/rejected run-ledger status when present
- exact `snapshot diff` and `snapshot restore` commands
- restore safety explanation and conflict behavior

#### 4. Validation And Evidence

- validation rollup: passed, failed, skipped, escalated
- per-task validation stages that passed or failed
- expected evidence from Task Briefs
- observed evidence from the ledger
- final review evidence status
- missing evidence warnings

#### 5. Drift And Scope

- deterministic drift pass/fail
- drift score
- warning/error counts
- findings grouped by severity
- drift-chain summary when present
- brief hash when present

#### 6. Escalations, Retries, Skips, And Warnings

- tasks retried and retry counts
- tasks escalated to planner
- failed or skipped tasks and reasons
- warning events that affect review confidence
- approval/rejection records from evidence when present

#### 7. Recovery Decisions

- source artifacts/events used for recovery reconstruction, such as `state.json`, `session.jsonl`, `evidence.json`, summary skip/abort state, and Recovery Flow events when present in state, session, or evidence artifacts
- recovery reason, phase, affected task IDs, affected files, and available/recommended actions when recorded
- selected recovery action when present, for example retry same worker, route bigger worker, planner split/rebase, continue, skip current task, pause run, or abort workflow
- outcome status for skipped, aborted, paused, resumed, failed, and resolved recovery paths
- unresolved recovery risks, including pending recovery issues, failed recovery actions, missing recovery artifacts, unresolved conflicts, or ambiguous pause/resume state

If Recovery Flow artifacts are unavailable, include an empty recovery-decision section and list the unavailable artifacts in `missingArtifacts`; do not treat missing recovery data as pass.

#### 8. Cost And Routing

- actual planner/implementer cost rollup when priced
- local/unpriced indication when pricing is unavailable
- savings estimate only when the existing summary says it is available
- per-task implementer profile/tool/model when present
- context-fit/routing warning events when present

This section supports review, not billing export.

#### 9. Planner Final Review

- path to `review.md`
- final review status: written or failed
- short status text
- link/reference to the full planner review artifact

The packet should not duplicate the entire final review when it is long.

#### 10. Human Reviewer Checklist

The Markdown packet ends with a checklist:

```markdown
- [ ] Inspect changed files against the requested scope.
- [ ] Review drift findings and out-of-scope warnings.
- [ ] Confirm validation commands passed or understand failures.
- [ ] Check escalated, skipped, or retried tasks.
- [ ] Inspect expected vs observed evidence for each completed task.
- [ ] Run or review any project-specific tests not covered by diptych.
- [ ] Use `diptych snapshot diff SNAPSHOT_ID` before any restore.
- [ ] Use `diptych snapshot restore SNAPSHOT_ID` only after conflicts are understood.
```

## Summary TUI Behavior

The summary screen should stay dense and terminal-native.

Add compact sections after the existing evidence/task/cost areas:

- **Checkpoints:** show latest relevant checkpoints and restore/diff commands.
- **Review packet:** show packet paths, drift/evidence status, and reviewer next steps.

The summary screen is not a file browser, diff viewer, kanban board, or plan archive. It should render a useful index and point to artifacts/commands.

## Artifact Schema Requirements

The JSON schema should be versioned:

```ts
version: 1
sessionId: string
generatedAt: string
run: object
changes: object
checkpoints: object
recoveryDecisions: object
validation: object
evidence: object
drift: object
escalations: object
cost: object
finalReview: object
reviewerChecklist: string[]
missingArtifacts: string[]
```

Optional fields are acceptable for backward compatibility with older sessions, but required top-level sections should exist with empty arrays or `null` status values when data is unavailable.

## Acceptance Criteria

- Checkpoint display data can be built from existing snapshot manifests and run ledger without mutating snapshots.
- Baseline snapshots are hidden from normal checkpoint UX.
- Restore commands always use IDs, not ambiguous names.
- `isRunCheckpoint` is derived only from `run-ledger.json`; name-derived checkpoint labels are represented as `inferredKind` when ledger data is missing.
- Restore messaging clearly states hash-guard and `--force` behavior.
- The final review packet is written under the current session directory only.
- The packet includes changed files, validation, evidence, drift, recovery decisions, escalations/retries/skips, cost/routing, checkpoints, and reviewer checklist.
- Missing artifacts are reported as missing, not treated as pass.
- The summary screen links to or displays packet paths and checkpoint commands.
- No MCP write tools are introduced.
- No same-checkout parallel execution is introduced.
- No plan archive, kanban, or cross-session plan-management surface is introduced.
- Tests verify behavior through rendered output, artifact contents, events, and filesystem effects.
