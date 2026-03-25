# Data Model: tiny-spec v0.1

**Source**: [spec.md](spec.md) Key Entities section

## Entities

### Config

User's preferences. Loaded from `.tiny-spec/config.yaml`, merged with defaults.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| planner.tool | `'claude-code'` | `'claude-code'` | Planning tool (only claude-code in v0.1) |
| implementer.provider | `'ollama' \| 'lm-studio' \| 'deepseek' \| 'openrouter'` | `'ollama'` | Implementation model provider |
| implementer.model | `string` | `'qwen2.5-coder:7b'` | Model identifier |
| implementer.apiBase | `string` | (provider default) | API base URL override |
| implementer.contextLength | `number` | `32768` | Context window to use |
| implementer.temperature | `number` | `0.3` | Sampling temperature |
| validation.typecheck | `boolean` | `true` | Run tsc --noEmit |
| validation.lint | `boolean` | `true` | Run linter |
| validation.test | `boolean` | `true` | Run tests |
| validation.testCommand | `string` | `'npm test'` | Custom test command |
| workflow.autoApproveSpec | `boolean` | `false` | Skip spec approval prompt |
| workflow.autoApprovePlan | `boolean` | `false` | Skip plan approval prompt |
| workflow.maxRetries | `number` | `3` | Retries before escalation |
| workflow.commitPerTask | `boolean` | `true` | Git commit after each task |

### WorkflowState

Current progress through the pipeline. Persisted to `.tiny-spec/current/state.json`.

| Field | Type | Description |
|-------|------|-------------|
| phase | `Phase` | Current workflow phase |
| feature | `string` | Feature description from user |
| currentTaskIndex | `number` | Index into tasks array |
| attempt | `number` | Current retry attempt (0-3) |
| tasks | `Task[]` | All tasks |
| completedTasks | `string[]` | Task IDs completed by local model |
| escalatedTasks | `string[]` | Task IDs escalated to Opus |
| skippedTasks | `string[]` | Task IDs skipped (dependency failure) |
| failedTasks | `string[]` | Task IDs that failed even after escalation |
| sessionId | `string \| null` | Claude Code session ID for multi-turn |
| startedAt | `string` | ISO timestamp |
| tokenUsage | `TokenUsage` | Accumulated token counts |

### Phase (enum)

```
idle → researching → specifying → reviewing-spec → planning →
reviewing-plan → implementing → validating-task → escalating →
final-review → complete
```

### Task

Atomic unit of implementation. Parsed from tasks.md YAML frontmatter + markdown body.

| Field | Type | Description |
|-------|------|-------------|
| id | `string` | Task identifier (e.g., "T001") |
| title | `string` | Human-readable title |
| action | `'create' \| 'modify'` | Whether to create or modify a file |
| file | `string` | Target file path (relative to project root) |
| dependsOn | `string[]` | Task IDs that must complete first |
| description | `string` | What to implement |
| signature | `string \| undefined` | Exact function signature with types |
| currentCode | `string \| undefined` | Current file contents (for modify tasks) |
| tests | `string[]` | Concrete test cases with expected values |
| constraints | `string[]` | What NOT to do |
| pattern | `string \| undefined` | Example from codebase to follow |
| status | `TaskStatus` | Current status |

### TaskStatus (enum)

`pending → in_progress → done | failed | escalated | skipped`

### ValidationResult

| Field | Type | Description |
|-------|------|-------------|
| passed | `boolean` | Whether this validation step passed |
| stage | `'typecheck' \| 'lint' \| 'test'` | Which validation stage |
| error | `string \| undefined` | Error message if failed |
| output | `string \| undefined` | Raw command output |

### TokenUsage

| Field | Type | Description |
|-------|------|-------------|
| plannerInput | `number` | Tokens sent to Claude Code (estimated from stream) |
| plannerOutput | `number` | Tokens received from Claude Code |
| implementerInput | `number` | Tokens sent to local model |
| implementerOutput | `number` | Tokens received from local model |
| escalationInput | `number` | Tokens sent to Claude Code for escalation |
| escalationOutput | `number` | Tokens received from escalation |

### Summary

End-of-workflow report.

| Field | Type | Description |
|-------|------|-------------|
| feature | `string` | Feature description |
| totalTasks | `number` | Total task count |
| completedByLocal | `number` | Tasks completed by local model |
| escalatedToOpus | `number` | Tasks escalated to Opus |
| skipped | `number` | Tasks skipped (dependency failure) |
| failed | `number` | Tasks that failed even after escalation |
| totalTime | `number` | Elapsed time in ms |
| tokenUsage | `TokenUsage` | Token breakdown |
| estimatedCostSavings | `string` | Human-readable savings estimate |
| escalationRate | `number` | Percentage of tasks that escalated |

### Event (JSONL log entry)

| Field | Type | Description |
|-------|------|-------------|
| ts | `number` | Unix timestamp (ms) |
| type | `string` | Event type (e.g., 'task_start', 'task_complete', 'escalation') |
| taskId | `string \| undefined` | Related task ID |
| phase | `Phase` | Current phase |
| data | `Record<string, unknown>` | Event-specific data |

## State Transitions

### WorkflowState transitions

| From | Action | To | Side Effects |
|------|--------|-----|--------------|
| idle | START(feature) | researching | Create state.json, spawn claude -p |
| researching | RESEARCH_DONE | specifying | -- |
| specifying | SPEC_DONE | reviewing-spec | Save spec.md |
| reviewing-spec | APPROVE | planning | -- |
| reviewing-spec | REJECT | idle | Clear state |
| planning | PLAN_DONE | reviewing-plan | Save plan.md, tasks.md |
| reviewing-plan | APPROVE | implementing | Parse tasks, set currentTaskIndex=0 |
| reviewing-plan | REJECT | idle | Clear state |
| implementing | TASK_SENT | validating-task | -- |
| validating-task | VALIDATION_PASS | implementing | Commit, advance index |
| validating-task | VALIDATION_FAIL (attempt < max) | implementing | Increment attempt, retry |
| validating-task | VALIDATION_FAIL (attempt >= max) | escalating | -- |
| escalating | HINT_SUCCESS | implementing | Commit, advance index |
| escalating | HINT_FAIL | escalating | Full escalation |
| escalating | FULL_SUCCESS | implementing | Commit, advance index |
| escalating | FULL_FAIL | implementing | Mark failed, skip dependents, advance |
| implementing | ALL_DONE | final-review | Spawn claude -p for review |
| final-review | REVIEW_DONE | complete | Save summary |
| complete | -- | idle | Archive to history |
| * | CANCEL | idle | Save state for resume |

### Task status transitions

| From | Action | To |
|------|--------|-----|
| pending | START | in_progress |
| in_progress | VALIDATION_PASS | done |
| in_progress | ESCALATION_SUCCESS | escalated |
| in_progress | ESCALATION_FAIL | failed |
| pending | DEPENDENCY_FAILED | skipped |

## File Structure

```
.tiny-spec/
├── config.yaml              # User configuration (created by `tiny-spec init`)
├── current/                 # Active feature workspace
│   ├── spec.md              # Generated specification
│   ├── plan.md              # Generated implementation plan
│   ├── tasks.md             # Generated task list
│   ├── state.json           # Workflow state (current task, retries, etc.)
│   ├── events.jsonl         # Event log (append-only)
│   └── review.md            # Opus final review output
└── history/                 # Completed features (archived)
    └── 2026-03-25-user-auth/
        ├── spec.md
        ├── plan.md
        ├── tasks.md
        ├── review.md
        └── summary.json     # Summary with cost/token data
```
