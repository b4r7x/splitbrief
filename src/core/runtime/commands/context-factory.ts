import type { Config } from '../../schemas/config.js';
import type { Phase } from '../../schemas/enums.js';
import type { RewindTarget } from '../../state/build-rewind-action.js';
import type { OverlayType } from '../../navigation/types.js';
import type {
  DiscoveryRefreshSummary,
  RuntimeCommandContext,
  RuntimeConfigSaveResult,
  QueueClearCommandResult,
} from './types.js';

type CommandRewindRequest = Extract<RewindTarget, { target: 'spec' | 'plan' }>;
type ApprovalScope = 'session' | 'always' | 'all';

interface CommandContextFactoryOptions {
  projectDir: () => string;
  getConfig: () => Config | null;
  saveConfig: (config: Config) => Promise<RuntimeConfigSaveResult>;
  getSessionId: (command: string) => string | null | undefined;
  noActiveSession: (command: string) => Error;
  openOverlay: (type: OverlayType, focus?: string) => void;
  navigateHome: () => void;
  quit: () => void;
  setFeedbackMessage: (message: string) => void;
  setFeedbackError: (message: string) => void;
  refreshDetection: () => Promise<DiscoveryRefreshSummary>;
  refreshProjectFiles: RuntimeCommandContext['refreshProjectFiles'];
  listSkills: RuntimeCommandContext['listSkills'];
  toggleSkill: RuntimeCommandContext['toggleSkill'];
  refreshSkills: RuntimeCommandContext['refreshSkills'];
  getCurrentPhase: () => Phase;
  requestRewind: (request: CommandRewindRequest) => boolean;
  requestTaskRedo: (taskId: string) => boolean;
  getQueueDepth: () => number;
  clearQueue: () => QueueClearCommandResult | Promise<QueueClearCommandResult>;
  attachImage: (input: {
    path: string;
    projectDir: string;
    supportsImages: boolean;
  }) => ReturnType<RuntimeCommandContext['attachImage']>;
  plannerSupportsImages: () => boolean;
  detachImage: RuntimeCommandContext['detachImage'];
  listAttachments: RuntimeCommandContext['listAttachments'];
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
  scrollConversation: RuntimeCommandContext['scrollConversation'];
  toggleLatestActivityBatch: RuntimeCommandContext['toggleLatestActivityBatch'];
  toggleLatestDiff: RuntimeCommandContext['toggleLatestDiff'];
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
    openOverlay: opts.openOverlay,
    navigate: () => opts.navigateHome(),
    quit: opts.quit,
    setWorkflowMode: (mode) =>
      updateConfig((current) => ({ ...current, workflow: { ...current.workflow, mode } })),
    setFeedbackMessage: opts.setFeedbackMessage,
    setFeedbackError: opts.setFeedbackError,
    refreshDetection: opts.refreshDetection,
    refreshProjectFiles: opts.refreshProjectFiles,
    listSkills: opts.listSkills,
    toggleSkill: opts.toggleSkill,
    refreshSkills: opts.refreshSkills,
    getCurrentPhase: opts.getCurrentPhase,
    requestRewind: (target, comment) => {
      const request: CommandRewindRequest = { target, ...(comment ? { comment } : {}) };
      return opts.requestRewind(request);
    },
    requestTaskRedo: opts.requestTaskRedo,
    getQueueDepth: opts.getQueueDepth,
    clearQueue: opts.clearQueue,
    attachImage: (path) => {
      const supportsImages = opts.plannerSupportsImages();
      return opts.attachImage({ path, projectDir: opts.projectDir(), supportsImages });
    },
    detachImage: opts.detachImage,
    listAttachments: opts.listAttachments,
    listApprovals: () => opts.listApprovals(opts.projectDir()),
    clearApprovals: () => opts.clearApprovals(opts.projectDir(), 'all'),
    acceptRunSnapshot: () =>
      opts.acceptRunSnapshot(opts.projectDir(), sessionIdOrThrow('/run accept')),
    rejectRunSnapshot: () =>
      opts.rejectRunSnapshot(opts.projectDir(), sessionIdOrThrow('/run reject')),
    scrollConversation: opts.scrollConversation,
    toggleLatestActivityBatch: opts.toggleLatestActivityBatch,
    toggleLatestDiff: opts.toggleLatestDiff,
    toggleSidebar: opts.toggleSidebar,
    copyTarget: opts.copyTarget,
  };
}
