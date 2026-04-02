# Data Model: Deep Code Quality Fixes

**Feature**: 019-deep-quality-fixes
**Date**: 2026-04-01

## Overview

This feature is primarily a refactoring/bugfix effort. No new entities are introduced. The changes affect function signatures (positional → options objects), shared utility types, and wiring of existing but disconnected types.

## Modified Types

### SpawnProcessOptions (new — replaces multiple ad-hoc spawn signatures)

Unified options for all subprocess spawning across planners and implementers.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| command | string | Yes | Executable to spawn |
| args | string[] | Yes | Command-line arguments |
| cwd | string | Yes | Working directory |
| stdin | string | No | Content to write to stdin pipe |
| stdinMode | 'pipe' \| 'ignore' | No | Stdin handling (default: 'pipe') |
| onLine | (line: string) => void | Yes | Line-buffered stdout callback |
| onStderr | (chunk: string) => void | No | Raw stderr chunk callback |
| notFoundMessage | string | No | Custom error for ENOENT / exit 127 |
| timeout | number | No | Kill timeout in ms (0 = none) |
| detached | boolean | No | Spawn in own process group |
| killEscalationDelay | number | No | Ms before SIGKILL after SIGTERM (default: 5000) |

### SpawnProcessResult (new — unified return type)

| Field | Type | Description |
|-------|------|-------------|
| text | string | Full raw stdout |
| stderr | string | Full raw stderr |
| code | number | Exit code |
| killed | boolean | True if killed by signal/timeout |
| timedOut | boolean | True if killed by timeout |

### RunWorkflowOptions (new — replaces 6 positional params)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| feature | string | Yes | Feature name |
| projectDir | string | Yes | Project root directory |
| config | Config | Yes | Loaded configuration |
| callbacks | OrchestratorCallbacks | Yes | Event/approval callbacks |
| savedState | WorkflowState | No | Resume from saved state |
| selectedSkills | SkillMeta[] | No | Selected skills |

### HandleRetryOptions (new — replaces 8 positional params)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| task | Task | Yes | The failing task |
| initialError | string | Yes | Error from initial attempt |
| projectDir | string | Yes | Project root |
| config | Config | Yes | Configuration |
| context | ProjectContext | Yes | Project context for prompts |
| callbacks | OrchestratorCallbacks | Yes | Event callbacks |
| currentState | WorkflowState | Yes | Current workflow state |
| taskStartTime | number | No | When task started |

### BuildSummaryOptions (new — replaces trailing optional params)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| taskBreakdowns | TaskTokenUsage[] | No | Per-task token usage |
| plannerTool | string | No | Planner tool name |
| implementerProvider | string | No | Implementer provider name |

## Wiring Changes (Existing Types)

### CostBreakdown → Summary

The `CostBreakdown` type already exists but is never populated. Change: `buildSummary` will call `calculateCostBreakdown` and set `summary.costBreakdown`.

**Convention standardization**: `localCompletionRate` changes from 0-100 scale to 0-1 ratio (matching `escalationRate`). UI consumers already multiply by 100.

### Summary.plannerName / Summary.implementerName

Already declared as optional fields. Change: `buildSummary` will populate them from the options.

## Removed Types/Exports

| Symbol | File | Reason |
|--------|------|--------|
| `setShikiTheme` (export) | engine/highlight.ts | Never called |
| `listDir` (export) | engine/planners/context.ts | Only used internally |
| `spawnWithStdin` (re-export) | engine/planners/base.ts | All consumers import directly |
| `exit` prop | router.tsx RouterProps | Never used |
| `onOpenOverlay` prop | screens/home.tsx, workflow.tsx | Never used |
| `SummaryView` (entire file) | ui/summary.tsx | Never imported; screens/summary.tsx is used |

## State Transitions

No changes to the state machine (11 phases, 20 transitions). The `task.status` direct mutation pattern is documented as intentional.
