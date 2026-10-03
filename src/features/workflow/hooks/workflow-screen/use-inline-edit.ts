import { useEffect } from 'react';
import { useInput } from 'ink';
import { openReviewEditor } from '../../review-editor.js';
import { openReviewFileExternally, type ReviewInputEffects } from '../../review-parser.js';
import { reviewArtifactForPhase } from '../../prompt-rows/approval.js';
import type { UseInputModeResult } from '../use-input-mode.js';
import { controlsStore } from '../../../../stores/ui/controls.js';
import { externalEditRequestStore } from '../../../../stores/ui/external-edit-request.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../../../stores/workflow/review.js';

export function useWorkflowInlineEdit(opts: {
  promptPending: boolean;
  inputMode: UseInputModeResult;
  /** Absent leaves the production editor in place; the owner check runs either way. */
  openExternalEditor?: ReviewInputEffects['openExternalEditor'] | undefined;
}): void {
  const { promptPending, inputMode, openExternalEditor } = opts;

  const reviewGate = lifecycleStore.use((s) => reviewArtifactForPhase(s.phase) !== null);
  const inReviewMode = controlsStore.use((c) => c.inputMode === 'review');
  const overlayFree = overlayStore.use((s) => s.active === 'none' && !s.exclusive);
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'e') void openReviewEditor();
    },
    { isActive: !promptPending && inReviewMode && reviewGate && overlayFree },
  );

  const request = externalEditRequestStore.use((s) => (s.status === 'requested' ? s : null));
  useEffect(() => {
    if (request === null) return;
    externalEditRequestStore.consume();
    if (reviewStore.get().ownerToken !== request.ownerToken) return;
    if (request.action === 'apply-edit') {
      inputMode.resolve({ approved: false, action: 'edit' });
      return;
    }
    const open: ReviewInputEffects['openExternalEditor'] =
      openExternalEditor ??
      ((mode, baseline) => openReviewFileExternally(mode, undefined, baseline));
    void open(inputMode, request.baseline);
  }, [request, inputMode.resolve, openExternalEditor]);
}
