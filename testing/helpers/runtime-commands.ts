import { executeRuntimeCommand } from '../../src/core/runtime/commands/dispatch.js';
import type {
  RuntimeCommandDef,
  RuntimeCommandContext,
} from '../../src/core/runtime/commands/types.js';
import type { Phase } from '../../src/core/schemas/enums.js';
import { queueCopy } from '../../src/features/workflow/queue-copy.js';

export const noop = () => {};
export const noopTrue = () => true;

export function makeCtx(overrides: Partial<RuntimeCommandContext> = {}): RuntimeCommandContext {
  return {
    openOverlay: noop,
    navigate: noop,
    quit: noop,
    setFeedbackMessage: noop,
    setFeedbackError: noop,
    refreshDetection: async () => ({
      status: 'fresh',
      published: true,
      lanes: {
        readiness: { outcome: 'fresh' },
        modelsDev: { outcome: 'fresh' },
        cliModels: { outcome: 'fresh' },
      },
    }),
    refreshProjectFiles: noop,
    listSkills: () => [],
    toggleSkill: () => ({ status: 'unknown' as const }),
    refreshSkills: async () => {},
    resumeRun: noopTrue,
    steerRun: noopTrue,
    endRun: noopTrue,
    getQueueCopy: (count = 0) => queueCopy({ seat: null, count }),
    clearQueue: () => ({ status: 'cleared', count: 0 }),
    attachImage: () => ({ ok: false, reason: 'not-image' }),
    detachImage: () => false,
    listAttachments: () => [],
    acceptRun: async () => ({
      status: 'snapshot-accepted',
      snapshotId: 'snap-accepted',
      isFirstSnapshot: false,
    }),
    refreshRun: noop,
    rejectRun: async () => ({
      status: 'rejected',
      snapshotId: 'snap-run',
      restoredPaths: [],
      deletedPaths: [],
      conflictedPaths: [],
      missingSnapshotFiles: [],
    }),
    scrollConversation: () => ({ status: 'scrolled' }),
    toggleLatestActivityBatch: () => ({ status: 'toggled', expanded: true }),
    toggleLatestDiff: () => ({ status: 'toggled', expanded: true }),
    listBriefs: () => [],
    toggleSidebar: () => ({ status: 'toggled', visible: true }),
    copyTarget: async () => 'empty',
    ...overrides,
  };
}

export function runCommandInTest(args: {
  commands: RuntimeCommandDef[];
  raw: string;
  screen: 'home' | 'workflow' | 'setup';
  phase?: Phase;
  openRunAtRest?: boolean;
  onError: (msg: string) => void;
}): Promise<void> {
  return executeRuntimeCommand(args.commands, args.raw, {
    screen: args.screen,
    phase: args.phase ?? 'idle',
    plannerSupportsImages: true,
    openRunAtRest: args.openRunAtRest ?? false,
    onError: args.onError,
  });
}
