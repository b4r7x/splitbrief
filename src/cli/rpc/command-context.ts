import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EventBus } from '../../engine/events/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import { transitionAndSave } from '../../engine/orchestrator/state-ops.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../engine/orchestrator/run/workflow.js';
import type {
  RuntimeCommandContext,
  RuntimeConfigSaveResult,
} from '../../core/runtime/commands/types.js';
import { createCommandContext } from '../../core/runtime/commands/context-factory.js';
import { buildRewindAction } from '../../core/state/build-rewind-action.js';
import { sessionDir } from '../../core/paths.js';
import { rebuildRepomap } from '../../engine/codebase/rebuild.js';
import { writeHandoffPack } from '../../engine/handoff/write.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../../engine/snapshots/run/lifecycle.js';
import { performManualCompaction } from '../../engine/orchestrator/transcript/compaction.js';
import { writeSessionHtmlReport } from '../../engine/export/collect.js';
import {
  readApprovalsStore,
  mutateApprovalsStore,
  clearGrantsByScope,
} from '../../core/approval/store.js';
import { attachImage, detachImage, listAttachments } from '../../stores/workflow/attachments.js';
import {
  configRevisionsMatch,
  renderConfigDocumentEdits,
  transactConfigDocument,
} from '../../core/config/load/io.js';
import { toYaml } from '../../core/config/load/transform.js';
import { defaultApprovalConfig } from '../../core/schemas/config.js';
import { editsForSave, persistedConfigForSave } from '../../stores/project/config-persistence.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { error } from '../../utils/error.js';
import type { ResolvedRunConfig } from '../build-overrides.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';

const rpcCommandContextError = {
  noActiveSession: () => error('rpc-command-no-active-session', 'No active session.'),
} as const;

export function createRpcCommandContext(opts: {
  projectDir: string;
  getSessionId: () => string | undefined;
  getState: () => WorkflowState | null;
  getPreparedExecution: () => PreparedExecution | null;
  getRunConfig: () => ResolvedRunConfig | null;
  setRunConfig: (config: ResolvedRunConfig) => void;
  reloadRunConfig: () => ResolvedRunConfig;
  setEffectiveConfig: (config: Config) => void;
  getApprovalEnabled?: (() => boolean) | undefined;
  setApprovalEnabled?: ((enabled: boolean) => void) | undefined;
  getPhase: () => Phase;
  queueHandler: () => QueueHandler | null;
  clearQueueHandler: () => ClearQueueHandler | null;
  abort: (reason?: unknown) => void;
  abortTurn?: ((reason?: unknown) => void) | undefined;
  bus: EventBus;
  setRewindFeedback?: ((feedback: string | undefined) => void) | undefined;
  messages: string[];
  errors: string[];
  pendingQueueDepth: (state: WorkflowState | null) => number;
}): RuntimeCommandContext {
  const pushMessage = (message: string) => {
    opts.messages.push(message);
  };
  const pushError = (message: string) => {
    opts.errors.push(message);
  };
  return createCommandContext({
    projectDir: () => opts.projectDir,
    getConfig: () => opts.getRunConfig()?.config ?? null,
    saveConfig: async (config): Promise<RuntimeConfigSaveResult> => {
      try {
        const current = opts.getRunConfig();
        if (!current) return { kind: 'failure', ok: false };
        const persisted = persistedConfigForSave({
          persisted: current.persistedConfig,
          effective: current.config,
          updated: config,
        });
        const edits =
          current.persistenceSnapshot.revision === null
            ? [{ path: [], value: toYaml(persisted) }]
            : editsForSave(current.persistedConfig, persisted);
        const intendedRawBytes = Buffer.from(
          renderConfigDocumentEdits(current.persistenceSnapshot, edits),
        );
        const result = await transactConfigDocument(
          opts.projectDir,
          current.persistenceSnapshot.revision,
          edits,
        );
        if (result.kind === 'conflict') {
          return {
            kind: 'conflict',
            ok: false,
            errorMessage: 'Config changed on disk. Reload configuration before retrying.',
          };
        }

        const reloaded = opts.reloadRunConfig();
        if (result.kind === 'saved') {
          if (!configRevisionsMatch(result.revision, reloaded.persistenceSnapshot.revision)) {
            return {
              kind: 'conflict',
              ok: false,
              errorMessage: 'Config changed on disk. Reload configuration before retrying.',
            };
          }
          opts.setRunConfig(reloaded);
          return { kind: 'saved', ok: true };
        }

        if (reloaded.persistenceSnapshot.revision === null) {
          return {
            kind: 'failure',
            ok: false,
            errorMessage:
              'Config disappeared after an uncertain save. Reload configuration before retrying.',
          };
        }
        opts.setRunConfig(reloaded);
        const actualMatchesIntended =
          Buffer.compare(Buffer.from(reloaded.persistenceSnapshot.rawBytes), intendedRawBytes) ===
          0;
        return {
          kind: 'durability-uncertain',
          ok: false,
          errorMessage: actualMatchesIntended
            ? `Config was saved but its directory durability is uncertain: ${result.warning}`
            : `Config durability is uncertain; reloaded the current disk config: ${result.warning}`,
        };
      } catch (err) {
        return {
          kind: 'failure',
          ok: false,
          errorMessage: `Failed to save config: ${toErrorMessage(err)}`,
        };
      }
    },
    getApprovalEnabled: opts.getApprovalEnabled,
    setApprovalEnabled: (enabled) => {
      const current = opts.getRunConfig();
      if (current) {
        const approval = current.config.approval ?? defaultApprovalConfig();
        opts.setEffectiveConfig({
          ...current.config,
          approval: { ...approval, enabled },
        });
      }
      opts.setApprovalEnabled?.(enabled);
    },
    getSessionId: () => opts.getSessionId(),
    noActiveSession: () => rpcCommandContextError.noActiveSession(),
    openOverlay: (type) => pushMessage(`Overlay ${type} is not available in RPC mode.`),
    navigateHome: () => pushMessage('Navigation is not available in RPC mode.'),
    quit: () => opts.abort(),
    setFeedbackMessage: pushMessage,
    setFeedbackError: pushError,
    refreshDetection: async () => {
      pushMessage('Tool detection refresh is not available in RPC mode.');
      return {
        status: 'not-run',
        published: false,
        lanes: {
          readiness: { outcome: 'not-run', reason: 'uninitialized' },
          modelsDev: { outcome: 'not-run', reason: 'uninitialized' },
          cliModels: { outcome: 'not-run', reason: 'uninitialized' },
        },
      };
    },
    refreshProjectFiles: () => {
      pushMessage('Project file refresh is not available in RPC mode.');
    },
    getCurrentPhase: opts.getPhase,
    requestRewind: (request) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      const persistTranscript = opts.getRunConfig()?.config.workflow.persistTranscript ?? true;
      const { action, persistedAction, event } = buildRewindAction({
        request,
        ref: { projectDir: opts.projectDir, sessionId },
        state,
        persistEvent: false,
        persistTranscript,
      });
      if (action.type === 'REWIND_TO_SPEC' || action.type === 'REWIND_TO_PLAN') {
        opts.setRewindFeedback?.(action.comment);
      }
      transitionAndSave({ projectDir: opts.projectDir, sessionId }, state, persistedAction);
      opts.bus.publish(event);
      opts.abortTurn?.(WORKFLOW_REWIND_ABORT_REASON);
      return true;
    },
    requestTaskRedo: (taskId) => {
      const state = opts.getState();
      const sessionId = opts.getSessionId();
      if (!state || !sessionId) return false;
      const persistTranscript = opts.getRunConfig()?.config.workflow.persistTranscript ?? true;
      const { persistedAction, event } = buildRewindAction({
        request: { target: 'task', taskId },
        ref: { projectDir: opts.projectDir, sessionId },
        state,
        persistEvent: false,
        persistTranscript,
      });
      transitionAndSave({ projectDir: opts.projectDir, sessionId }, state, persistedAction);
      opts.bus.publish(event);
      opts.abortTurn?.(WORKFLOW_REWIND_ABORT_REASON);
      return true;
    },
    getQueueDepth: () => opts.pendingQueueDepth(opts.getState()),
    clearQueue: async () => {
      const clearLiveQueue = opts.clearQueueHandler();
      if (clearLiveQueue) return clearLiveQueue();
      return {
        status: 'unavailable',
        message: 'Cannot clear queue: workflow queue is not ready.',
      };
    },
    rebuildRepomap: async (projectDir, cacheDir) =>
      rebuildRepomap(projectDir, cacheDir === undefined ? {} : { cacheDir }),
    attachImage,
    detachImage,
    listAttachments,
    writeHandoff: ({ projectDir, sessionId, target, taskId }) =>
      writeHandoffPack({
        projectDir,
        sessionId,
        target,
        outDir: join(sessionDir(projectDir, sessionId), 'handoffs', target),
        ...(taskId !== undefined && { selectedTaskIds: [taskId] }),
        mode: 'overwrite',
      }),
    listApprovals: (projectDir) => readApprovalsStore(projectDir).grants,
    clearApprovals: (projectDir, scope) => {
      let removed = 0;
      mutateApprovalsStore(projectDir, (before) => {
        const after = clearGrantsByScope(before, scope);
        removed = before.grants.length - after.grants.length;
        return after;
      });
      return removed;
    },
    acceptRunSnapshot,
    rejectRunSnapshot,
    compactTranscript: () => {
      const prepared = opts.getPreparedExecution();
      if (prepared === null) throw rpcCommandContextError.noActiveSession();
      return performManualCompaction({
        config: prepared.config,
        ref: prepared.session.ref,
        preparationId: prepared.preparationId,
        gates: prepared.gates,
      });
    },
    exportSession: async (projectDir, sessionId) =>
      writeSessionHtmlReport(sessionDir(projectDir, sessionId), sessionId),
    scrollConversation: () => ({
      status: 'unavailable',
      message: 'Conversation scrolling is not available in RPC mode.',
    }),
    toggleLatestActivityBatch: () => ({
      status: 'unavailable',
      message: 'Activity expansion is not available in RPC mode.',
    }),
    toggleSidebar: () => ({
      status: 'unavailable',
      message: 'Sidebar is not available in RPC mode.',
    }),
    copyTarget: () => Promise.resolve('unavailable'),
  });
}
