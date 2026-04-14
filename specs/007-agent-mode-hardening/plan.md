# Implementation Plan: Agent-Mode Implementer & Workflow Hardening

**Branch**: `007-agent-mode-hardening` | **Date**: 2026-03-26 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/007-agent-mode-hardening/spec.md`

## Summary

Add a new "agent" implementer mode where the implementer subprocess writes files directly (no extractCode/applyCode), while diptych retains validation/retry/escalation/git. Harden the conversational planning TUI (question parsing, comment-on-approval, graceful degradation). Add planner CLI version detection to prevent flag-mismatch errors. Amend Constitution Principle VI to v1.2.0.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only (`"type": "module"`)
**Primary Dependencies**: Ink 5.x, @inkjs/ui, openai ^6.0.0, yaml, simple-git, commander ^14.0.0
**Storage**: JSON files (state.json, events.jsonl), Markdown files (spec.md, plan.md, tasks.md)
**Testing**: Node.js built-in test runner (`node --test`), tsx for dev
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool
**Performance Goals**: N/A (interactive CLI, not latency-critical)
**Constraints**: Zero classes, pure functions only, `.js` extensions in imports, no unnecessary comments
**Scale/Scope**: Single-user CLI, ~700-line orchestrator, 6 planner backends, 2→3 implementer modes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | Agent mode preserves the planner/implementer split. Opus still only used for planning/escalation. Agent implementer can use cheaper models (e.g., claude-zai with Z.AI GLM). |
| II. Spec-Driven Development | PASS | No change to spec→plan→tasks workflow. Agent mode only affects the implementation dispatch. |
| III. Local-First Implementation | PASS | Default remains Ollama API. Agent mode is opt-in. |
| IV. Functional Purity | PASS | New code uses pure functions. No classes. |
| V. Validate Before Commit | PASS | Agent mode still runs tsc→lint→test after each task. Retry and escalation unchanged. |
| VI. Identity & Anti-Goals | REQUIRES AMENDMENT | Agent mode delegates file writes to implementer. Owner approved amending Principle VI to v1.2.0: file write delegation permitted when diptych retains validation/git/escalation ownership. Anti-goal remains for generic agent-wrapping patterns. |

**Gate result**: PASS (with approved amendment to Principle VI)

## Project Structure

### Documentation (this feature)

```text
specs/007-agent-mode-hardening/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0: technical research
├── data-model.md        # Phase 1: entity definitions
├── contracts/
│   └── cli-commands.md  # Phase 1: updated CLI contract
├── quickstart.md        # Phase 1: usage guide
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── orchestrator/
│   ├── orchestrator.ts          # Modified: agent-mode dispatch in implementation loop
│   ├── implementer.ts           # Modified: add agent dispatch alongside api/shell
│   ├── implementers/
│   │   ├── shell.ts             # Existing: unchanged
│   │   └── agent.ts             # NEW: agent-mode implementer (spawn, wait, detect changes)
│   ├── planners/
│   │   ├── types.ts             # Modified: add getVersion() to PlannerBackend
│   │   ├── claude-code.ts       # Modified: version detection, flag selection
│   │   └── [others unchanged]
│   ├── question-parser.ts       # Modified: fix greedy bracket matching, add dedup
│   └── planner-detection.ts     # Modified: version detection during auto-detect
├── config.ts                    # Modified: add 'agent' to implementer.type, validate
├── types.ts                     # Modified: add 'agent' to implementer type union
├── tui/
│   ├── prompt.tsx               # Modified: session continuity detection for comment
│   └── question-prompt.tsx      # Modified: input validation, edge cases
└── .specify/memory/
    └── constitution.md          # Modified: amend Principle VI to v1.2.0

tests/
├── agent-implementer.test.ts    # NEW: agent-mode implementer tests
├── question-parser.test.ts      # Modified: malformed markers, split chunks, dedup
├── planner-version.test.ts      # NEW: version detection and flag selection
├── config.test.ts               # Modified: agent config validation
└── integration/
    └── agent.integration.test.ts # NEW: end-to-end agent-mode test
```

**Structure Decision**: Follows existing project structure. Agent implementer goes in `implementers/` directory alongside existing `shell.ts`. Version detection added to planner backends interface. No new directories needed.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Principle VI amendment (file write delegation) | Users need agent-style tools (claude-zai, aider) as implementers; these tools manage their own files | "Don't support agent mode" rejected because it blocks the primary use case the owner wants |
| Shell function resolution via `$SHELL -lc` | Shell functions like `claude-zai` aren't on PATH; `spawn()` can't see them | "Only support PATH executables" rejected because the owner's primary tool is a bash function |

## Post-Design Constitution Re-Check

*Re-evaluated after Phase 1 design completion.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | Data model confirms agent mode is opt-in; default remains local Ollama API ($0). No new Opus token usage introduced. |
| II. Spec-Driven Development | PASS | No changes to spec/plan/tasks workflow. Agent mode only affects implementation dispatch. |
| III. Local-First Implementation | PASS | Default implementer unchanged. Agent mode requires explicit config. |
| IV. Functional Purity | PASS | All new code is pure functions: `implementers/agent.ts`, `utils/version.ts`. No classes. |
| V. Validate Before Commit | PASS | Agent mode runs identical validation pipeline (tsc→lint→test). Retry/escalation unchanged. |
| VI. Identity & Anti-Goals | PASS | Amendment to v1.2.0 approved. Carve-out: file write delegation permitted when diptych retains validation/git/escalation. Design confirms diptych still owns the full quality pipeline. |

**Post-design gate result**: ALL PASS
