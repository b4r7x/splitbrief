import { useEffect } from 'react';
import type { ApprovalReviewResult } from '../../../../core/approval/types.js';
import type { SpecFileRef } from '../../../../core/paths-io.js';
import { useInlineEditTrigger } from '../../../editor/use-inline-edit-trigger.js';
import { useFieldSessionOwned } from '../../../editor/use-field-session-owned.js';
import { openReviewFileExternally } from '../../review-parser.js';
import type { UseInputModeResult } from '../use-input-mode.js';
import { editorStore } from '../../../../stores/ui/editor.js';
import { externalEditRequestStore } from '../../../../stores/ui/external-edit-request.js';
import { reviewStore } from '../../../../stores/workflow/review.js';

export interface InlineFieldEditContext {
  resolve: (result: ApprovalReviewResult) => void;
  sessionRef: SpecFileRef;
}

let inlineFieldEditContext: InlineFieldEditContext | null = null;

export function getInlineFieldEditContext(): InlineFieldEditContext | null {
  return inlineFieldEditContext;
}

export function useWorkflowInlineEdit(opts: {
  promptPending: boolean;
  projectDir: string;
  activeSessionId: string | undefined;
  inputMode: UseInputModeResult;
  sessionDirPath: string | undefined;
}): { fieldSessionOwned: boolean } {
  const { promptPending, projectDir, activeSessionId, inputMode, sessionDirPath } = opts;

  const fieldSessionOpen = editorStore.use((s) => s.status === 'open' && s.surface === 'field');
  const fieldSessionOwned = useFieldSessionOwned();
  const globalKeysActive = !promptPending && !fieldSessionOwned;
  useInlineEditTrigger({ isActive: globalKeysActive, sessionDirPath });

  useEffect(() => {
    if (fieldSessionOpen && !fieldSessionOwned) editorStore.close();
  }, [fieldSessionOpen, fieldSessionOwned]);

  const externalEditToken = externalEditRequestStore.use((s) =>
    s.status === 'requested' ? s.ownerToken : null,
  );
  useEffect(() => {
    if (externalEditToken === null) return;
    externalEditRequestStore.consume();
    if (reviewStore.get().ownerToken !== externalEditToken) return;
    void openReviewFileExternally(inputMode);
  }, [externalEditToken, inputMode.resolve]);

  useEffect(() => {
    if (activeSessionId === undefined) {
      inlineFieldEditContext = null;
      return;
    }
    inlineFieldEditContext = {
      resolve: inputMode.resolve,
      sessionRef: { projectDir, sessionId: activeSessionId },
    };
    return () => {
      inlineFieldEditContext = null;
    };
  }, [projectDir, activeSessionId, inputMode.resolve]);

  return { fieldSessionOwned };
}
