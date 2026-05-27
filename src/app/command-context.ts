import { configStore } from '../stores/project/config.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { requestClearQueue, requestRewind as requestWorkflowRewind } from '../features/workflow/handlers.js';
import { refreshDetection } from '../engine/detection/service.js';
import { readActive } from '../core/sessions/lifecycle.js';
import type { RuntimeCommandContext } from '../core/runtime/commands/types.js';
import { createCommandContext } from '../cli/command-context-factory.js';
import { error } from '../utils/error.js';

const appCommandContextError = {
  noActiveSession: (command: string) => error('app-command-no-active-session', `No active session for ${command}`, { command }),
  noConfig: (command: string) => error('app-command-no-config', `No config loaded for ${command}`, { command }),
} as const;

function currentSessionId(projectDir: string): string | null {
  const route = routerStore.get();
  if ((route.screen === 'workflow' || route.screen === 'summary') && route.sessionId) {
    return route.sessionId;
  }
  return readActive(projectDir);
}

export function buildCommandContext({ exit }: { exit: () => void }): RuntimeCommandContext {
  return createCommandContext({
    projectDir: () => configStore.get().projectDir,
    getConfig: () => configStore.get().config,
    saveConfig: (config) => {
      const result = configStore.save(config);
      if (result.ok) return { ok: true };
      return result.error
        ? { ok: false, errorMessage: `Failed to save config: ${result.error.message}` }
        : { ok: false };
    },
    setApprovalEnabled: (enabled) => {
      const current = configStore.get().config;
      if (!current) return;
      configStore.setApprovalEnabled(enabled);
    },
    getSessionId: () => currentSessionId(configStore.get().projectDir),
    noActiveSession: appCommandContextError.noActiveSession,
    noConfig: appCommandContextError.noConfig,
    exportMissingSession: () => ({ status: 'error', error: 'No active session for /export' }),
    openOverlay: overlayStore.open,
    navigateHome: () => routerStore.navigate({ to: 'home' }),
    quit: exit,
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {
      await refreshDetection(configStore.get().projectDir);
    },
    getCurrentPhase: () => lifecycleStore.get().phase,
    requestRewind: requestWorkflowRewind,
    requestTaskRedo: taskId => requestWorkflowRewind({ target: 'task', taskId }),
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: requestClearQueue,
  });
}
