# Implementation Plan: State-of-the-Art Code Quality Overhaul

**Branch**: `020-state-of-art-quality` | **Date**: 2026-04-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/020-state-of-art-quality/spec.md`

## Summary

Internal refactoring to address 200+ findings from a 20-agent code quality audit. The changes span 6 domains: type safety (eliminate 19 `as any` casts in config validation), React patterns (refactor useWorkflow god-hook, fix theme propagation bug across 6+ components, fix picker anti-patterns), DRY elimination (shared token types, line-buffer utility, spawn deduplication), architecture (React Context to replace 19 Router props), dead code removal (25+ dead exports, unused functions), and separation of concerns (extract pure logic from mixed components). Zero new dependencies. All existing tests must pass.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only (`"type": "module"`)  
**Primary Dependencies**: Ink 6.x (React 19), openai ^6.0.0, simple-git, commander ^14.0.0, yaml, Shiki 4.x, ansis  
**Storage**: JSON files (`.diptych/state.json`, `events.jsonl`), Markdown files (spec, plan, tasks)  
**Testing**: node:test (built-in test runner) with node:assert/strict  
**Target Platform**: macOS (primary), Linux (secondary), Node.js 22+  
**Project Type**: CLI tool with TUI (Ink/React)  
**Performance Goals**: N/A (refactoring, no performance-critical changes)  
**Constraints**: Zero new dependencies, zero user-facing behavior changes (except theme bug fix), all existing tests must pass  
**Scale/Scope**: ~60 source files across src/, ~15 test files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | Internal refactoring only. No token cost impact. No new Opus usage. |
| II. Spec-Driven Development | PASS | Following speckit workflow: spec → plan → tasks → implement. |
| III. Local-First Implementation | PASS | No new cloud dependencies or API costs. |
| IV. Functional Purity | PASS | Improves compliance: fewer `as any`, better module separation, pure function extraction. Zero classes introduced. ESM `.js` extensions maintained. |
| V. Validate Before Commit | PASS | SC-009 explicitly requires all tests pass. Each task validates via tsc → lint → test. |
| VI. Identity & Anti-Goals | PASS | No feature additions. No multi-agent patterns. Only quality improvements to existing two-role architecture. Theme fix improves the "beautiful visualization" identity. |

**Gate result**: ALL PASS. No violations. No Complexity Tracking entries needed.

**Post-Phase-1 re-check**: ALL PASS. Design artifacts introduce one React Context (no classes), one new utility file (follows existing patterns), named types (improves safety), and `useReducer` (standard React). No principle violations.

## Project Structure

### Documentation (this feature)

```text
specs/020-state-of-art-quality/
├── plan.md              # This file
├── research.md          # Phase 0 output (audit findings consolidated)
├── data-model.md        # Phase 1 output (entity changes)
├── quickstart.md        # Phase 1 output (verification guide)
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── types.ts                    # FR-002: Add shared TokenUsage types
├── config.ts                   # FR-001: Rewrite validateConfig without as-any
│                               # FR-018: Replace process.exit with error propagation
├── app.tsx                     # FR-008: Add AppContext provider
├── router.tsx                  # FR-008: Consume context, reduce props
├── engine/
│   ├── orchestrator/
│   │   ├── index.ts            # FR-011: Extract buildSummary base options
│   │   ├── tokens.ts           # FR-012: Consolidate 3 addXxxUsage → 1 generic
│   │   └── helpers.ts          # FR-016: Inline or keep (10-line module)
│   ├── planners/
│   │   ├── types.ts            # FR-002: Use shared TokenUsage type
│   │   ├── base.ts             # FR-002: Use shared TokenUsage type
│   │   ├── agent-sdk.ts        # FR-003: Define SDK message interfaces
│   │   ├── claude-code.ts      # FR-002: Use shared TokenUsage type
│   │   ├── codex.ts            # FR-002: Use shared TokenUsage type
│   │   ├── opencode.ts         # FR-002: Use shared TokenUsage type
│   │   ├── aider.ts            # FR-002: Use shared TokenUsage type
│   │   └── shell.ts            # FR-002: Use shared TokenUsage type
│   ├── implementer.ts          # FR-002: Use shared TokenUsage type
│   ├── implementers/
│   │   ├── shell.ts            # FR-010: Reuse shared spawn utility
│   │   └── agent.ts            # FR-020: Import getGit from utils/git
│   ├── spec/
│   │   └── formatter.ts        # FR-013: Extract shared code-context helper
│   ├── output-parsers.ts       # FR-002: Use shared TokenUsage type
│   ├── highlight.ts            # FR-016: let → const for currentThemeName
│   ├── providers.ts            # FR-014: Un-export dead types
│   └── detection.ts            # FR-014: Un-export dead types
├── hooks/
│   ├── use-workflow.ts         # FR-004: Refactor 7 useState → useReducer
│   ├── use-router.ts           # FR-014: Remove redundant screen state
│   ├── use-input-mode.ts       # FR-014: Consolidate paired state
│   └── use-config.ts           # Minor: Immutable config override
├── screens/
│   ├── home.tsx                # FR-019: Move formatRelativeTime to utils
│   └── workflow.tsx            # FR-008: Consume context
├── ui/
│   ├── event-card.tsx          # FR-005: Accept theme via props/context
│   ├── header.tsx              # FR-005: Accept theme via props/context
│   ├── picker.tsx              # FR-005, FR-006: Theme props + init fix
│   ├── review-view.tsx         # FR-007: Async file reading
│   ├── conversation-flow.tsx   # FR-017: Extract pure logic to utils
│   ├── markdown.tsx            # FR-005: Guard panelBg, fix bold/italic
│   ├── sidebar.tsx             # FR-005: Theme consistency
│   └── command-palette.tsx     # FR-005: Theme consistency check
├── utils/
│   ├── process.ts              # FR-009: Add createLineBuffer utility
│   │                           # FR-021: Export SIGKILL_DELAY
│   ├── git.ts                  # FR-020: Export getGit helper
│   ├── format.ts               # FR-019: Receive formatRelativeTime
│   ├── fs.ts                   # FR-015: Remove dead lock functions
│   └── event-sections.ts       # FR-017: New — pure event grouping + scroll math
tests/
├── orchestrator.test.ts        # Update for new token/cost APIs
├── formatter.test.ts           # Update for extracted helper
├── event-sections.test.ts      # New — tests for extracted pure logic
└── [existing tests]            # Must all pass (SC-009)
```

**Structure Decision**: No structural changes to the directory layout. All changes are within existing directories. One new utility file (`utils/event-sections.ts`) for extracted pure logic from `conversation-flow.tsx`. The existing `src/engine/`, `src/hooks/`, `src/ui/`, `src/screens/`, `src/utils/` hierarchy is maintained.

## Complexity Tracking

> No violations detected. No entries needed.
