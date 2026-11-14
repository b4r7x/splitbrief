import { useEffect } from 'react';
import { sessionSelectStore } from '../../stores/navigation/session-select.js';
import { closeApprovalPrompt } from '../../stores/prompts/approval.js';

/** A page that goes away closes the approval prompt, unless a continuation's check asked it. */
export function useClosePromptOnLeave(): void {
  useEffect(
    () => () => {
      if (sessionSelectStore.get().preparation.kind === 'idle') closeApprovalPrompt();
    },
    [],
  );
}
