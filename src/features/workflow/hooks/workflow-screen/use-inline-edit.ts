import { useEffect } from 'react';
import { openReviewFileExternally, type ReviewInputEffects } from '../../review-parser.js';
import type { UseInputModeResult } from '../use-input-mode.js';
import { externalEditRequestStore } from '../../../../stores/ui/external-edit-request.js';
import { reviewStore } from '../../../../stores/workflow/review.js';

export function useWorkflowInlineEdit(opts: {
  inputMode: UseInputModeResult;
  /** Absent leaves the production editor in place; the owner check runs either way. */
  openExternalEditor?: ReviewInputEffects['openExternalEditor'] | undefined;
}): void {
  const { inputMode, openExternalEditor } = opts;

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
