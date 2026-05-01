import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TokenUsage, TokenDelta, TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { EventBus } from '../events/types.js';
import type { RoutingDecision } from './context-routing.js';
import { publishEvent } from './events.js';

export type UsageCategory = 'planner' | 'implementer' | 'escalation';

type CoreTokenKey =
  | 'plannerInput'
  | 'plannerOutput'
  | 'implementerInput'
  | 'implementerOutput'
  | 'escalationInput'
  | 'escalationOutput';
type CacheTokenKey =
  | 'plannerCacheRead'
  | 'plannerCacheCreate'
  | 'implementerCacheRead'
  | 'implementerCacheCreate';

// escalation cache tokens are routed into the planner cache buckets because the escalator
// always uses the planner runner; this preserves cache savings without adding new schema fields.
const categoryFields: Record<UsageCategory, { input: CoreTokenKey; output: CoreTokenKey; cacheRead?: CacheTokenKey; cacheCreate?: CacheTokenKey }> = {
  planner: { input: 'plannerInput', output: 'plannerOutput', cacheRead: 'plannerCacheRead', cacheCreate: 'plannerCacheCreate' },
  implementer: { input: 'implementerInput', output: 'implementerOutput', cacheRead: 'implementerCacheRead', cacheCreate: 'implementerCacheCreate' },
  escalation: { input: 'escalationInput', output: 'escalationOutput', cacheRead: 'plannerCacheRead', cacheCreate: 'plannerCacheCreate' },
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
  const nextUsage = {
    ...state.tokenUsage,
    [fields.input]: state.tokenUsage[fields.input] + input,
    [fields.output]: state.tokenUsage[fields.output] + output,
  };
  if (fields.cacheRead !== undefined && usage.cacheReadTokens !== undefined) {
    nextUsage[fields.cacheRead] = (state.tokenUsage[fields.cacheRead] ?? 0) + usage.cacheReadTokens;
  }
  if (fields.cacheCreate !== undefined && usage.cacheCreateTokens !== undefined) {
    nextUsage[fields.cacheCreate] = (state.tokenUsage[fields.cacheCreate] ?? 0) + usage.cacheCreateTokens;
  }
  return {
    ...state,
    tokenUsage: nextUsage,
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

function emitTaskTokens(bus: EventBus, state: WorkflowState, id: TaskId, usage: TaskTokenUsage): void {
  publishEvent(bus, {
    type: 'task_tokens',
    ts: Date.now(),
    phase: state.phase,
    taskId: id,
    method: usage.method,
    implementerTokens: usage.implementerTokens,
    escalationTokens: usage.escalationTokens,
    retryCount: usage.retryCount,
    ...(usage.tool !== undefined && { tool: usage.tool }),
    ...(usage.model !== undefined && { model: usage.model }),
    ...(usage.implementerProfile !== undefined && { implementerProfile: usage.implementerProfile }),
    ...(usage.contextFit !== undefined && { contextFit: usage.contextFit }),
    ...(usage.estimatedTokens !== undefined && { estimatedTokens: usage.estimatedTokens }),
    ...(usage.untruncatedEstimatedTokens !== undefined && { untruncatedEstimatedTokens: usage.untruncatedEstimatedTokens }),
    ...(usage.contextLength !== undefined && { contextLength: usage.contextLength }),
    ...(usage.currentCodeTruncated !== undefined && { currentCodeTruncated: usage.currentCodeTruncated }),
    ...(usage.currentCodeContextMode !== undefined && { currentCodeContextMode: usage.currentCodeContextMode }),
    ...(usage.costPosture !== undefined && { costPosture: usage.costPosture }),
    ...(usage.routingReason !== undefined && { routingReason: usage.routingReason }),
  });
}

type RecordTaskUsageOptions = {
  task: Task;
  method: TaskTokenUsage['method'];
  tokensBefore: TokenUsage;
  currentUsage: TokenUsage;
  bus: EventBus;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  retryCount?: number;
  tool?: string;
  model?: string;
  implementerProfile?: string;
  routingDecision?: RoutingDecision;
};

export function recordTaskUsage(opts: RecordTaskUsageOptions): void {
  const { task, method, tokensBefore, currentUsage, bus, state, taskBreakdowns, retryCount, tool, model, implementerProfile, routingDecision } = opts;
  const delta = tokenDelta(tokensBefore, currentUsage);
  const usage: TaskTokenUsage = {
    taskId: task.id, taskTitle: task.title, method,
    implementerTokens: delta.implementerTokens, escalationTokens: delta.escalationTokens,
    retryCount: retryCount ?? 0,
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
    ...(implementerProfile !== undefined && { implementerProfile }),
    ...(routingDecision !== undefined && {
      contextFit: routingDecision.fit,
      estimatedTokens: routingDecision.estimatedTokens,
      untruncatedEstimatedTokens: routingDecision.untruncatedEstimatedTokens,
      ...(routingDecision.contextLength !== undefined && { contextLength: routingDecision.contextLength }),
      currentCodeTruncated: routingDecision.currentCodeTruncated,
      currentCodeContextMode: routingDecision.currentCodeContextMode,
      costPosture: routingDecision.costPosture,
      routingReason: routingDecision.reason,
    }),
  };
  taskBreakdowns.push(usage);
  emitTaskTokens(bus, state, task.id, usage);
}
