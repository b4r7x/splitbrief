import { useEffect, useState } from 'react';
import { createDraftDocument } from '../../core/composer/document.js';
import type { Screen } from '../../core/navigation/types.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import {
  flushSessionDrafts,
  loadHomeDraft,
  loadSessionDraft,
  nameDraftsNotRemoved,
  reportDraftNotSaved,
  saveHomeDraft,
  saveSessionDraft,
} from '../../stores/ui/session-drafts.js';
import { toErrorMessage } from '../../utils/format/errors.js';

interface UseRestoredDraftParams {
  sessionRef: SessionRef | null;
  currentScreen: Screen;
  projectDir: string;
}

/** The draft the composer mounts with, and the save of each later draft to where it came from. */
export function useRestoredDraft({
  sessionRef,
  currentScreen,
  projectDir,
}: UseRestoredDraftParams): {
  document: DraftDocument;
  save: (document: DraftDocument) => void;
} {
  const [restoredDraft] = useState(() => {
    try {
      return {
        document:
          sessionRef !== null
            ? loadSessionDraft(sessionRef)
            : currentScreen === 'home'
              ? loadHomeDraft(projectDir)
              : createDraftDocument(''),
        error: null,
      };
    } catch (error) {
      return {
        document: createDraftDocument(''),
        error: `Could not restore session draft: ${toErrorMessage(error)}`,
      };
    }
  });
  useEffect(() => {
    if (restoredDraft.error !== null) feedbackStore.setError(restoredDraft.error);
  }, [restoredDraft]);
  useEffect(
    () => () => {
      if (sessionRef === null) return;
      try {
        flushSessionDrafts();
      } catch (error) {
        reportDraftNotSaved(error, false);
      }
      nameDraftsNotRemoved('screen');
    },
    [sessionRef?.projectDir, sessionRef?.sessionId],
  );
  return {
    document: restoredDraft.document,
    save: (document) => {
      if (sessionRef !== null) saveSessionDraft(sessionRef, document);
      else if (currentScreen === 'home') saveHomeDraft(projectDir, document);
    },
  };
}
