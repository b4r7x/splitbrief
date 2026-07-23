import type { Phase } from '../../../core/schemas/enums.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../../engine/events/types.js';
import { runBriefQualityGate } from '../../../engine/orchestrator/planning/brief-quality-gate.js';
import { readPersistedTasks } from '../../../engine/orchestrator/planning/io.js';
import { transitionAndSave } from '../../../engine/orchestrator/state-ops.js';
import { truncateByChars } from '../../../utils/truncate.js';
import type { BriefReviewDraftSaveResult } from '../gates.js';

const RPC_DRAFT_SAVE_ERROR_MAX_CHARS = 2000;

function boundedDraftSaveError(message: string): string {
  return truncateByChars(message, RPC_DRAFT_SAVE_ERROR_MAX_CHARS);
}

export type RpcBriefReviewDraftDeps = {
  projectDir: string;
  resolveSessionId: () => string | undefined;
  readCurrentState: () => WorkflowState | null;
  bus: EventBus;
  setActiveSessionId: (id: string) => void;
};

export function createRpcBriefReviewDraftSaver(
  deps: RpcBriefReviewDraftDeps,
): (tasksFilePath: string) => Promise<BriefReviewDraftSaveResult> {
  return async (tasksFilePath: string): Promise<BriefReviewDraftSaveResult> => {
    const id = deps.resolveSessionId();
    if (!id) {
      return {
        ok: false,
        message: 'No active session is available for Task Brief draft save.',
      };
    }

    const state = deps.readCurrentState();
    if (!state) {
      return {
        ok: false,
        message: 'No active workflow state is available for Task Brief draft save.',
      };
    }

    const persisted = await readPersistedTasks(tasksFilePath);
    if (!persisted.ok) {
      return { ok: false, message: boundedDraftSaveError(persisted.message) };
    }

    deps.setActiveSessionId(id);
    const phase: Phase = state.phase;
    const { report } = runBriefQualityGate({
      tasks: persisted.tasks,
      projectDir: deps.projectDir,
      sessionId: id,
      bus: deps.bus,
      phase,
    });
    transitionAndSave({ projectDir: deps.projectDir, sessionId: id }, state, {
      type: 'BRIEFS_READY',
      tasks: persisted.tasks,
    });

    return {
      ok: true,
      qualityPassed: report.passed,
      qualityScore: report.score,
      issueCount: report.issues.length,
      taskCount: persisted.tasks.length,
    };
  };
}
