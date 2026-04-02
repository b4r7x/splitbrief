# Data Model: Code Quality Audit Remediation

**Feature**: 022-quality-audit-fixes  
**Date**: 2026-04-02

## Overview

This feature is a refactoring — no new entities are introduced. The data model documents the type changes and entity relationships affected by the remediation.

## Type Changes

### Renamed Types

| Old Name | New Name | File | Rationale |
|----------|----------|------|-----------|
| `Event` | `OrchestratorEvent` | `types.ts:208` | Avoid collision with DOM `Event` global; align with `OrchestratorEventType` naming family |

### Unified Types

| Type | Old Fields | New Fields | Rationale |
|------|-----------|------------|-----------|
| `ImplementerTokenUsage` | `promptTokens`, `completionTokens` | `inputTokens`, `outputTokens` | Consistency with `PlannerTokenUsage`; eliminates runtime field-name sniffing |

### Newly Exported Types

| Type | File | Consumers |
|------|------|-----------|
| `TaskStatus` | `types.ts:52` | `ui/sidebar.tsx`, `hooks/use-workflow.ts` (for type narrowing) |

### Relocated Types

| Type | From | To | Sole Consumer |
|------|------|----|---------------|
| `TaskFrontmatter` | `types.ts:322` | `engine/spec/parser.ts` | `parser.ts` |
| `BuildSummaryState` | `types.ts:290` | `engine/orchestrator/cost.ts` | `cost.ts` |
| `ClarificationQuestion` | `types.ts:330` (canonical) | `engine/question-parser.ts` (canonical) | Multiple via re-export |

### Deduplicated Types

| Type | Duplicate Locations | Canonical Location |
|------|--------------------|--------------------|
| `SidebarTask` | `hooks/use-workflow.ts:10`, `ui/sidebar.tsx:6` | `types.ts` (new canonical) |

### Relocated Runtime Values

| Value | From | To | Rationale |
|-------|------|----|-----------|
| `DEFAULT_BASES` | `types.ts:7-12` | `engine/providers.ts` | Runtime config with callbacks, not a type definition |

### Removed Types/Exports

| Type/Export | File | Reason |
|-------------|------|--------|
| `TuiEventType` | `types.ts:292` | Dead export — never imported |
| `getVisibleWindow` | `utils/event-sections.ts:102` | Dead export — only used in tests |
| `estimateEventHeight` | `utils/event-sections.ts:77` | Dead export — only used in tests |

## New Modules

| Module | Purpose | Exports |
|--------|---------|---------|
| `utils/errors.ts` | Error message extraction | `toErrorMessage(err: unknown): string` |
| `engine/implementer-utils.ts` | Shared implementer helpers (breaks circular dep) | `createGenEventEmitter()`, `processImplementerOutput()` |
| `engine/orchestrator/escalation.ts` | Retry/escalation cascade | `handleRetryAndEscalation()`, `RetryResult`, `EscalationContext` |
| `engine/spec/planning-prompts.ts` | Planning phase prompt templates | 5 `build*Prompt` functions |
| `engine/spec/execution-prompts.ts` | Execution phase prompt templates | `buildHintPrompt`, `buildEscalationPrompt` |
| `engine/spec/review-prompts.ts` | Review phase prompt template | `buildFinalReviewPrompt` |
| `ui/spinner.tsx` | Animated spinner component | `Spinner` |
| `tests/helpers/react-tree.ts` | React element tree traversal | `collectText()`, `findText()` |

## Deleted Files

| File | Lines | Reason |
|------|-------|--------|
| `ui/picker.tsx` | 158 | Dead code — zero imports from any source file |

## Persistence Impact

**None.** All changes are to transient in-memory types and module structure. No persisted file formats change:
- `state.json` — field names unchanged (`plannerInput`/`plannerOutput`/`implementerInput`/`implementerOutput`)
- `events.jsonl` — field values unchanged (TypeScript type names are not serialized)
- `config.yaml` — no schema changes
- `sessions/` — no format changes
