# Contract: Orchestrator Event Callbacks

**Feature**: `008-tui-conversation-flow`

## Current Interface (to be replaced)

```typescript
interface OrchestratorCallbacks {
  onPhaseChange: (phase: Phase) => void;
  onPlannerOutput: (text: string) => void;
  onImplementerOutput: (text: string) => void;
  onTaskStart: (task: Task, index: number, total: number) => void;
  onTaskComplete: (task: Task, method: 'local' | 'escalated') => void;
  onTaskRetry: (task: Task, attempt: number, error: string) => void;
  onTaskSkipped: (task: Task, reason: string) => void;
  onValidationResult: (task: Task, results: ValidationResult[]) => void;
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: (question: ClarificationQuestion, num: number, total: number) => Promise<string>;
  onComplete: (summary: Summary) => void;
  onError: (error: string) => void;
}
```

## New Interface

```typescript
interface OrchestratorCallbacks {
  // Unidirectional: structured events for TUI rendering
  onEvent: (event: TuiEvent) => void;

  // Bidirectional: interactive callbacks preserved (orchestrator blocks on these)
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: (question: ClarificationQuestion, num: number, total: number) => Promise<string>;

  // Lifecycle: triggers screen switch
  onComplete: (summary: Summary) => void;
}
```

## Migration Map

| Old Callback | New Mechanism | Notes |
|-------------|--------------|-------|
| `onPhaseChange(phase)` | `onEvent({ type: 'planner-status', phase, status })` | Status derived from phase transitions |
| `onPlannerOutput(text)` | `onEvent({ type: 'planner-text', text })` | Same streaming granularity |
| `onImplementerOutput(text)` | `onEvent({ type: 'planner-text', text })` for escalation output; no direct event for raw implementer text (replaced by `implementer-generate` events) | Raw implementer text is replaced by structured generation events |
| `onTaskStart(task, idx, total)` | `onEvent({ type: 'task-start', taskId, title, index, total, file, action })` | Extract fields from Task object |
| `onTaskComplete(task, method)` | `onEvent({ type: 'task-complete', taskId, title, method, retries, duration })` | Add duration tracking |
| `onTaskRetry(task, attempt, error)` | `onEvent({ type: 'retry', taskId, attempt, maxRetries })` | Drop raw error (shown in validate event) |
| `onTaskSkipped(task, reason)` | `onEvent({ type: 'task-skipped', taskId, title, reason })` | Direct mapping |
| `onValidationResult(task, results)` | `onEvent({ type: 'validate', passed, stages, error, duration })` | Flatten ValidationResult[] to compact format |
| `onError(error)` | `onEvent({ type: 'error', message })` | Direct mapping |
| `onApprovalNeeded` | Preserved as-is | Interactive, Promise-based |
| `onExternalChanges` | Preserved as-is | Interactive, Promise-based |
| `onQuestionAsked` | Preserved as-is | Interactive, Promise-based |
| `onComplete` | Preserved as-is | Triggers summary screen |

## New Events (not in old callbacks)

| Event | Emit Location | Data |
|-------|-------------|------|
| `implementer-generate` | After `applyCode()` in `implementer.ts` | file, linesAdded, linesRemoved, diff, duration, model |
| `git-commit` | After `gitCommit()` in orchestrator | commit message |
| `escalate` | Before/after escalation calls in orchestrator | tier (1/2), hint text |
