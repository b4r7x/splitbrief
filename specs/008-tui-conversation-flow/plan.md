# Implementation Plan: TUI Conversation Flow Redesign

**Branch**: `008-tui-conversation-flow` | **Date**: 2026-03-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-tui-conversation-flow/spec.md`

## Summary

Replace the dual-pane raw text TUI with a single-column conversation flow driven by structured `TuiEvent` objects. The orchestrator emits typed events instead of raw text strings. The TUI renders each event as a visually distinct card — planner phases as conversational text, implementer/validation/git as tool-call cards. Completed tasks collapse to 1 line. Sticky header shows pipeline progress; sticky footer shows real-time cost savings.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only
**Primary Dependencies**: Ink 5.2.1 (React for CLI), @inkjs/ui, openai SDK, simple-git, commander
**Storage**: JSON files (.diptych/state.json, events.jsonl), Markdown files
**Testing**: Node.js built-in test runner via tsx (227+ tests)
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool
**Performance Goals**: No visible flicker during normal event emission; smooth scroll on 30+ task workflows
**Constraints**: Terminal minimum 60x10 characters; Ink 5.x limitations (no native scroll, no sticky positioning)
**Scale/Scope**: Typical workflows: 5-30 tasks, ~100 events per workflow

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | ✅ PASS | TUI changes don't affect token usage. Cost footer makes savings visible. |
| II. Spec-Driven Development | ✅ PASS | Feature specified via SpecKit workflow. |
| III. Local-First Implementation | ✅ PASS | No new cloud dependencies. TUI is local-only. |
| IV. Functional Purity | ✅ PASS | All new components are pure functions. No classes. ESM + .js extensions. |
| V. Validate Before Commit | ✅ PASS | Validation pipeline unchanged. New TUI displays validation results better. |
| VI. Identity & Anti-Goals | ✅ PASS | Constitution v1.3.0 explicitly encourages "rich visualization of the two-role orchestration" as product differentiation. |

No violations. No complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/008-tui-conversation-flow/
├── spec.md              # Feature specification (7 user stories, 30 FRs)
├── plan.md              # This file
├── research.md          # 8 research sections: layout, events, diffs, costs, scroll, resize, colors, planner
├── data-model.md        # TuiEvent union, EventStream, CostState, PipelineState
├── quickstart.md        # End-user guide with keyboard controls
├── contracts/
│   └── event-callbacks.md   # OrchestratorCallbacks migration map
└── checklists/
    └── requirements.md      # Spec quality validation (all pass)
```

### Source Code (repository root)

```text
src/
├── types.ts                        # ADD: TuiEvent union type. MODIFY: OrchestratorCallbacks
├── app.tsx                         # REWRITE: Event-driven state, new layout wiring
├── orchestrator/
│   ├── orchestrator.ts             # MODIFY: Emit TuiEvents via onEvent() instead of individual callbacks
│   ├── implementer.ts              # MODIFY: Capture before/after for diff, emit implementer-generate event
│   └── diff.ts                     # NEW: computeDiff(oldContent, newContent) → unified diff string
├── tui/
│   ├── layout.tsx                  # REWRITE: Conversation flow (sticky header + scroll + sticky footer)
│   ├── event-card.tsx              # NEW: Renders single TuiEvent as appropriate card
│   ├── conversation-flow.tsx       # NEW: Scrollable event list with auto-follow
│   ├── pipeline-bar.tsx            # NEW: Phase progress visualization
│   ├── cost-footer.tsx             # NEW: Real-time cost savings bar
│   ├── diff-view.tsx               # NEW: Collapsible colored diff display
│   ├── task-summary.tsx            # NEW: Collapsed task 1-liner
│   ├── header.tsx                  # MODIFY: Add pipeline bar integration
│   ├── status-bar.tsx              # REPLACE: Becomes cost-footer.tsx
│   ├── pane.tsx                    # DELETE: Replaced by conversation-flow.tsx
│   ├── prompt.tsx                  # KEEP: Approval prompts (rendered inline in flow)
│   ├── picker.tsx                  # KEEP: Planner/implementer selection
│   ├── question-prompt.tsx         # KEEP: Clarification questions
│   ├── summary.tsx                 # KEEP: Final run summary
│   └── user-input.tsx              # KEEP: Text input wrapper
└── utils/
    └── format.ts                   # KEEP: formatTokens, formatCost, formatTime (may add formatDiff)

tests/
├── events.test.ts                  # NEW: TuiEvent creation and validation
├── diff.test.ts                    # NEW: computeDiff function
├── conversation-flow.test.ts       # NEW: Event rendering, collapse, scroll
├── pipeline-bar.test.ts            # NEW: Phase mapping
├── cost-footer.test.ts             # NEW: Real-time cost calculations
├── orchestrator.test.ts            # MODIFY: Update for new callback interface
├── summary.test.ts                 # KEEP: No changes expected
└── [all other existing tests]      # VERIFY: No regressions
```

**Structure Decision**: Single project, existing `src/` structure. New TUI components go in `src/tui/`. New orchestrator utility (`diff.ts`) goes in `src/orchestrator/`. No new top-level directories.

## Complexity Tracking

No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    |            |                                     |
