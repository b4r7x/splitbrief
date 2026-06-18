import { createStore, storeBase } from '../create-store.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { Phase, TaskCompletionMethod } from '../../core/schemas/enums.js';
import { attributePhaseTokenDelta } from '../../core/state/token-attribution.js';
import * as typeGuards from '../../utils/type-guards.js';

export interface PhaseTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  plannerInputTokens?: number | undefined;
  plannerOutputTokens?: number | undefined;
  plannerCacheReadTokens?: number | undefined;
  plannerCacheCreateTokens?: number | undefined;
  implementerInputTokens?: number | undefined;
  implementerOutputTokens?: number | undefined;
  implementerCacheReadTokens?: number | undefined;
  implementerCacheCreateTokens?: number | undefined;
}

export interface TaskAttemptTokens {
  method: TaskCompletionMethod;
  implementerTokens: number;
  escalationTokens: number;
  retryCount: number;
  tool?: string | undefined;
  model?: string | undefined;
}

export interface PerTaskTokens {
  totalTokens: number;
  title: string;
  attempts?: TaskAttemptTokens[] | undefined;
}

export interface TokensState {
  localCount: number;
  escalatedCount: number;
  tokenUsage: TokenUsage | null;
  perPhase: Partial<Record<Phase, PhaseTokens>>;
  perTask: Record<string, PerTaskTokens>;
  prediction: CostPrediction | null;
  completedTaskCount: number;
  pricingContext: PricingContext | null;
}

interface PricingContext {
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
}

const initial: TokensState = {
  localCount: 0,
  escalatedCount: 0,
  tokenUsage: null,
  perPhase: {},
  perTask: {},
  prediction: null,
  completedTaskCount: 0,
  pricingContext: null,
};

const store = createStore<TokensState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<TokensState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
export const _tokensInternal = { set: store.set };

export const tokensStore = {
  ...storeBase(store),
  __testReset,
};

const EMPTY_USAGE: TokenUsage = {
  plannerInput: 0,
  plannerOutput: 0,
  implementerInput: 0,
  implementerOutput: 0,
  escalationInput: 0,
  escalationOutput: 0,
};

function makeEmptyPhaseTokens(): PhaseTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCacheReadTokens: 0,
    plannerCacheCreateTokens: 0,
    implementerInputTokens: 0,
    implementerOutputTokens: 0,
    implementerCacheReadTokens: 0,
    implementerCacheCreateTokens: 0,
  };
}

export function updateTokens(state: TokensState, event: EngineEvent): TokensState {
  switch (event.type) {
    case 'workflow_config':
      return {
        ...state,
        pricingContext: {
          plannerTool: event.plannerTool,
          implementerTool: event.implementerTool,
          plannerModel: event.plannerModel,
          implementerModel: event.implementerModel,
        },
      };

    case 'cost_update': {
      const prev = state.tokenUsage ?? EMPTY_USAGE;
      const curr = event.tokenUsage;
      const phase = event.phase;

      const existingPhase = state.perPhase[phase] ?? makeEmptyPhaseTokens();

      const { planner: pd, implementer: id } = attributePhaseTokenDelta(prev, curr, phase);

      const updatedPhase: PhaseTokens = {
        inputTokens: existingPhase.inputTokens + pd.input + id.input,
        outputTokens: existingPhase.outputTokens + pd.output + id.output,
        cacheReadTokens: existingPhase.cacheReadTokens + pd.cacheRead + id.cacheRead,
        cacheCreateTokens: existingPhase.cacheCreateTokens + pd.cacheCreate + id.cacheCreate,
        plannerInputTokens: (existingPhase.plannerInputTokens ?? 0) + pd.input,
        plannerOutputTokens: (existingPhase.plannerOutputTokens ?? 0) + pd.output,
        plannerCacheReadTokens: (existingPhase.plannerCacheReadTokens ?? 0) + pd.cacheRead,
        plannerCacheCreateTokens: (existingPhase.plannerCacheCreateTokens ?? 0) + pd.cacheCreate,
        implementerInputTokens: (existingPhase.implementerInputTokens ?? 0) + id.input,
        implementerOutputTokens: (existingPhase.implementerOutputTokens ?? 0) + id.output,
        implementerCacheReadTokens: (existingPhase.implementerCacheReadTokens ?? 0) + id.cacheRead,
        implementerCacheCreateTokens:
          (existingPhase.implementerCacheCreateTokens ?? 0) + id.cacheCreate,
      };

      return {
        ...state,
        tokenUsage: event.tokenUsage,
        perPhase: { ...state.perPhase, [phase]: updatedPhase },
      };
    }

    case 'cost_prediction':
      return { ...state, prediction: event.prediction };

    case 'task_tokens': {
      const existing = state.perTask[event.taskId] ?? { totalTokens: 0, title: '', attempts: [] };
      // One attempt record per task_tokens event keeps each (re)run priced at its own
      // tool/model identity; display totals sum across attempts.
      const attempt: TaskAttemptTokens = {
        method: event.method,
        implementerTokens: event.implementerTokens,
        escalationTokens: event.escalationTokens,
        retryCount: event.retryCount,
        ...(event.tool !== undefined && { tool: event.tool }),
        ...(event.model !== undefined && { model: event.model }),
      };
      const attempts = [...(existing.attempts ?? []), attempt];
      const totalTokens = attempts.reduce(
        (sum, a) => sum + a.implementerTokens + a.escalationTokens,
        0,
      );
      return {
        ...state,
        perTask: { ...state.perTask, [event.taskId]: { ...existing, totalTokens, attempts } },
      };
    }

    case 'task_started': {
      const existing = state.perTask[event.taskId] ?? { totalTokens: 0, title: '', attempts: [] };
      return {
        ...state,
        perTask: { ...state.perTask, [event.taskId]: { ...existing, title: event.title } },
      };
    }

    case 'task_completed': {
      let { localCount, escalatedCount } = state;
      if (event.method === 'local' || event.method === 'mcp-tool') localCount += 1;
      else if (
        event.method === 'escalated-intermediate' ||
        event.method === 'escalated-hint' ||
        event.method === 'escalated-full'
      ) {
        escalatedCount += 1;
      }
      return {
        ...state,
        localCount,
        escalatedCount,
        completedTaskCount: state.completedTaskCount + 1,
      };
    }

    case 'task_reset': {
      // task_reset fires on two paths: a review redo (the task completed, so undo its
      // counters before the next task_completed) and a recovery retry of the current,
      // not-yet-completed task (nothing to undo). A recorded attempt only exists when the
      // task previously completed, so gate every decrement on the prior attempt's method.
      // Per-attempt token rows are kept across resets.
      const attempts = state.perTask[event.taskId]?.attempts ?? [];
      const last = attempts.at(-1);
      let { localCount, escalatedCount, completedTaskCount } = state;
      if (last) {
        if ((last.method === 'local' || last.method === 'mcp-tool') && localCount > 0) {
          localCount -= 1;
        } else if (
          (last.method === 'escalated-intermediate' ||
            last.method === 'escalated-hint' ||
            last.method === 'escalated-full') &&
          escalatedCount > 0
        ) {
          escalatedCount -= 1;
        }
        if (completedTaskCount > 0) completedTaskCount -= 1;
      }
      return { ...state, localCount, escalatedCount, completedTaskCount };
    }

    case 'task_skipped':
      return {
        ...state,
        completedTaskCount: state.completedTaskCount + 1,
      };

    case 'workflow_started':
    case 'workflow_resumed':
    case 'workflow_complete':
    case 'workflow_cancelled':
    case 'paused_external_changes':
    case 'recovery_prompted':
    case 'recovery_action_selected':
    case 'recovery_action_failed':
    case 'recovery_resolved':
    case 'planner_status':
    case 'planner_text':
    case 'planner_heartbeat':
    case 'runner_call_started':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_tool_use':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_completed':
    case 'spec_rejected':
    case 'spec_regenerated':
    case 'plan_approved':
    case 'plan_rejected':
    case 'plan_regenerated':
    case 'rewind_to_spec':
    case 'rewind_to_plan':
    case 'all_tasks_done':
    case 'brief_quality_passed':
    case 'brief_quality_failed':
    case 'drift_report':
    case 'drift_chain_detected':
    case 'snapshot_created':
    case 'snapshot_restored':
    case 'snapshot_restore_conflict':
    case 'mode_resolved':
    case 'mode_downgrade_advised':
    case 'mode_advice':
    case 'instant_plan_received':
    case 'task_retry':
    case 'task_escalating':
    case 'task_full_fail':
    case 'task_review_needed':
    case 'hint_failed':
    case 'implementer_generate_running':
    case 'implementer_generate_done':
    case 'implementer_generate_failed':
    case 'validate':
    case 'escalate':
    case 'git_commit':
    case 'git_checkpoint':
    case 'git_branch_created':
    case 'clarifications_collected':
    case 'clarification_answered':
    case 'message_queued':
    case 'message_injected_native':
    case 'queue_drained':
    case 'queue_cleared':
    case 'user_message':
    case 'planner_attachments_dropped':
    case 'budget_warning':
    case 'budget_paused':
    case 'budget_exceeded':
    case 'approval_prompted':
    case 'approval_granted':
    case 'approval_rejected':
    case 'approval_sticky_recorded':
    case 'approval_mode_changed':
    case 'ipc_server_started':
    case 'ipc_client_attached':
    case 'ipc_client_detached':
    case 'ipc_reconnect_attempt':
    case 'ipc_reconnect_failed':
    case 'replay_started':
    case 'replay_complete':
    case 'warning':
    case 'error':
      return state;

    default:
      return typeGuards.assertNever(event);
  }
}
