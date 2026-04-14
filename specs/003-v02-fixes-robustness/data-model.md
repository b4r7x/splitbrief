# Data Model: diptych v0.2

**Source**: [spec.md](spec.md) Key Entities section
**Extends**: [v0.1 data-model](../002-cost-optimized-orchestrator/data-model.md)

## Changes from v0.1

### WorkflowState  -  Added Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| stateVersion | `number` | `2` | Schema version for forward compatibility. v1 = original (no version field), v2 = this release. |

### WorkflowState  -  Modified Behavior

| Field | v0.1 Behavior | v0.2 Behavior |
|-------|---------------|---------------|
| attempt | Not reset after escalation (HINT_SUCCESS, FULL_SUCCESS, FULL_FAIL) | Reset to 0 after any escalation outcome |
| tokenUsage | Always `{ 0, 0, 0, 0, 0, 0 }`  -  never populated | Populated from Claude CLI `result` event usage and OpenAI API streaming usage |

### State Machine  -  Modified Transitions

| Transition | v0.1 Behavior | v0.2 Behavior |
|------------|---------------|---------------|
| VALIDATION_FAIL (attempt >= max) | Silent no-op (returns state unchanged) | Transitions to `escalating` phase |
| HINT_SUCCESS | Does not reset `attempt` | Resets `attempt` to 0 |
| FULL_SUCCESS | Does not reset `attempt` | Resets `attempt` to 0 |
| FULL_FAIL | Does not reset `attempt` | Resets `attempt` to 0 |

### State Machine  -  Removed Constants

| Constant | v0.1 | v0.2 |
|----------|------|------|
| MAX_RETRIES | Hardcoded `3` in state.ts | Removed. `maxRetries` is passed as parameter from config. |

### Config  -  No Schema Changes

The Config type is unchanged. The only change is that it is now **validated at load time** with clear error messages and exit code 2 on invalid values.

### TokenUsage  -  No Type Changes

The type is unchanged. The change is that the 6 fields are now actually populated from API responses:

| Field | Source |
|-------|--------|
| plannerInput | Claude CLI `result.usage.input_tokens` (4 planning phases) |
| plannerOutput | Claude CLI `result.usage.output_tokens` (4 planning phases) |
| implementerInput | OpenAI API `usage.prompt_tokens` (final streaming chunk) |
| implementerOutput | OpenAI API `usage.completion_tokens` (final streaming chunk) |
| escalationInput | Claude CLI `result.usage.input_tokens` (hint + full escalation) |
| escalationOutput | Claude CLI `result.usage.output_tokens` (hint + full escalation) |

### New Type: StreamParseResult

Returned by the shared `parseStreamLine` function in `claude-stream.ts`:

| Field | Type | Description |
|-------|------|-------------|
| text | `string \| null` | Extracted text content from assistant/result events |
| sessionId | `string \| null` | Session ID if present in the event |
| isResult | `boolean` | True if this was a `result` event (final) |
| usage | `{ input_tokens: number; output_tokens: number } \| null` | Token usage from `result` events |
| costUsd | `number \| null` | Total cost from `result.total_cost_usd` |

### State Versioning

When loading `state.json`:
- If `stateVersion` field is absent → treat as v1 (incompatible, show error)
- If `stateVersion === 2` → load normally
- If `stateVersion > 2` → show "newer version" warning, attempt best-effort load

### Validation Rules (new in v0.2)

| Field | Rule | Error Message Pattern |
|-------|------|-----------------------|
| implementer.provider | Must be in `['ollama', 'lm-studio', 'deepseek', 'openrouter']` | "Invalid provider '{value}'. Valid: ollama, lm-studio, deepseek, openrouter" |
| implementer.model | Non-empty string | "implementer.model must be a non-empty string" |
| implementer.contextLength | Positive integer | "implementer.contextLength must be a positive integer" |
| implementer.temperature | Number, 0–2 | "implementer.temperature must be between 0 and 2" |
| workflow.maxRetries | Non-negative integer | "workflow.maxRetries must be a non-negative integer" |
| All boolean fields | Must be boolean | "{field} must be true or false" |
