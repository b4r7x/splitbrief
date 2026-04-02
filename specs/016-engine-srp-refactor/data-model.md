# Data Model: Engine SRP & DRY Refactoring

**Date**: 2026-04-01 | **Branch**: `016-engine-srp-refactor`

This feature is a pure structural refactoring — no new data entities, no schema changes, no new persistence. The "entities" are module interfaces that define the contracts between extracted modules.

## Module Interfaces

### InvokeResult (new — planners/base.ts)

Unified return type for all planner invocations.

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Response text from the planner |
| `usage` | `{ inputTokens: number; outputTokens: number } | null` | Token consumption, null if not tracked |

### InvokeFn (new — planners/base.ts)

Function signature for planner spawn/query callbacks.

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | `string` | The prompt to send |
| `projectDir` | `string` | Working directory |
| `onOutput` | `(text: string) => void` | Streaming output callback |
| `onQuestion` | `((q: ClarificationQuestion[]) => void)?` | Optional question callback (claude-code only) |
| Returns | `Promise<InvokeResult>` | Response text + usage |

### PlannerBaseConfig (new — planners/base.ts)

Configuration record passed to `createPlannerBase()`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Planner display name |
| `pricingKey` | `string` | Yes | Key for pricing lookup |
| `invokePlan` | `InvokeFn` | Yes | Spawn function for plan phases |
| `invokeEscalate` | `InvokeFn` | Yes | Spawn function for escalation |
| `isAvailable` | `() => Promise<boolean>` | Yes | Availability check |
| `getVersion` | `() => Promise<string \| null>` | Yes | Version detection |
| `escalateHintSuccess` | `(result: InvokeResult) => boolean` | No | Override hint success logic (default: `true`) |
| `escalateFullPostProcess` | Function | No | Override full escalation post-processing |

### CompletionResult (extracted — openai-stream.ts)

Return type for OpenAI-compatible streaming.

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Completed response text |
| `usage` | `{ promptTokens: number; completionTokens: number } | null` | Token usage |

## State Transitions

No changes to existing state machine. All 11 phases and 20 transitions in `state.ts` remain identical.

## Persistence

No changes to persistence format. State JSON, events JSONL, and spec files remain identical.
