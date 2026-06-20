import type { EngineEvent, EventSink } from '../types.js';
import { taskIdToString } from '../../../core/schemas/task.js';
import type { TreeEntryEnvelope } from '../../../core/sessions/tree/schemas.js';
import type { SessionTree } from '../../../core/sessions/tree/store.js';
import { createEmptyTree, appendEntry, branchFrom } from '../../../core/sessions/tree/store.js';
import {
  persistAppend,
  writeTreeMeta,
  appendTreeEntry,
  reconstructTree,
} from '../../../core/sessions/tree/io.js';
import { sessionDir } from '../../../core/paths.js';
import { warnError } from '../../../lib/warn.js';
import { totalInputTokens, totalOutputTokens } from '../../../core/schemas/tokens.js';
import { projectEngineEventForTranscriptPolicy } from '../protection.js';
import type {
  AgentInvocationPayload,
  CostCheckpointPayload,
  PlanStepPayload,
  RecoveryDecisionPayload,
} from '../../../core/sessions/tree/payloads.js';
import * as typeGuards from '../../../utils/type-guards.js';

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

// All disk I/O is wrapped in try/catch — persistence failures must not crash the workflow.
export function createTreeRecorderSink(opts: TreeRecorderOptions): EventSink {
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  const persistTranscript = opts.persistTranscript ?? true;

  let tree: SessionTree | null = null;
  const taskStartTimes = new Map<string, number>();
  const taskTokens = new Map<string, number>();

  function persist(entry: TreeEntryEnvelope): void {
    if (!tree) return;
    try {
      persistAppend(dir, entry, tree.meta);
    } catch (err) {
      warnError('session-tree: persist failed', err);
    }
  }

  function initializeTree(ts: number): SessionTree | null {
    const existing = reconstructTree(dir);
    if (existing) return existing;

    const fresh = createEmptyTree(ts);
    const root = fresh.entries.get(fresh.meta.leafId);
    if (!root) return null;
    try {
      appendTreeEntry(dir, root);
      writeTreeMeta(dir, fresh.meta);
    } catch (err) {
      warnError('session-tree: initial write failed', err);
    }
    return fresh;
  }

  return (rawEvent: EngineEvent) => {
    const event = projectEngineEventForTranscriptPolicy(rawEvent, persistTranscript);
    if (event === null) return;

    switch (event.type) {
      case 'workflow_started': {
        tree = initializeTree(event.ts);
        return;
      }

      case 'workflow_resumed': {
        if (!tree) {
          tree = reconstructTree(dir) ?? initializeTree(event.ts);
        }
        return;
      }

      case 'task_started': {
        if (!tree) return;
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
          const result = appendEntry(tree, {
            type: 'agent-invocation',
            payload,
            timestamp: event.ts,
          });
          tree = result.tree;
          persist(result.entry);
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
        const result = appendEntry(tree, {
          type: 'plan-step',
          payload,
          timestamp: event.ts,
          display: true,
        });
        tree = result.tree;
        persist(result.entry);
        return;
      }

      case 'task_tokens': {
        if (!tree) return;
        taskTokens.set(
          taskIdToString(event.taskId),
          event.implementerTokens + event.escalationTokens,
        );
        return;
      }

      case 'task_completed': {
        if (!tree) return;
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
        const result = appendEntry(tree, {
          type: 'agent-invocation',
          payload,
          timestamp: event.ts,
        });
        tree = result.tree;
        persist(result.entry);
        taskTokens.delete(taskIdToString(event.taskId));
        taskStartTimes.delete(taskIdToString(event.taskId));
        return;
      }

      case 'task_full_fail': {
        if (!tree) return;
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
        const result = appendEntry(tree, {
          type: 'agent-invocation',
          payload,
          timestamp: event.ts,
        });
        tree = result.tree;
        persist(result.entry);
        taskTokens.delete(taskIdToString(event.taskId));
        taskStartTimes.delete(taskIdToString(event.taskId));
        return;
      }

      case 'recovery_action_selected': {
        if (!tree) return;
        const payload: RecoveryDecisionPayload = {
          issueId: event.issueId,
          reason: event.reason,
          selectedAction: event.action,
          availableActions: [event.action],
          message: `Recovery: ${event.action}`,
        };

        if (BRANCHING_ACTIONS.has(event.action)) {
          const branchFromId = tree.meta.leafId;
          const result = branchFrom(tree, {
            fromId: branchFromId,
            type: 'recovery-decision',
            payload,
            timestamp: event.ts,
            display: true,
          });
          tree = result.tree;
          persist(result.entry);
        } else {
          const result = appendEntry(tree, {
            type: 'recovery-decision',
            payload,
            timestamp: event.ts,
            display: true,
          });
          tree = result.tree;
          persist(result.entry);
        }
        return;
      }

      case 'cost_update': {
        if (!tree) return;
        const payload: CostCheckpointPayload = {
          inputTokens: totalInputTokens(event.tokenUsage),
          outputTokens: totalOutputTokens(event.tokenUsage),
          phase: event.phase,
        };
        const result = appendEntry(tree, {
          type: 'cost-checkpoint',
          payload,
          timestamp: event.ts,
        });
        tree = result.tree;
        persist(result.entry);
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
      case 'runner_call_started':
      case 'runner_call_text_delta':
      case 'runner_call_usage':
      case 'runner_call_tool_use':
      case 'runner_call_activity':
      case 'runner_call_session_id':
      case 'runner_call_artifact':
      case 'runner_call_warning':
      case 'runner_call_error':
      case 'runner_call_completed':
      case 'warning':
      case 'error':
        return;

      default:
        return typeGuards.assertNever(event);
    }
  };
}
