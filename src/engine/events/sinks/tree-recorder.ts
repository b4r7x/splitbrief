import type { EngineEvent, EventSink } from '../types.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { TreeEntryEnvelope } from '../../../core/sessions/tree/schemas.js';
import type { SessionTree } from '../../../core/sessions/tree/store.js';
import { createEmptyTree, appendEntry, branchFrom } from '../../../core/sessions/tree/store.js';
import { persistAppend, writeTreeMeta, appendTreeEntry, reconstructTree } from '../../../core/sessions/tree/io.js';
import { sessionDir } from '../../../core/paths.js';
import { totalInputTokens, totalOutputTokens } from '../../../core/schemas/tokens.js';
import type { AgentInvocationPayload, CostCheckpointPayload, PlanStepPayload, RecoveryDecisionPayload } from '../../../core/sessions/tree/entry-types.js';

export interface TreeRecorderOptions {
  projectDir: string;
  sessionId: string;
}

const BRANCHING_ACTIONS = new Set(['retry-same-worker', 'route-bigger-worker', 'planner-split-rebase']);

// All disk I/O is wrapped in try/catch — persistence failures must not crash the workflow.
export function createTreeRecorderSink(opts: TreeRecorderOptions): EventSink {
  const dir = sessionDir(opts.projectDir, opts.sessionId);

  const tid = (id: TaskId): string => id as string;

  let tree: SessionTree | null = null;
  const taskStartTimes = new Map<string, number>();
  const taskTokens = new Map<string, number>();

  function persist(entry: TreeEntryEnvelope): void {
    if (!tree) return;
    try {
      persistAppend(dir, entry, tree.meta);
    } catch {}
  }


  return (event: EngineEvent) => {
    switch (event.type) {
      case 'workflow_started': {
        tree = createEmptyTree(event.ts);
        const root = tree.entries.get(tree.meta.leafId)!;
        try {
          appendTreeEntry(dir, root);
          writeTreeMeta(dir, tree.meta);
        } catch {}
        return;
      }

      case 'workflow_resumed': {
        if (!tree) {
          const existing = reconstructTree(dir);
          if (existing) {
            tree = existing;
          } else {
            tree = createEmptyTree(event.ts);
            const root = tree.entries.get(tree.meta.leafId)!;
            try {
              appendTreeEntry(dir, root);
              writeTreeMeta(dir, tree.meta);
            } catch {}
          }
        }
        return;
      }

      case 'task_started': {
        if (!tree) return;
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
        taskStartTimes.set(tid(event.taskId), event.ts);
        persist(result.entry);
        return;
      }

      case 'task_tokens': {
        if (!tree) return;
        taskTokens.set(tid(event.taskId), event.implementerTokens + event.escalationTokens);
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
          tokensUsed: taskTokens.get(tid(event.taskId)),
        };
        const result = appendEntry(tree, {
          type: 'agent-invocation',
          payload,
          timestamp: event.ts,
        });
        tree = result.tree;
        persist(result.entry);
        taskTokens.delete(tid(event.taskId));
        taskStartTimes.delete(tid(event.taskId));
        return;
      }

      case 'task_failed':
      case 'task_full_fail': {
        if (!tree) return;
        const startTime = taskStartTimes.get(tid(event.taskId));
        const payload: AgentInvocationPayload = {
          taskId: event.taskId,
          role: 'implementer',
          tool: 'unknown',
          phase: event.phase,
          status: 'failed',
          durationMs: startTime !== undefined ? event.ts - startTime : undefined,
          tokensUsed: taskTokens.get(tid(event.taskId)),
        };
        const result = appendEntry(tree, {
          type: 'agent-invocation',
          payload,
          timestamp: event.ts,
        });
        tree = result.tree;
        persist(result.entry);
        taskTokens.delete(tid(event.taskId));
        taskStartTimes.delete(tid(event.taskId));
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
          totalCost: 0,
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

      default:
        return;
    }
  };
}
