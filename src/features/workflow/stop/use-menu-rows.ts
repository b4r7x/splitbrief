import { useSyncExternalStore } from 'react';
import {
  activeApply,
  onActiveApplyChange,
} from '../../../engine/orchestrator/session-lifecycle/shutdown.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { stopMenuFooter, stopMenuRows, type StopMenuInput, type StopRow } from './options.js';

/** The stop menu rows and their footer, read from the store fields they depend on. */
export function useStopMenuRows(): { rows: StopRow[]; footer: string | null } {
  const input: StopMenuInput = {
    stop: stopStore.use((s) => s),
    route: routerStore.use((s) => s),
    view: {
      briefs: runViewStore.use((s) => s.briefs),
      phase: runViewStore.use((s) => s.phase),
      briefKept: runViewStore.use((s) => s.briefKept),
      reviewNone: runViewStore.use((s) => s.reviewNone),
      stopKept: runViewStore.use((s) => s.stopKept),
      halt: runViewStore.use((s) => s.halt),
    },
    applying: useSyncExternalStore(onActiveApplyChange, () => activeApply() !== undefined),
    hasDraft: composerLiveStore.use((s) => !s.empty),
  };
  return { rows: stopMenuRows(input), footer: stopMenuFooter(input) };
}
