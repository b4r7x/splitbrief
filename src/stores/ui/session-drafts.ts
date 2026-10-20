import { resolve } from 'node:path';
import { createDraftDocument } from '../../core/composer/document.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { readSessionDraft, writeSessionDraft } from '../../core/sessions/draft.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { feedbackStore } from './feedback.js';

const pending = new Map<string, { ref: SessionRef; document: DraftDocument }>();
// Home has no session to own a file, so its unsent draft lives as long as the process, one per
// project.
const homeDrafts = new Map<string, DraftDocument>();
let timer: ReturnType<typeof setTimeout> | null = null;

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

/** Throws on failure, retaining the unsaved draft so leaving or quitting can be retried. */
export function flushSessionDrafts(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  for (const [id, draft] of pending) {
    writeSessionDraft(draft.ref, draft.document);
    pending.delete(id);
  }
}

export function saveSessionDraft(ref: SessionRef, document: DraftDocument): void {
  pending.set(key(ref), { ref, document });
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      flushSessionDrafts();
    } catch (error) {
      feedbackStore.setError(`Could not save session draft: ${toErrorMessage(error)}`);
    }
  }, 300);
  timer.unref();
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Discards pending drafts without
// writing them, and every home draft, so suite isolation never depends on the screens a previous
// test mounted.
export function __testDiscardPending(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending.clear();
  homeDrafts.clear();
}
