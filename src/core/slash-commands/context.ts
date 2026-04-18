import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { requestRewind, requestClearQueue, type RewindTarget } from '../../features/workflow/handlers.js';
import { refreshDetection } from '../../engine/detection/service.js';
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
  };
}
