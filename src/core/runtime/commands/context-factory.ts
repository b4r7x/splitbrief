import type { Config } from '../../schemas/config.js';
import type { Phase } from '../../schemas/enums.js';
import type { RewindTarget } from '../../state/build-rewind-action.js';
import type { OverlayType } from '../../navigation/types.js';
import type {
  DiscoveryRefreshSummary,
  RuntimeCommandContext,
  RuntimeConfigSaveResult,
  ExportSessionResult,
  QueueClearCommandResult,
} from './types.js';

type CommandRewindRequest = Extract<RewindTarget, { target: 'spec' | 'plan' }>;
type HandoffTargetArg = Parameters<RuntimeCommandContext['writeHandoff']>[0];
type ApprovalScope = 'session' | 'always' | 'all';

interface CommandContextFactoryOptions {
  isAttached?: boolean;
  projectDir: () => string;
  getConfig: () => Config | null;
  saveConfig: (config: Config) => Promise<RuntimeConfigSaveResult>;
  getApprovalEnabled?: (() => boolean) | undefined;
  setApprovalEnabled?: ((enabled: boolean) => void) | undefined;
  getSessionId: (command: string) => string | null | undefined;
  noActiveSession: (command: string) => Error;
  exportMissingSession?: (() => ExportSessionResult) | undefined;
  openOverlay: (type: OverlayType, focus?: string) => void;
  navigateHome: () => void;
  quit: () => void;
  setFeedbackMessage: (message: string) => void;
  setFeedbackError: (message: string) => void;
  refreshDetection: () => Promise<DiscoveryRefreshSummary>;
  refreshProjectFiles: RuntimeCommandContext['refreshProjectFiles'];
  getCurrentPhase: () => Phase;
  requestRewind: (request: CommandRewindRequest) => boolean;
  requestTaskRedo: (taskId: string) => boolean;
  requestWorkflowResume: () => boolean;
  getQueueDepth: () => number;
  clearQueue: () => QueueClearCommandResult | Promise<QueueClearCommandResult>;
  rebuildRepomap: (
    projectDir: string,
    cacheDir: string | undefined,
  ) => ReturnType<RuntimeCommandContext['rebuildRepomap']>;
  attachImage: (
    input: string,
    projectDir: string,
  ) => ReturnType<RuntimeCommandContext['attachImage']>;
  detachImage: RuntimeCommandContext['detachImage'];
  listAttachments: RuntimeCommandContext['listAttachments'];
  writeHandoff: (opts: {
    projectDir: string;
    sessionId: string;
    target: HandoffTargetArg;
    taskId?: string | undefined;
  }) => ReturnType<RuntimeCommandContext['writeHandoff']>;
  listApprovals: (projectDir: string) => ReturnType<RuntimeCommandContext['listApprovals']>;
  clearApprovals: (projectDir: string, scope: ApprovalScope) => number;
  acceptRunSnapshot: (
    projectDir: string,
    sessionId: string,
  ) => ReturnType<RuntimeCommandContext['acceptRunSnapshot']>;
  rejectRunSnapshot: (
    projectDir: string,
    sessionId: string,
  ) => ReturnType<RuntimeCommandContext['rejectRunSnapshot']>;
  compactTranscript: RuntimeCommandContext['compactTranscript'];
  exportSession: (
    projectDir: string,
    sessionId: string,
  ) => ReturnType<RuntimeCommandContext['exportSession']>;
  scrollConversation: RuntimeCommandContext['scrollConversation'];
  toggleLatestActivityBatch: RuntimeCommandContext['toggleLatestActivityBatch'];
  toggleSidebar: RuntimeCommandContext['toggleSidebar'];
  copyTarget: RuntimeCommandContext['copyTarget'];
}

export function createCommandContext(opts: CommandContextFactoryOptions): RuntimeCommandContext {
  const sessionIdOrThrow = (command: string) => {
    const sessionId = opts.getSessionId(command);
    if (!sessionId) throw opts.noActiveSession(command);
    return sessionId;
  };
  const updateConfig = async (
    update: (config: Config) => Config,
  ): Promise<RuntimeConfigSaveResult> => {
    const config = opts.getConfig();
    if (!config) return { kind: 'failure', ok: false };
    const result = await opts.saveConfig(update(config));
    if (result.kind !== 'saved' && result.errorMessage) {
      opts.setFeedbackError(result.errorMessage);
    }
    return result;
  };

  return {
    isAttached: opts.isAttached ?? false,
    openOverlay: opts.openOverlay,
    navigate: () => opts.navigateHome(),
    quit: opts.quit,
    setWorkflowMode: (mode) =>
      updateConfig((current) => ({ ...current, workflow: { ...current.workflow, mode } })),
    setPlannerEffort: (effort) =>
      updateConfig((current) => ({ ...current, planner: { ...current.planner, effort } })),
    setFeedbackMessage: opts.setFeedbackMessage,
    setFeedbackError: opts.setFeedbackError,
    refreshDetection: opts.refreshDetection,
    refreshProjectFiles: opts.refreshProjectFiles,
    getCurrentPhase: opts.getCurrentPhase,
    requestRewind: (target, comment) => {
      const request: CommandRewindRequest = { target, ...(comment ? { comment } : {}) };
      return opts.requestRewind(request);
    },
    requestTaskRedo: opts.requestTaskRedo,
    requestWorkflowResume: opts.requestWorkflowResume,
    getQueueDepth: opts.getQueueDepth,
    clearQueue: opts.clearQueue,
    rebuildRepomap: async () => {
      const projectDir = opts.projectDir();
      const cacheDir = opts.getConfig()?.codebase?.cacheDir;
      return opts.rebuildRepomap(projectDir, cacheDir);
    },
    attachImage: (input) => opts.attachImage(input, opts.projectDir()),
    detachImage: opts.detachImage,
    listAttachments: opts.listAttachments,
    writeHandoff: async (target, taskId) => {
      const projectDir = opts.projectDir();
      const sessionId = sessionIdOrThrow('handoff');
      return opts.writeHandoff({
        projectDir,
        sessionId,
        target,
        taskId,
      });
    },
    listApprovals: () => opts.listApprovals(opts.projectDir()),
    clearApprovals: () => opts.clearApprovals(opts.projectDir(), 'all'),
    getApprovalEnabled: () =>
      opts.getApprovalEnabled
        ? opts.getApprovalEnabled()
        : opts.getConfig()?.approval?.enabled !== false,
    setApprovalEnabled: (enabled) => {
      opts.setApprovalEnabled?.(enabled);
    },
    acceptRunSnapshot: () =>
      opts.acceptRunSnapshot(opts.projectDir(), sessionIdOrThrow('/accept-run')),
    rejectRunSnapshot: () =>
      opts.rejectRunSnapshot(opts.projectDir(), sessionIdOrThrow('/reject-run')),
    compactTranscript: opts.compactTranscript,
    exportSession: async () => {
      const projectDir = opts.projectDir();
      const sessionId = opts.getSessionId('/export');
      if (!sessionId) {
        if (opts.exportMissingSession) return opts.exportMissingSession();
        throw opts.noActiveSession('/export');
      }
      return opts.exportSession(projectDir, sessionId);
    },
    scrollConversation: opts.scrollConversation,
    toggleLatestActivityBatch: opts.toggleLatestActivityBatch,
    toggleSidebar: opts.toggleSidebar,
    copyTarget: opts.copyTarget,
  };
}
