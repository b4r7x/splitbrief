import { useInput } from 'ink';
import { completionStore } from '../../stores/ui/completion.js';
import { overlayStore, selectHasOverlay } from '../../stores/ui/overlay.js';
import { observePreparationCleanup } from './observe-cleanup.js';
import type { panelModel } from '../../components/preparation-problem.js';

export function usePreparationKeys({
  active,
  problem,
  retry,
  onCancel,
}: Readonly<{
  active: boolean;
  problem: ReturnType<typeof panelModel>;
  retry?: () => Promise<void>;
  onCancel: () => void;
}>): void {
  const hasOverlay = overlayStore.use(selectHasOverlay);
  const completing = completionStore.use((state) => state.open);
  useInput(
    (input, key) => {
      if (key.escape) onCancel();
      else if (problem && key.ctrl && input === 'd') overlayStore.open('preparation-details');
      else if (problem && retry && !key.ctrl && !key.meta) {
        if (input.toLowerCase() === 'r') observePreparationCleanup(retry());
        else if (problem.settings && input.toLowerCase() === 's') overlayStore.open('settings');
      }
    },
    { isActive: active && !hasOverlay && !completing },
  );
}
