import type { Phase } from '../../schemas/enums.js';
import type { OverlayType } from '../../navigation/types.js';
import type {
  DiscoveryRefreshSummary,
  RuntimeCommandContext,
  QueueClearCommandResult,
} from './types.js';

interface CommandContextFactoryOptions {
  projectDir: () => string;
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
  resumeRun: () => boolean;
  steerRun: (text: string) => boolean;
  endRun: () => boolean;
  getQueueDepth: () => number;
  clearQueue: () => QueueClearCommandResult | Promise<QueueClearCommandResult>;
  insertImage?: (input: {
    path: string;
    projectDir: string;
    supportsImages: boolean;
  }) => ReturnType<RuntimeCommandContext['attachImage']>;
  attachImage: (input: {
    path: string;
    projectDir: string;
    supportsImages: boolean;
  }) => ReturnType<RuntimeCommandContext['attachImage']>;
  plannerSupportsImages: () => boolean;
  detachImage: RuntimeCommandContext['detachImage'];
  listAttachments: RuntimeCommandContext['listAttachments'];
  acceptRun: (
    projectDir: string,
    sessionId: string,
    confirm: boolean,
  ) => ReturnType<RuntimeCommandContext['acceptRun']>;
  refreshRun: RuntimeCommandContext['refreshRun'];
  rejectRun: (
    projectDir: string,
    sessionId: string,
  ) => ReturnType<RuntimeCommandContext['rejectRun']>;
  scrollConversation: RuntimeCommandContext['scrollConversation'];
  toggleLatestActivityBatch: RuntimeCommandContext['toggleLatestActivityBatch'];
  toggleLatestDiff: RuntimeCommandContext['toggleLatestDiff'];
  listBriefs: RuntimeCommandContext['listBriefs'];
  toggleSidebar: RuntimeCommandContext['toggleSidebar'];
  copyTarget: RuntimeCommandContext['copyTarget'];
}

export function createCommandContext(opts: CommandContextFactoryOptions): RuntimeCommandContext {
  const sessionIdOrThrow = (command: string) => {
    const sessionId = opts.getSessionId(command);
    if (!sessionId) throw opts.noActiveSession(command);
    return sessionId;
  };

  return {
    openOverlay: opts.openOverlay,
    navigate: () => opts.navigateHome(),
    quit: opts.quit,
    setFeedbackMessage: opts.setFeedbackMessage,
    setFeedbackError: opts.setFeedbackError,
    refreshDetection: opts.refreshDetection,
    refreshProjectFiles: opts.refreshProjectFiles,
    listSkills: opts.listSkills,
    toggleSkill: opts.toggleSkill,
    refreshSkills: opts.refreshSkills,
    getCurrentPhase: opts.getCurrentPhase,
    resumeRun: opts.resumeRun,
    steerRun: opts.steerRun,
    endRun: opts.endRun,
    getQueueDepth: opts.getQueueDepth,
    clearQueue: opts.clearQueue,
    insertImage: (path) => {
      const supportsImages = opts.plannerSupportsImages();
      const insertImage = opts.insertImage ?? opts.attachImage;
      return insertImage({ path, projectDir: opts.projectDir(), supportsImages });
    },
    attachImage: (path) => {
      const supportsImages = opts.plannerSupportsImages();
      return opts.attachImage({ path, projectDir: opts.projectDir(), supportsImages });
    },
    detachImage: opts.detachImage,
    listAttachments: opts.listAttachments,
    acceptRun: (confirm) =>
      opts.acceptRun(opts.projectDir(), sessionIdOrThrow('/run accept'), confirm),
    rejectRun: () => opts.rejectRun(opts.projectDir(), sessionIdOrThrow('/run reject')),
    refreshRun: opts.refreshRun,
    scrollConversation: opts.scrollConversation,
    toggleLatestActivityBatch: opts.toggleLatestActivityBatch,
    toggleLatestDiff: opts.toggleLatestDiff,
    listBriefs: opts.listBriefs,
    toggleSidebar: opts.toggleSidebar,
    copyTarget: opts.copyTarget,
  };
}
