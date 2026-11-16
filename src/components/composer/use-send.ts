import { useRef } from 'react';
import {
  type DraftSubmission,
  isCommandDraft,
  prepareDraftSubmission,
} from '../../core/composer/submission.js';
import type { InputMode, Screen } from '../../core/navigation/types.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import {
  draftDocumentText,
  getInputHistoryDocuments,
  inputHistoryStore,
} from '../../stores/ui/input-history.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { formatSubmissionFailure } from './home-hint.js';
import { COMMANDS_ONLY_NOTICE } from './key-gate.js';
import { isBlankDraft, trimDraftDocument } from './use-paste-drafts.js';

type AcceptedSubmission = Extract<DraftSubmission, { ok: true }>;

interface UseSendParams {
  projectDir: string;
  supportsImages: boolean;
  currentScreen: Screen;
  mode: InputMode;
  liveDocument: () => DraftDocument;
  commandsOnly: boolean | undefined;
  submitKeepsDraft: boolean | undefined;
  emptyAnswerNotice: string | undefined;
  completionOpen: boolean;
  onSubmit: ((submission: AcceptedSubmission) => void) | undefined;
  onSendNow: ((submission: AcceptedSubmission) => boolean) | undefined;
  onEmptySubmit: (() => void) | undefined;
  /** True while a clipboard read is pending; it says so on the feedback row. */
  refuseSubmit: () => boolean;
  clearDraft: () => void;
  runCommand: (line: string) => void;
}

/** ⏎ and ctrl+⏎ of the composer: a command runs, a text goes through the one send path. */
export function useSend({
  projectDir,
  supportsImages,
  currentScreen,
  mode,
  liveDocument,
  commandsOnly,
  submitKeepsDraft,
  emptyAnswerNotice,
  completionOpen,
  onSubmit,
  onSendNow,
  onEmptySubmit,
  refuseSubmit,
  clearDraft,
  runCommand,
}: UseSendParams): { submit: () => void; sendNow: () => void } {
  const submittedImageIdsRef = useRef<readonly string[]>([]);

  // One send path for every mode: the serializer decides what the runner reads, and the images it
  // validated are the ones parked for the call. Only the gates in front of it differ.
  const send = (candidate: DraftDocument, deliverNow?: UseSendParams['onSendNow']): boolean => {
    // Submitted text crosses this boundary exactly once, so this is where typing residue comes
    // off; the draft itself keeps what was typed, whitespace included.
    const submission = prepareDraftSubmission(trimDraftDocument(candidate), {
      projectDir,
      supportsImages,
    });
    if (!submission.ok) {
      // The draft outlives the refusal: the operator still has every word and every image.
      feedbackStore.setError(formatSubmissionFailure(submission));
      return false;
    }
    if (deliverNow?.(submission) === false) return false;
    const currentImageIds = new Set(submission.message.images.map((image) => image.id));
    const historicalImageIds = new Set(
      getInputHistoryDocuments(inputHistoryStore.get(), { currentScreen }).flatMap((entry) =>
        entry.parts.flatMap((part) => (part.kind === 'image' ? [part.attachment.id] : [])),
      ),
    );
    if (submission.message.images.length > 0) {
      attachmentsStore.replacePendingImages(submission.message.images);
    } else {
      const staleSubmittedIds = new Set([...submittedImageIdsRef.current, ...historicalImageIds]);
      for (const id of staleSubmittedIds) {
        if (!currentImageIds.has(id)) attachmentsStore.remove(id);
      }
    }
    submittedImageIdsRef.current = submission.message.images.map((image) => image.id);
    inputHistoryStore.pushDocumentSubmission(submission.document, { currentScreen });
    if (deliverNow === undefined) onSubmit?.(submission);
    return true;
  };

  const handleSubmit = (deliverNow?: UseSendParams['onSendNow']) => {
    if (refuseSubmit()) return;
    if (completionOpen) return;
    const document = liveDocument();
    const trimmed = trimDraftDocument(document);
    // A command runs in every mode: typed under a question or a recovery menu, it is never the answer.
    if (isCommandDraft(trimmed)) {
      if (trimmed.parts.some((part) => part.kind === 'image')) {
        feedbackStore.setMessage(
          onSendNow === undefined
            ? 'A command sends no image. Remove the image.'
            : 'A command sends no image. Remove the command, then press ctrl+⏎.',
        );
        return;
      }
      clearDraft();
      runCommand(draftDocumentText(trimmed));
      return;
    }

    if (mode !== 'normal') {
      if (emptyAnswerNotice !== undefined && isBlankDraft(document)) {
        feedbackStore.setMessage(emptyAnswerNotice);
        return;
      }
      if (send(document) && !submitKeepsDraft) clearDraft();
      return;
    }

    if (isBlankDraft(document)) {
      if (deliverNow === undefined) onEmptySubmit?.();
      return;
    }

    if (commandsOnly === true) {
      feedbackStore.setMessage(COMMANDS_ONLY_NOTICE);
      return;
    }

    if (send(document, deliverNow) && !submitKeepsDraft) clearDraft();
  };

  return { submit: () => handleSubmit(), sendNow: () => handleSubmit(onSendNow) };
}
