import { editorStore, fieldSessionOwnerToken } from '../../stores/ui/editor.js';
import { reviewStore } from '../../stores/workflow/review.js';

// The one ownership-keyed predicate for the inline field editor (CON-B / REQ-043): a field
// session is owned only while its captured ownerToken still owns the live connected prompt.
// Mount, input-suppression, and the field key hook all read this so they stay equivalent to
// the write-gate — when the owner disconnects (reviewStore.ownerToken advances or resets) the
// editor stops mounting, stops suppressing global input, and stops capturing keystrokes.
export function useFieldSessionOwned(): boolean {
  const ownerToken = editorStore.use(fieldSessionOwnerToken);
  const reviewOwner = reviewStore.use((s) => s.ownerToken);
  return ownerToken !== null && ownerToken === reviewOwner;
}
