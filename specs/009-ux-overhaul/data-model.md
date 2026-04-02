# Data Model: 009-ux-overhaul

## New Types

### PermissionMode

Represents the current approval level for the workflow.

Values: `supervised` | `normal` | `auto` | `plan-only`

Behavior mapping:
| Mode | Spec/Plan approval | Review gate | Pre-task approval | Post-task review | Auto-commit |
|------|-------------------|-------------|-------------------|-----------------|-------------|
| supervised | yes | yes | yes | yes | no |
| normal | yes | yes (auto-approve) | no | no | yes |
| auto | no | no | no | no | yes |
| plan-only | yes | stop here | n/a | n/a | n/a |

### Screen

Active TUI screen.

Values: `home` | `workflow` | `summary`

### Overlay

Active overlay on top of current screen.

Values: `none` | `mode-picker` | `help` | `slash-commands`

### TldrChangeset

Parsed from `<!-- TLDR:{...} -->` markers in planner output.

Fields:
- `added: string[]` — items added in regeneration
- `changed: string[]` — items modified in regeneration
- `removed: string[]` — items removed in regeneration
- `summary: string` — compact summary line (e.g., "4 stories -> 5 | 24 FRs -> 22")

## Modified Types

### Phase (extended)

Add `review-gate` to existing 11 phases:

`idle | researching | specifying | reviewing-spec | planning | reviewing-plan | review-gate | implementing | validating-task | escalating | final-review | complete`

### StateAction (extended)

Add 5 new actions to existing 20:

| Action | From | To | Side effects |
|--------|------|-----|-------------|
| `BACK_TO_SPEC` | reviewing-plan | reviewing-spec | none |
| `BACK_TO_PLAN` | review-gate | reviewing-plan | none |
| `APPROVE_GATE` | review-gate | implementing | reset currentTaskIndex=0, attempt=0 |
| `PLAN_COMPLETE` | review-gate | complete | none |
| `SET_MODE` | any | (same) | mutate permissionMode |

Modified existing action:
| Action | Old target | New target |
|--------|-----------|------------|
| `APPROVE_PLAN` | implementing | review-gate |

### WorkflowState (extended)

Add field:
- `permissionMode: PermissionMode` — current mode, default `'normal'`

Bump `stateVersion` from 2 to 3.

### Config.workflow (extended)

Add field:
- `mode?: PermissionMode` — persistent mode from config file

Existing `autoApproveSpec` and `autoApprovePlan` remain for backwards compatibility. When `mode` is set, it takes precedence.

### TuiEvent (extended)

Add 3 new event types to existing 11:

| Type | Fields | When emitted |
|------|--------|-------------|
| `tldr-changeset` | `ts, artifact: 'spec' \| 'plan', changeset: TldrChangeset` | After planner regeneration with TLDR markers |
| `review-gate` | `ts, tasks: {id, title, action, file}[], mode: PermissionMode` | When review gate is displayed |
| `mode-change` | `ts, from: PermissionMode, to: PermissionMode` | When user switches mode |

### OrchestratorCallbacks (extended)

Add 3 new optional callbacks:

| Callback | Signature | Used in |
|----------|-----------|---------|
| `onReviewGate?` | `(tasks, mode) => Promise<'proceed' \| 'back' \| 'quit'>` | Before implementation starts |
| `onTaskApproval?` | `(task) => Promise<'proceed' \| 'skip'>` | Supervised mode, before each task |
| `onTaskReview?` | `(task, diff, validation) => Promise<'commit' \| 'retry' \| 'skip' \| 'edit'>` | Supervised mode, after each task |

## State Transitions

### Phase Graph (extended)

```
idle ──START──> researching ──RESEARCH_DONE──> specifying
                                                   │
                                              SPEC_DONE
                                                   │
                                                   ▼
                        ┌──BACK_TO_SPEC──── reviewing-spec
                        │                       │        │
                        │                  APPROVE_SPEC  REJECT_SPEC
                        │                       │            │
                        │                       ▼            ▼
                        │                   planning       idle
                        │                       │
                        │                  PLAN_DONE
                        │                       │
                        │                       ▼
                        └───────────────── reviewing-plan
                                                │        │
                                           APPROVE_PLAN  REJECT_PLAN
                                                │            │
                                                ▼            ▼
                        ┌──BACK_TO_PLAN──── review-gate    idle
                        │                    │       │
                        │              APPROVE_GATE  PLAN_COMPLETE
                        │                    │            │
                        │                    ▼            ▼
                        │              implementing    complete
                        │                    │
                        │               TASK_SENT
                        │                    │
                        │                    ▼
                        │             validating-task
                        │               │           │
                        │         VALIDATION_PASS  VALIDATION_FAIL
                        │               │           │        │
                        │               ▼           ▼        ▼
                        │          implementing  implementing  escalating
                        │               │                      │
                        │            ALL_DONE              HINT/FULL
                        │               │                  SUCCESS/FAIL
                        │               ▼                      │
                        │          final-review                │
                        │               │                      │
                        │          REVIEW_DONE                 │
                        │               │                      │
                        │               ▼                      │
                        │            complete ◄────────────────┘
                        │
                        └──────────── reviewing-plan
```

### PermissionMode Transitions (runtime)

```
supervised <──Tab──> normal <──Tab──> auto <──Tab──> plan-only
     │                  │                │                │
     └──────────────────┴────────────────┴────────────────┘
                    (any to any via Tab picker)
```

Mode changes are immediate but take effect at next decision point.

### Screen Transitions

```
home ──Enter(feature)──> workflow ──onComplete──> summary
  ▲                         │                       │
  └────q (quit)─────────────┘                       │
  └────q (quit)─────────────────────────────────────┘
```

### Overlay State Machine

```
none ──Tab──> mode-picker ──Enter/Esc──> none
none ──?──> help ──anykey──> none
none ──/──> slash-commands ──Enter/Esc──> none
```

Overlays are modal: only one active at a time, all other input blocked while overlay is shown.

## Migration

### stateVersion 2 → 3

When loading a state.json with `stateVersion: 2`:
- Add `permissionMode: 'normal'` (default)
- Phase `reviewing-plan` with `APPROVE_PLAN` will now go to `review-gate` instead of `implementing` — this is acceptable since the review gate auto-approves in `normal` mode
- Reject state files with unknown phases (future-proofing)
