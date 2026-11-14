import { useLayoutEffect } from 'react';
import { useKeyState } from '../../../../hooks/use-key-state.js';
import { composerLiveStore } from '../../../../stores/ui/composer-live.js';
import { reviewKeysStore } from '../../../../stores/ui/review-keys.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { navigateIndex } from '../../../../utils/indexing.js';
import {
  reviewArtifactForPhase,
  reviewDocumentOptions,
} from '../../prompt-rows/review-document.js';
import { draftApprovesPlan, reviewDraftTarget } from '../../review-gate/commands.js';
import type { useWorkflowScreen } from './use-model.js';
import { usePanelFocus } from './use-panels.js';

/** The plan card: the row it selects, whether it holds the keys, and the row a draft points at. */
export function useReviewSelection(
  model: Pick<
    ReturnType<typeof useWorkflowScreen>,
    'inputMode' | 'promptPending' | 'phase' | 'hasOverlay'
  >,
) {
  const [selected, setSelected, latestSelected] = useKeyState(0);
  const commenting = reviewKeysStore.use((state) => state.commenting);
  const requested = reviewKeysStore.use((state) => state.requested);
  const draftText = composerLiveStore.use((state) => state.text);
  const approves = composerLiveStore.use((state) => draftApprovesPlan(state.document));
  const ownerToken = reviewStore.use((state) => state.ownerToken);
  const planCardArtifact =
    model.inputMode.mode === 'review' && !model.promptPending
      ? reviewArtifactForPhase(model.phase)
      : null;
  // An overlay takes the paint of the plan card. The card stays open below it, with its focus.
  const open = planCardArtifact !== null;
  const artifact = model.hasOverlay ? null : planCardArtifact;
  useLayoutEffect(() => {
    setSelected(0);
  }, [planCardArtifact, ownerToken]);
  const { focused, setMenu } = usePanelFocus(String(ownerToken), open);
  const waits = open && !focused;
  // A draft in the composer is what turns the letters back into text, so the flag the composer
  // publishes decides whether the panel follows the draft or the row ↓ moved to. Over a waiting
  // card the draft takes a row only when it is the word approve.
  const draft =
    artifact === null
      ? null
      : waits
        ? approves
          ? 'approve'
          : null
        : commenting
          ? reviewDraftTarget(draftText, requested)
          : null;

  const navigateBoundary = (direction: 'up' | 'down'): boolean => {
    if (artifact === null) return false;
    const optionCount = reviewDocumentOptions(artifact).length;
    setSelected(navigateIndex(direction, latestSelected(), optionCount));
    return true;
  };

  return {
    artifact,
    ownerToken,
    selected,
    latestSelected,
    focused,
    setFocused: setMenu,
    waits,
    draft,
    navigateBoundary,
  };
}
