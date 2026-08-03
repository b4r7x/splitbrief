import { executeRuntimeCommand as runRuntimeCommand } from '../../src/core/runtime/commands/dispatch.js';
import type {
  RuntimeCommandDef,
  RuntimeConfigSaveResult,
  RuntimeCommandContext,
} from '../../src/core/runtime/commands/types.js';
import type { Phase } from '../../src/core/schemas/enums.js';

export const noop = () => {};
export const noopTrue = () => true;
const noopSaved = async (): Promise<RuntimeConfigSaveResult> => ({ kind: 'saved', ok: true });

export function makeCtx(overrides: Partial<RuntimeCommandContext> = {}): RuntimeCommandContext {
  return {
    openOverlay: noop,
    navigate: noop,
    quit: noop,
    setWorkflowMode: noopSaved,
    setPlannerEffort: noopSaved,
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
