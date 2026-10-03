import { dirname, join } from 'node:path';
import { readSessionFileConfined } from '../../core/sessions/confinement.js';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { labelError } from '../../utils/format-errors.js';
import { PLAN_JSON_FILE } from '../../core/paths.js';
import { reviewArtifactForPhase } from './prompt-rows/approval.js';

/** The file an edit at the plan card goes to: plan.json beside the plan.md it shows. */
export function reviewEditPath(): string | null {
  const { filePath } = reviewStore.get();
  if (filePath === null || reviewArtifactForPhase(lifecycleStore.get().phase) === null) return null;
  return join(dirname(filePath), PLAN_JSON_FILE);
}

/** Opens the gate's edit file in the editor overlay. `e` and Ctrl+E both land here. */
export async function openReviewEditor(): Promise<void> {
  const filePath = reviewEditPath();
  if (filePath === null) return;
  const ownerToken = reviewStore.get().ownerToken;
  try {
    const value = await readSessionFileConfined(dirname(filePath), filePath);
    if (value === null) {
      feedbackStore.setError(`Cannot edit: file not found (${filePath})`);
      return;
    }
    if (reviewStore.get().ownerToken !== ownerToken) return;
    const { cols, rows } = terminalSizeStore.get();
    editorStore.openRaw({ filePath, value, ownerToken, layout: { columns: cols, rows } });
    overlayStore.open('editor');
  } catch (err) {
    feedbackStore.setError(labelError('open editor', err));
  }
}
