import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { requestRewind, requestClearQueue, requestAttach, requestDetach, type RewindTarget } from '../../features/workflow/handlers.js';
import { refreshDetection } from '../../engine/detection/service.js';
import { rebuildRepomap as doRebuildRepomap } from '../../engine/codebase/rebuild.js';
import type { CommandContext } from './types.js';

export function buildCommandContext({ exit }: { exit: () => void }): CommandContext {
  return {
    openOverlay: overlayStore.open,
    navigate: (to) => routerStore.navigate({ to }),
    quit: exit,
    setWorkflowMode: (mode) => {
      const current = configStore.get().config;
      if (!current) return false;
      const result = configStore.save({ ...current, workflow: { ...current.workflow, mode } });
      if (!result.ok && result.error) {
        feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      }
      return result.ok;
    },
    setPlannerEffort: (effort) => {
      const current = configStore.get().config;
      if (!current) return false;
      const planner = { ...current.planner, effort } as typeof current.planner;
      const result = configStore.save({ ...current, planner });
      if (!result.ok && result.error) {
        feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      }
      return result.ok;
    },
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {
      const projectDir = configStore.get().projectDir;
      await refreshDetection(projectDir);
    },
    getCurrentPhase: () => lifecycleStore.get().phase,
    requestRewind: (target, comment) => {
      const base: RewindTarget = comment ? { target, comment } : { target };
      return requestRewind(base);
    },
    requestTaskRedo: (taskId) =>
      requestRewind({ target: 'task', taskId }),
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: () => requestClearQueue(),
    rebuildRepomap: async () => {
      const projectDir = configStore.get().projectDir;
      return doRebuildRepomap(projectDir);
    },
    attachImage: (input) => {
      const projectDir = configStore.get().projectDir;
      const result = requestAttach(input, projectDir);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, path: result.resolvedPath };
    },
    detachImage: (idOrIndex) => {
      const pending = attachmentsStore.peek();
      if (pending.length === 0) return false;
      const asIndex = Number.parseInt(idOrIndex, 10);
      if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= pending.length) {
        const target = pending[asIndex - 1]!;
        attachmentsStore.remove(target.id);
        return true;
      }
      return requestDetach(idOrIndex);
    },
    listAttachments: () => attachmentsStore.peek().map(a => ({ id: a.id, path: a.path })),
  };
}
