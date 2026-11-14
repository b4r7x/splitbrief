import { useInput } from 'ink';
import { overlayStore, selectHasOverlay } from '../../stores/ui/overlay.js';

/** Escape gives up a routine check: one that takes no page, while no overlay holds the keys. */
export function useCancelKey({
  preparing,
  takesPage,
  onCancel,
}: Readonly<{ preparing: boolean; takesPage: boolean; onCancel: () => void }>): void {
  const hasOverlay = overlayStore.use(selectHasOverlay);
  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: preparing && !takesPage && !hasOverlay },
  );
}
