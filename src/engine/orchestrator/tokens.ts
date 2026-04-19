import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TokenUsage, TokenDelta, TaskTokenUsage } from '../../core/schemas/tokens.js';
import { emit } from './events.js';

export type UsageCategory = 'planner' | 'implementer' | 'escalation';

const categoryFields: Record<UsageCategory, { input: keyof TokenUsage; output: keyof TokenUsage }> = {
  planner: { input: 'plannerInput', output: 'plannerOutput' },
  implementer: { input: 'implementerInput', output: 'implementerOutput' },
  escalation: { input: 'escalationInput', output: 'escalationOutput' },
};

export function addUsage(
  state: WorkflowState,
  category: UsageCategory,
  usage: TokenDelta | null | undefined,
): WorkflowState {
  if (!usage) return state;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const fields = categoryFields[category];
  return {
    ...state,
    tokenUsage: {
      ...state.tokenUsage,
      [fields.input]: state.tokenUsage[fields.input] + input,
      [fields.output]: state.tokenUsage[fields.output] + output,
    },
  };
}

function tokenDelta(before: TokenUsage, after: TokenUsage): { implementerTokens: number; escalationTokens: number } {
  const implementerBefore = before.implementerInput + before.implementerOutput;
  const implementerAfter = after.implementerInput + after.implementerOutput;
  const escalationBefore = before.escalationInput + before.escalationOutput;
  const escalationAfter = after.escalationInput + after.escalationOutput;
  return {
    implementerTokens: implementerAfter - implementerBefore,
    escalationTokens: escalationAfter - escalationBefore,
  };
}

export function emitTaskTokens(projectDir: string, sessionId: string, state: WorkflowState, id: TaskId, usage: TaskTokenUsage): void {
  emit(projectDir, sessionId, state, 'task_tokens', id, {
    method: usage.method,
    implementerTokens: usage.implementerTokens,
    escalationTokens: usage.escalationTokens,
    retryCount: usage.retryCount,
  });
}

type RecordTaskUsageOptions = {
  task: Task;
  method: TaskTokenUsage['method'];
  tokensBefore: TokenUsage;
  currentUsage: TokenUsage;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  retryCount?: number;
  tool?: string;
  model?: string;
};

export function recordTaskUsage(opts: RecordTaskUsageOptions): void {
  const { task, method, tokensBefore, currentUsage, projectDir, sessionId, state, taskBreakdowns, retryCount, tool, model } = opts;
  const delta = tokenDelta(tokensBefore, currentUsage);
  const usage: TaskTokenUsage = {
    taskId: task.id, taskTitle: task.title, method,
    implementerTokens: delta.implementerTokens, escalationTokens: delta.escalationTokens,
    retryCount: retryCount ?? 0,
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
  };
  taskBreakdowns.push(usage);
  emitTaskTokens(projectDir, sessionId, state, task.id, usage);
}
