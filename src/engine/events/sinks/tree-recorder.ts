import type { EngineEvent, EventSink } from '../types.js';
import { EngineEventSchema } from '../schema.js';
import { taskIdToString } from '../../../core/schemas/task.js';
import { sessionDir } from '../../../core/paths.js';
import { totalInputTokens, totalOutputTokens } from '../../../core/schemas/tokens.js';
import { protectEngineEventForConsumer } from '../protection/protect.js';
import type {
  AgentInvocationPayload,
  CostCheckpointPayload,
  PlanStepPayload,
  RecoveryDecisionPayload,
} from '../../../core/sessions/tree/payloads.js';
import {
  AgentInvocationPayloadSchema,
  CostCheckpointPayloadSchema,
  PlanStepPayloadSchema,
  RecoveryDecisionPayloadSchema,
} from '../../../core/sessions/tree/payloads.js';
import { reconstructTree } from '../../../core/sessions/tree/io.js';
import * as typeGuards from '../../../utils/type-guards.js';
import {
  appendProtectedEntry,
  branchProtectedEntry,
  createTreePersistence,
} from './tree-recorder/persistence.js';
import {
  createRunnerInvocationState,
  runnerStartedPayload,
  runnerTerminalPayload,
} from './tree-recorder/runner-invocation.js';

export interface TreeRecorderOptions {
  projectDir: string;
  sessionId: string;
  persistTranscript?: boolean | undefined;
}

const BRANCHING_ACTIONS = new Set([
  'retry-same-worker',
  'route-bigger-worker',
  'planner-split-rebase',
]);

const RECOVERY_ENTRY_TYPE = 'recovery-event';

export function createTreeRecorderSink(opts: TreeRecorderOptions): EventSink {
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  const persistTranscript = opts.persistTranscript ?? true;
  const persistence = createTreePersistence(dir);
  const runnerState = createRunnerInvocationState();

  const taskStartTimes = new Map<string, number>();
  const taskTokens = new Map<string, number>();
  const recoveryEventIds = new Set<string>();

  function rememberRecoveryEventIds(): void {
    const currentTree = persistence.getTree();
    if (!currentTree) return;
    for (const entry of currentTree.entries.values()) {
      if (entry.type !== RECOVERY_ENTRY_TYPE || !typeGuards.isRecord(entry.payload)) continue;
      const eventId = entry.payload.eventId;
      if (typeof eventId === 'string') recoveryEventIds.add(eventId);
    }
  }

  return (rawEvent: EngineEvent) => {
    const event = protectEngineEventForConsumer(rawEvent, { context: 'tree', persistTranscript });
    if (event === null) return;

    const tree = () => persistence.getTree();

    switch (event.type) {
      case 'workflow_started': {
        persistence.setTree(persistence.initializeTree(event.ts));
        rememberRecoveryEventIds();
        return;
      }

      case 'workflow_resumed': {
        if (!tree()) {
          persistence.setTree(reconstructTree(dir) ?? persistence.initializeTree(event.ts));
        }
        rememberRecoveryEventIds();
        return;
      }

      case 'task_started': {
        const currentTree = tree();
        if (!currentTree) return;
        taskStartTimes.set(taskIdToString(event.taskId), event.ts);
        if (!persistTranscript) {
          const payload: AgentInvocationPayload = {
            taskId: event.taskId,
            role: 'implementer',
            tool: event.tool ?? 'unknown',
            ...(event.model !== undefined && { model: event.model }),
            phase: event.phase,
            status: 'started',
          };
          const result = appendProtectedEntry(currentTree, {
            type: 'agent-invocation',
            payload,
            schema: AgentInvocationPayloadSchema,
            timestamp: event.ts,
          });
          if (!persistence.commitAppendResult(result)) return;
          return;
        }

        const payload: PlanStepPayload = {
          taskId: event.taskId,
          title: event.title,
          file: event.file,
          action: event.action,
          description: event.title,
          index: event.index,
          total: event.total,
        };
        const result = appendProtectedEntry(currentTree, {
          type: 'plan-step',
          payload,
          schema: PlanStepPayloadSchema,
          timestamp: event.ts,
          display: true,
        });
        if (!persistence.commitAppendResult(result)) return;
        return;
      }

      case 'task_tokens': {
        if (!tree()) return;
        taskTokens.set(
          taskIdToString(event.taskId),
          event.implementerTokens + event.escalationTokens,
        );
        return;
      }

      case 'task_completed': {
        const currentTree = tree();
        if (!currentTree) return;
        const payload: AgentInvocationPayload = {
          taskId: event.taskId,
          role: 'implementer',
          tool: event.tool ?? 'unknown',
          model: event.model,
          phase: event.phase,
          status: 'completed',
          durationMs: event.duration,
          tokensUsed: taskTokens.get(taskIdToString(event.taskId)),
        };
        const result = appendProtectedEntry(currentTree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        if (!persistence.commitAppendResult(result)) return;
        taskTokens.delete(taskIdToString(event.taskId));
        taskStartTimes.delete(taskIdToString(event.taskId));
        return;
      }

      case 'task_full_fail': {
        const currentTree = tree();
        if (!currentTree) return;
        const startTime = taskStartTimes.get(taskIdToString(event.taskId));
        const payload: AgentInvocationPayload = {
          taskId: event.taskId,
          role: 'implementer',
          tool: 'unknown',
          phase: event.phase,
          status: 'failed',
          durationMs: startTime !== undefined ? event.ts - startTime : undefined,
          tokensUsed: taskTokens.get(taskIdToString(event.taskId)),
        };
        const result = appendProtectedEntry(currentTree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        if (!persistence.commitAppendResult(result)) return;
        taskTokens.delete(taskIdToString(event.taskId));
        taskStartTimes.delete(taskIdToString(event.taskId));
        return;
      }

      case 'recovery_action_selected': {
        const currentTree = tree();
        if (!currentTree) return;
        const payload: RecoveryDecisionPayload = {
          issueId: event.issueId,
          reason: event.reason,
          selectedAction: event.action,
          availableActions: [event.action],
          message: `Recovery: ${event.action}`,
        };

        if (BRANCHING_ACTIONS.has(event.action)) {
          const branchFromId = currentTree.meta.leafId;
          const result = branchProtectedEntry(currentTree, {
            fromId: branchFromId,
            type: 'recovery-decision',
            payload,
            schema: RecoveryDecisionPayloadSchema,
            timestamp: event.ts,
            display: true,
          });
          if (!persistence.commitAppendResult(result)) return;
        } else {
          const result = appendProtectedEntry(currentTree, {
            type: 'recovery-decision',
            payload,
            schema: RecoveryDecisionPayloadSchema,
            timestamp: event.ts,
            display: true,
          });
          if (!persistence.commitAppendResult(result)) return;
        }
        return;
      }

      case 'cost_update': {
        const currentTree = tree();
        if (!currentTree) return;
        const payload: CostCheckpointPayload = {
          inputTokens: totalInputTokens(event.tokenUsage),
          outputTokens: totalOutputTokens(event.tokenUsage),
          phase: event.phase,
        };
        const result = appendProtectedEntry(currentTree, {
          type: 'cost-checkpoint',
          payload,
          schema: CostCheckpointPayloadSchema,
          timestamp: event.ts,
        });
        if (!persistence.commitAppendResult(result)) return;
        return;
      }

      case 'runner_call_started': {
        const currentTree = tree();
        if (!currentTree) return;
        const payload = runnerStartedPayload(event);
        const result = appendProtectedEntry(currentTree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        if (!persistence.commitAppendResult(result)) return;
        return;
      }

      case 'runner_call_warning': {
        if (!tree()) return;
        runnerState.recordRunnerWarning(event);
        return;
      }

      case 'runner_call_error': {
        const currentTree = tree();
        if (!currentTree) return;
        const payload = runnerTerminalPayload(event, runnerState.runnerWarningFields(event.callId));
        const result = appendProtectedEntry(currentTree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        runnerState.clearRunnerWarnings(event.callId);
        if (!persistence.commitAppendResult(result)) return;
        return;
      }

      case 'runner_call_completed': {
        const currentTree = tree();
        if (!currentTree) return;
        const payload = runnerTerminalPayload(event, runnerState.runnerWarningFields(event.callId));
        const result = appendProtectedEntry(currentTree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        runnerState.clearRunnerWarnings(event.callId);
        if (!persistence.commitAppendResult(result)) return;
        return;
      }

      case 'brief_recovery_quality_reported':
      case 'brief_recovery_auto_repair_exhausted':
      case 'brief_recovery_attempt_accepted':
      case 'brief_recovery_attempt_started':
      case 'brief_recovery_attempt_settled':
      case 'brief_recovery_attempt_unresolved':
      case 'brief_recovery_provider_failed':
      case 'brief_recovery_input_queued':
      case 'brief_recovery_input_applied':
      case 'brief_recovery_stale_ignored':
      case 'brief_recovery_rejected':
      case 'brief_recovery_refused':
      case 'brief_recovery_transition':
      case 'brief_recovery_accepted':
      case 'brief_generation_published':
      case 'brief_execution_permit_issued': {
        const currentTree = tree();
        if (!currentTree || recoveryEventIds.has(event.eventId)) return;
        const recoveryPayload: EngineEvent = event;
        const result = appendProtectedEntry(currentTree, {
          type: RECOVERY_ENTRY_TYPE,
          payload: recoveryPayload,
          schema: EngineEventSchema,
          timestamp: event.ts,
        });
        if (!persistence.commitAppendResult(result)) return;
        recoveryEventIds.add(event.eventId);
        return;
      }

      case 'workflow_complete':
      case 'workflow_cancelled':
      case 'workflow_config':
      case 'paused_external_changes':
      case 'recovery_prompted':
      case 'recovery_action_failed':
      case 'recovery_resolved':
      case 'planner_status':
      case 'planner_text':
      case 'planner_heartbeat':
      case 'turn_interrupted':
      case 'artifact_written':
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
      case 'brief_readiness_passed':
      case 'brief_readiness_blocked':
      case 'drift_report':
      case 'drift_chain_detected':
      case 'snapshot_created':
      case 'snapshot_restored':
      case 'snapshot_restore_conflict':
      case 'mode_resolved':
      case 'mode_advice':
      case 'instant_plan_received':
      case 'tasks_planned':
      case 'task_skipped':
      case 'task_retry':
      case 'task_escalating':
      case 'task_reset':
      case 'task_review_needed':
      case 'hint_failed':
      case 'implementer_generate_running':
      case 'implementer_generate_done':
      case 'implementer_generate_failed':
      case 'validate':
      case 'validation_baseline':
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
      case 'cost_prediction':
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
      case 'runner_call_text_delta':
      case 'runner_call_usage':
      case 'runner_call_tool_use':
      case 'runner_call_activity':
      case 'runner_call_session_id':
      case 'runner_call_artifact':
      case 'runner_call_stalled':
      case 'runner_call_stall_cleared':
      case 'warning':
      case 'error':
        return;

      default:
        return typeGuards.assertNever(event);
    }
  };
}
