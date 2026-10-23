import { resolve } from 'node:path';
import { createDraftDocument } from '../../core/composer/document.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { readSessionDraft, writeSessionDraft } from '../../core/sessions/draft.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { SOFT_SEP } from '../../core/separators.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { createStore, storeBase } from '../create-store.js';
import { routerStore } from '../navigation/router.js';
import { feedbackStore } from './feedback.js';

const pending = new Map<string, { ref: SessionRef; document: DraftDocument }>();
// Home has no session to own a file, so its unsent draft lives as long as the process, one per
// project.
const homeDrafts = new Map<string, DraftDocument>();
let timer: ReturnType<typeof setTimeout> | null = null;

const DRAFT_REFUSAL_HINT = `Draft not saved${SOFT_SEP}esc or quit again leaves without it`;

/** A draft that could not be saved: what failed, and the screen whose leave it holds, if any. */
interface DraftRefusal {
  message: string;
  heldAt: number | undefined;
}

const refusal = createStore<DraftRefusal | null>(null);

export const draftRefusalStore = storeBase(refusal);

function key(ref: SessionRef): string {
  return JSON.stringify([resolve(ref.projectDir), ref.sessionId]);
}

export function loadSessionDraft(ref: SessionRef): DraftDocument {
  const unsaved = pending.get(key(ref));
  return unsaved?.document ?? readSessionDraft(ref) ?? createDraftDocument('');
}

export function loadHomeDraft(projectDir: string): DraftDocument {
  return homeDrafts.get(resolve(projectDir)) ?? createDraftDocument('');
}

export function saveHomeDraft(projectDir: string, document: DraftDocument): void {
  homeDrafts.set(resolve(projectDir), document);
}

/**
 * Writes every unsaved draft, then throws the first failure, retaining each draft that failed so
 * leaving or quitting can be retried. One session that cannot be written never costs another its
 * draft.
 */
export function flushSessionDrafts(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  let failure: { error: unknown } | undefined;
  for (const [id, draft] of pending) {
    try {
      writeSessionDraft(draft.ref, draft.document);
      pending.delete(id);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== undefined) throw failure.error;
  refusal.set(null);
}

/** Drops the drafts a failed flush retained, for a departure the user takes without them. */
export function discardPendingSessionDrafts(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending.clear();
  refusal.set(null);
}

/**
 * Names a draft that could not be saved. A leave holds once on its screen. The workflow screen
 * paints the cause and the file at the tail of its transcript, where no re-read of the run erases
 * them; home has no transcript, so its wrapping feedback carries them.
 */
export function reportDraftNotSaved(error: unknown, leaving: boolean): void {
  const message = toErrorMessage(error);
  refusal.set({ message, heldAt: leaving ? routerStore.currentSelection() : undefined });
  if (routerStore.get().screen === 'workflow') {
    feedbackStore.setError(leaving ? DRAFT_REFUSAL_HINT : 'Draft not saved');
  } else {
    feedbackStore.setError(leaving ? `${message}${SOFT_SEP}quit again leaves without it` : message);
  }
}

/** Whether this screen already held a leave for the draft, so the next leave goes without it. */
export function leaveWasRefusedHere(): boolean {
  const held = refusal.get()?.heldAt;
  return held !== undefined && routerStore.isCurrentSelection(held);
}

export function saveSessionDraft(ref: SessionRef, document: DraftDocument): void {
  pending.set(key(ref), { ref, document });
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      flushSessionDrafts();
    } catch (error) {
      reportDraftNotSaved(error, false);
    }
  }, 300);
  timer.unref();
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Discards pending drafts without
// writing them, and every home draft, so suite isolation never depends on the screens a previous
// test mounted.
export function __testDiscardPending(): void {
  discardPendingSessionDrafts();
  homeDrafts.clear();
}
