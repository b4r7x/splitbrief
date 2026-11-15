import { useEffect, useRef } from 'react';
import type { Config } from '../../../core/schemas/config.js';
import { detectionStore } from '../../../stores/discovery/detection.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { configStore } from '../../../stores/project/config.js';
import {
  formatConfigSaveSuccess,
  reportConfigSaveFailure,
} from '../../../stores/project/save-feedback.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { unavailableSetupSeats } from './availability.js';

/**
 * Saves the chosen crew once each seat is ready, then calls `start`: the workflow the crew was set up
 * for. Without a `start` the save goes back home. A change of the crew, the saved config or the
 * detection during the check drops that save.
 */
export function useFinalize(start: (() => void) | undefined) {
  const projectDir = configStore.use((state) => state.projectDir);
  const saveCheck = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      saveCheck.current?.abort();
    },
    [],
  );

  const finalize = async (finalConfig: Config) => {
    if (!projectDir) return;
    saveCheck.current?.abort();
    const controller = new AbortController();
    saveCheck.current = controller;
    const detection = detectionStore.get();
    const persisted = configStore.get().diskConfig;
    const unavailable = await unavailableSetupSeats(finalConfig, detection, controller.signal);
    if (
      controller.signal.aborted ||
      configStore.get().config !== finalConfig ||
      configStore.get().diskConfig !== persisted ||
      detectionStore.get() !== detection
    )
      return;
    if (unavailable.length > 0) {
      feedbackStore.setMessage('Choose a ready tool and model for each unavailable seat.');
      return;
    }
    const result = await configStore.save(finalConfig);
    if (reportConfigSaveFailure(result)) return;

    if (start !== undefined) {
      feedbackStore.setMessage(formatConfigSaveSuccess('your crew', result));
      start();
      return;
    }

    routerStore.navigate({ to: 'home' });
    feedbackStore.setMessage(formatConfigSaveSuccess('your crew', result));
  };

  return { finalize, abort: () => saveCheck.current?.abort() };
}
