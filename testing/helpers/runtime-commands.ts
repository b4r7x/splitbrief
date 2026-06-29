import { canReviseSpec, canRevisePlan, canRedoTask } from '../../src/core/phases.js';
import { executeRuntimeCommand as runRuntimeCommand } from '../../src/core/runtime/commands/dispatch.js';
import type {
  RuntimeCommandDef,
  RuntimeCommandContext,
} from '../../src/core/runtime/commands/types.js';
import type { Phase } from '../../src/core/schemas/enums.js';

export const noop = () => {};
export const noopTrue = () => true;

export const PHASE_GUARDS = {
  canReviseSpec: {
    fn: canReviseSpec,
    allowed: [
      'reviewing-spec',
      'clarifying',
      'constitution-check',
      'planning',
      'reviewing-plan',
      'reviewing-briefs',
      'analyzing',
      'implementing',
      'validating-task',
      'escalating',
      'final-review',
    ] as Phase[],
    denied: ['idle', 'researching', 'specifying', 'complete'] as Phase[],
  },
  canRevisePlan: {
    fn: canRevisePlan,
    allowed: [
      'reviewing-plan',
      'reviewing-briefs',
      'analyzing',
      'implementing',
      'validating-task',
      'escalating',
      'final-review',
    ] as Phase[],
    denied: [
      'idle',
      'researching',
      'specifying',
      'reviewing-spec',
      'clarifying',
      'constitution-check',
      'planning',
      'complete',
    ] as Phase[],
  },
  canRedoTask: {
    fn: canRedoTask,
    allowed: ['implementing', 'validating-task', 'escalating'] as Phase[],
    denied: [
      'idle',
      'researching',
      'specifying',
      'reviewing-spec',
      'clarifying',
      'constitution-check',
      'planning',
      'reviewing-plan',
      'reviewing-briefs',
      'analyzing',
      'final-review',
      'complete',
    ] as Phase[],
  },
} as const;

export function makeCtx(overrides: Partial<RuntimeCommandContext> = {}): RuntimeCommandContext {
  return {
    openOverlay: noop,
    navigate: noop,
    quit: noop,
    setWorkflowMode: noopTrue,
    setPlannerEffort: noopTrue,
    setFeedbackMessage: noop,
    setFeedbackError: noop,
    refreshDetection: async () => {},
    refreshProjectFiles: noop,
    getCurrentPhase: () => 'idle',
    requestRewind: noopTrue,
    requestTaskRedo: noopTrue,
    getQueueDepth: () => 0,
    clearQueue: () => ({ status: 'cleared', count: 0 }),
    rebuildRepomap: async () => ({ deleted: false, files: [] }),
    attachImage: () => ({ ok: false, reason: 'not-image' }),
    detachImage: () => false,
    listAttachments: () => [],
    writeHandoff: async () => ({ outputDir: '/fake' }),
    listApprovals: () => [],
    clearApprovals: () => 0,
    getApprovalEnabled: () => true,
    setApprovalEnabled: noop,
    acceptRunSnapshot: async () => ({ snapshotId: 'snap-accepted', isFirstSnapshot: false }),
    rejectRunSnapshot: async () => ({
      status: 'rejected',
      snapshotId: 'snap-run',
      restoredPaths: [],
      deletedPaths: [],
      conflictedPaths: [],
      missingSnapshotFiles: [],
    }),
    compactTranscript: async () => ({ status: 'compacted', summary: 'summary', entriesRemoved: 3 }),
    exportSession: async () => ({ status: 'ok', path: '/fake/report.html' }),
    scrollConversation: () => ({ status: 'scrolled' }),
    toggleLatestActivityBatch: () => ({ status: 'toggled', expanded: true }),
    toggleSidebar: () => ({ status: 'toggled', visible: true }),
    copyTarget: async () => 'empty',
    ...overrides,
  };
}

export function executeRuntimeCommand(
  commands: RuntimeCommandDef[],
  raw: string,
  screen: 'home' | 'workflow' | 'summary' | 'setup',
  onError: (msg: string) => void,
  phase: Phase = 'idle',
): Promise<void> {
  return runRuntimeCommand(commands, raw, { screen, phase, onError });
}
