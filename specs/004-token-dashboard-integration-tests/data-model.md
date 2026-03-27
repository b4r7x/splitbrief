# Data Model: Pluggable Orchestrator, Token Dashboard & Integration Tests

## Entities

### PlannerBackend (new)

Interface for planner provider abstraction. Implemented as object with function properties (no classes per constitution).

| Field | Type | Description |
|-------|------|-------------|
| name | string (readonly) | Provider identifier: 'claude-code', 'codex', 'opencode', 'aider', 'agent-sdk' |
| plan | function | Execute full planning cycle → PlanResult |
| escalateHint | function | Get hints for failed task → EscalationResult |
| escalateFull | function | Full implementation for failed task → EscalationResult |
| isAvailable | function | Check if backend is installed/accessible → boolean |
| getPricing | function | Return pricing info for cost calculations → PricingInfo |

### PlanResult (existing — unchanged)

| Field | Type | Description |
|-------|------|-------------|
| spec | string | Generated specification markdown |
| plan | string | Generated implementation plan markdown |
| tasks | Task[] | Parsed task list |
| usage | { inputTokens, outputTokens } or null | Aggregate token usage from all planning phases |

### EscalationResult (new)

| Field | Type | Description |
|-------|------|-------------|
| output | string | Text output from escalation |
| code | string or null | Extracted code (for tier 2 full implementation) |
| usage | { inputTokens, outputTokens } | Token usage for this escalation call |
| success | boolean | Whether escalation produced valid output |

### PricingInfo (new)

| Field | Type | Description |
|-------|------|-------------|
| inputPer1M | number | USD per 1M input tokens |
| outputPer1M | number | USD per 1M output tokens |
| isLocal | boolean | True for Ollama/LM Studio ($0 cost) |
| name | string | Display name (e.g., "Claude Opus 4.6") |

### TokenUsage (existing — unchanged)

| Field | Type | Description |
|-------|------|-------------|
| plannerInput | number | Input tokens sent to planner |
| plannerOutput | number | Output tokens from planner |
| implementerInput | number | Input tokens sent to implementer |
| implementerOutput | number | Output tokens from implementer |
| escalationInput | number | Input tokens for escalation calls |
| escalationOutput | number | Output tokens from escalation |

### TaskTokenUsage (new)

Per-task token tracking for the completion summary breakdown.

| Field | Type | Description |
|-------|------|-------------|
| taskId | string | Task identifier (e.g., "T001") |
| taskTitle | string | Human-readable task title |
| method | 'local' or 'escalated-hint' or 'escalated-full' or 'failed' or 'skipped' | How the task was completed |
| implementerTokens | number | Total tokens used by local model (including retries) |
| escalationTokens | number | Total tokens used for escalation (if any) |
| retryCount | number | Number of retry attempts |

### CostBreakdown (new)

Computed entity for the summary dashboard.

| Field | Type | Description |
|-------|------|-------------|
| hypotheticalCost | number | Cost if all implementation done by planner |
| actualPlannerCost | number | Actual planner token cost (planning + escalation) |
| actualImplementerCost | number | Actual implementer token cost ($0 for local) |
| totalActualCost | number | actualPlannerCost + actualImplementerCost |
| savingsAmount | number | hypotheticalCost - totalActualCost |
| savingsPercentage | number | (savingsAmount / hypotheticalCost) * 100 |
| localCompletionRate | number | Tasks completed locally / total tasks * 100 |

### Config.planner (modified)

Expanding from hardcoded `{ tool: 'claude-code' }` to support multiple backends.

| Field | Type | Description |
|-------|------|-------------|
| tool | 'claude-code' or 'codex' or 'opencode' or 'aider' or 'agent-sdk' | Selected planner backend |
| model | string (optional) | Override model selection for backends that support it |
| apiKey | string (optional) | API key for backends that require it (agent-sdk, codex) |
| apiBase | string (optional) | Custom API base URL |

### Summary (existing — extended)

| Field | Type | Change |
|-------|------|--------|
| feature | string | unchanged |
| totalTasks | number | unchanged |
| completedByLocal | number | unchanged |
| escalatedToOpus | number | rename to `escalatedToPlanner` |
| failed | number | unchanged |
| skipped | number | unchanged |
| tokenUsage | TokenUsage | unchanged |
| estimatedCostSavings | string | unchanged |
| escalationRate | number | unchanged |
| totalTime | number | unchanged |
| **taskBreakdown** | **TaskTokenUsage[]** | **NEW** |
| **costBreakdown** | **CostBreakdown** | **NEW** |
| **plannerName** | **string** | **NEW** |
| **implementerName** | **string** | **NEW** |

## State Transitions

No new phases needed. The existing state machine handles all flows:

```
idle → researching → specifying → reviewing-spec → planning → reviewing-plan
    → implementing → validating-task → escalating → final-review → complete
```

The planner backend is selected at startup and doesn't change during a workflow. Switching backends mid-workflow (via resume) is not supported — the system detects a mismatch and warns.

## Event Log (events.jsonl)

New event types for per-task token tracking:

```jsonl
{"ts":"...","type":"task_tokens","taskId":"T001","method":"local","implementerTokens":1234,"escalationTokens":0,"retryCount":0}
{"ts":"...","type":"task_tokens","taskId":"T002","method":"escalated-hint","implementerTokens":3456,"escalationTokens":512,"retryCount":3}
{"ts":"...","type":"planner_tokens","phase":"research","inputTokens":5000,"outputTokens":2000}
{"ts":"...","type":"cost_summary","hypothetical":42.50,"actual":4.35,"savings":38.15,"savingsPercent":89.7}
```

## Pricing Table

Static lookup, maintained in `src/orchestrator/pricing.ts`:

```typescript
const PRICING: Record<string, PricingInfo> = {
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25, isLocal: false, name: 'Claude Opus 4.6' },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15, isLocal: false, name: 'Claude Sonnet 4.6' },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, isLocal: false, name: 'GPT-4o' },
  'o3': { inputPer1M: 2, outputPer1M: 8, isLocal: false, name: 'o3' },
  'deepseek-chat': { inputPer1M: 0.28, outputPer1M: 0.42, isLocal: false, name: 'DeepSeek V3' },
  'ollama': { inputPer1M: 0, outputPer1M: 0, isLocal: true, name: 'Ollama (local)' },
  'lm-studio': { inputPer1M: 0, outputPer1M: 0, isLocal: true, name: 'LM Studio (local)' },
};
```
