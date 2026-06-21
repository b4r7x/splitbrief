import type { EngineEvent, EngineEventOf, EventSink } from '../types.js';
import type { z } from 'zod';
import { taskIdToString } from '../../../core/schemas/task.js';
import {
  TreeEntryEnvelopeSchema,
  type TreeEntryEnvelope,
} from '../../../core/sessions/tree/schemas.js';
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
import { protectConsumerPayload } from '../../../core/consumer-policy.js';
import { protectEngineEventForConsumer } from '../protection.js';
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
const MAX_RUNNER_TREE_WARNING_CODES = 64;

interface RunnerWarningSummary {
  count: number;
  codes: Set<string>;
}

type TreeAppendResult = ReturnType<typeof appendEntry>;
type TreeBranchResult = ReturnType<typeof branchFrom>;

interface ProtectedAppendOptions<TPayload> {
  type: string;
  payload: TPayload;
  schema: z.ZodType<TPayload>;
  timestamp: number;
  display?: boolean | undefined;
}

interface ProtectedBranchOptions<TPayload> extends ProtectedAppendOptions<TPayload> {
  fromId: TreeEntryEnvelope['id'];
}

// All disk I/O is wrapped in try/catch — persistence failures must not crash the workflow.
export function createTreeRecorderSink(opts: TreeRecorderOptions): EventSink {
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  const persistTranscript = opts.persistTranscript ?? true;

  let tree: SessionTree | null = null;
  const taskStartTimes = new Map<string, number>();
  const taskTokens = new Map<string, number>();
  const runnerWarnings = new Map<string, RunnerWarningSummary>();

  function persist(entry: TreeEntryEnvelope, meta: SessionTree['meta']): boolean {
    if (!tree) return false;
    const protectedEntry = protectTreeEntry(entry);
    if (protectedEntry === null) return false;
    try {
      persistAppend(dir, protectedEntry, meta);
      return true;
    } catch (err) {
      warnError('session-tree: persist failed', err);
      return false;
    }
  }

  function commitAppendResult(result: TreeAppendResult | TreeBranchResult | null): boolean {
    if (result === null) return false;
    if (!persist(result.entry, result.tree.meta)) return false;
    tree = result.tree;
    return true;
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

  function recordRunnerWarning(event: EngineEventOf<'runner_call_warning'>): void {
    const existing = runnerWarnings.get(event.callId) ?? { count: 0, codes: new Set<string>() };
    existing.count += 1;
    recordRunnerWarningCode(existing.codes, event.warning.code);
    runnerWarnings.set(event.callId, existing);
  }

  function runnerWarningFields(
    callId: string,
  ): Pick<AgentInvocationPayload, 'warningCount' | 'warningCodes'> {
    const summary = runnerWarnings.get(callId);
    if (summary === undefined || summary.count === 0) return {};
    return {
      warningCount: summary.count,
      warningCodes: Array.from(summary.codes).sort().slice(0, MAX_RUNNER_TREE_WARNING_CODES),
    };
  }

  function clearRunnerWarnings(callId: string): void {
    runnerWarnings.delete(callId);
  }

  return (rawEvent: EngineEvent) => {
    const event = protectEngineEventForConsumer(rawEvent, { context: 'tree', persistTranscript });
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
          const result = appendProtectedEntry(tree, {
            type: 'agent-invocation',
            payload,
            schema: AgentInvocationPayloadSchema,
            timestamp: event.ts,
          });
          if (!commitAppendResult(result)) return;
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
        const result = appendProtectedEntry(tree, {
          type: 'plan-step',
          payload,
          schema: PlanStepPayloadSchema,
          timestamp: event.ts,
          display: true,
        });
        if (!commitAppendResult(result)) return;
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
        const result = appendProtectedEntry(tree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        if (!commitAppendResult(result)) return;
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
        const result = appendProtectedEntry(tree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        if (!commitAppendResult(result)) return;
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
          const result = branchProtectedEntry(tree, {
            fromId: branchFromId,
            type: 'recovery-decision',
            payload,
            schema: RecoveryDecisionPayloadSchema,
            timestamp: event.ts,
            display: true,
          });
          if (!commitAppendResult(result)) return;
        } else {
          const result = appendProtectedEntry(tree, {
            type: 'recovery-decision',
            payload,
            schema: RecoveryDecisionPayloadSchema,
            timestamp: event.ts,
            display: true,
          });
          if (!commitAppendResult(result)) return;
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
        const result = appendProtectedEntry(tree, {
          type: 'cost-checkpoint',
          payload,
          schema: CostCheckpointPayloadSchema,
          timestamp: event.ts,
        });
        if (!commitAppendResult(result)) return;
        return;
      }

      case 'runner_call_started': {
        if (!tree) return;
        const payload = runnerStartedPayload(event);
        const result = appendProtectedEntry(tree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        if (!commitAppendResult(result)) return;
        return;
      }

      case 'runner_call_warning': {
        if (!tree) return;
        recordRunnerWarning(event);
        return;
      }

      case 'runner_call_error': {
        if (!tree) return;
        const payload = runnerTerminalPayload(event, runnerWarningFields(event.callId));
        const result = appendProtectedEntry(tree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        clearRunnerWarnings(event.callId);
        if (!commitAppendResult(result)) return;
        return;
      }

      case 'runner_call_completed': {
        if (!tree) return;
        const payload = runnerTerminalPayload(event, runnerWarningFields(event.callId));
        const result = appendProtectedEntry(tree, {
          type: 'agent-invocation',
          payload,
          schema: AgentInvocationPayloadSchema,
          timestamp: event.ts,
        });
        clearRunnerWarnings(event.callId);
        if (!commitAppendResult(result)) return;
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
      case 'runner_call_text_delta':
      case 'runner_call_usage':
      case 'runner_call_tool_use':
      case 'runner_call_activity':
      case 'runner_call_session_id':
      case 'runner_call_artifact':
      case 'warning':
      case 'error':
        return;

      default:
        return typeGuards.assertNever(event);
    }
  };
}

function runnerStartedPayload(event: EngineEventOf<'runner_call_started'>): AgentInvocationPayload {
  return {
    callId: event.callId,
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    role: event.role,
    backendKind: event.backendKind,
    tool: event.runnerName ?? event.backendKind,
    ...(event.model !== undefined && { model: event.model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
    phase: event.phase,
    status: 'started',
    startedAt: event.ts,
  };
}

function recordRunnerWarningCode(codes: Set<string>, code: string): void {
  if (codes.has(code)) return;
  if (codes.size < MAX_RUNNER_TREE_WARNING_CODES) {
    codes.add(code);
    return;
  }

  let largest: string | undefined;
  for (const existing of codes) {
    if (largest === undefined || existing > largest) largest = existing;
  }
  if (largest !== undefined && code < largest) {
    codes.delete(largest);
    codes.add(code);
  }
}

function runnerTerminalPayload(
  event: EngineEventOf<'runner_call_completed'> | EngineEventOf<'runner_call_error'>,
  warnings: Pick<AgentInvocationPayload, 'warningCount' | 'warningCodes'>,
): AgentInvocationPayload {
  return {
    callId: event.callId,
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    role: event.role,
    backendKind: event.backendKind,
    tool: event.runnerName ?? event.backendKind,
    ...(event.model !== undefined && { model: event.model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
    phase: event.phase,
    status: event.status,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    durationMs: event.durationMs,
    usage: event.usage,
    partial: event.partial,
    ...warnings,
    ...(event.type === 'runner_call_error' && { errorCode: event.error.code }),
  };
}

function appendProtectedEntry<TPayload>(
  tree: SessionTree,
  opts: ProtectedAppendOptions<TPayload>,
): TreeAppendResult | null {
  const payload = protectTreePayload(opts.type, opts.payload, opts.schema);
  if (payload === null) return null;
  return appendEntry(tree, {
    type: opts.type,
    payload,
    timestamp: opts.timestamp,
    ...(opts.display !== undefined && { display: opts.display }),
  });
}

function branchProtectedEntry<TPayload>(
  tree: SessionTree,
  opts: ProtectedBranchOptions<TPayload>,
): TreeBranchResult | null {
  const payload = protectTreePayload(opts.type, opts.payload, opts.schema);
  if (payload === null) return null;
  return branchFrom(tree, {
    fromId: opts.fromId,
    type: opts.type,
    payload,
    timestamp: opts.timestamp,
    ...(opts.display !== undefined && { display: opts.display }),
  });
}

function protectTreePayload<TPayload>(
  entryType: string,
  payload: TPayload,
  schema: z.ZodType<TPayload>,
): TPayload | null {
  const protectedPayload = protectConsumerPayload({ context: 'tree', payload });
  if (protectedPayload.oversized) {
    warnError(`session-tree: omitted oversized ${entryType} payload`);
    return null;
  }
  const parsed = schema.safeParse(protectedPayload.payload);
  if (!parsed.success) {
    warnError(`session-tree: omitted invalid ${entryType} payload after protection`);
    return null;
  }
  return parsed.data;
}

function protectTreeEntry(entry: TreeEntryEnvelope): TreeEntryEnvelope | null {
  const protectedEntry = protectConsumerPayload({ context: 'tree', payload: entry });
  if (protectedEntry.oversized) {
    warnError(`session-tree: omitted oversized ${entry.type} entry`);
    return null;
  }
  const parsed = TreeEntryEnvelopeSchema.safeParse(protectedEntry.payload);
  if (!parsed.success) {
    warnError(`session-tree: omitted invalid ${entry.type} entry after protection`);
    return null;
  }
  return parsed.data;
}
