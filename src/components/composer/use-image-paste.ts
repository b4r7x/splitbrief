import { type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react';
import type {
  ClipboardImageResult,
  readClipboardImage as readSystemClipboardImage,
} from '../../core/attachments/clipboard-image.js';
import type { InputMode } from '../../core/navigation/types.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { InputRange } from '../input/atoms.js';
import { COMMANDS_ONLY_NOTICE } from './key-gate.js';

interface ImagePaste {
  controller: AbortController;
  epoch: number;
  mode: InputMode;
  questionEpoch: number | undefined;
  matchingText?: string | undefined;
}

const CLIPBOARD_IMAGE_ERRORS = {
  'no-image': 'Clipboard has no image',
  'too-large': 'Cannot paste image: larger than 10 MiB',
  'unsupported-platform': 'Clipboard image paste requires macOS',
  unavailable: 'Cannot read clipboard image',
} as const;

interface UseImagePasteParams {
  readClipboardImage: typeof readSystemClipboardImage;
  inputEpoch: number;
  mode: InputMode;
  questionEpoch: number | undefined;
  disabled: boolean | undefined;
  commandsOnly: boolean | undefined;
  caretRef: RefObject<number>;
  canAttachImage: () => boolean;
  /**
   * Each insert below starts the next input epoch, once: the pastes still in the queue move to it.
   * The attach gives the length the image took in the view, or null when it refused the file.
   */
  attachImage: (path: string, at: number) => number | null;
  /** The length the text took in the view. */
  insertText: (text: string, at: number) => number;
}

/**
 * The clipboard reads of ctrl+V and of a text paste, one at a time and in the order they came.
 * Each read lands where its paste was made, moved by every edit and insert in front of it.
 */
export function useImagePaste({
  readClipboardImage,
  inputEpoch,
  mode,
  questionEpoch,
  disabled,
  commandsOnly,
  caretRef,
  canAttachImage,
  attachImage,
  insertText,
}: UseImagePasteParams): {
  pasteImage: () => void;
  enqueue: (at: number, matchingText?: string) => void;
  followEdit: (edit: InputRange) => void;
  cancel: () => void;
  refuseSubmit: () => boolean;
} {
  const [imagePaste, setImagePaste] = useState<ImagePaste | null>(null);
  const [imagePasteResult, setImagePasteResult] = useState<{
    request: ImagePaste;
    result: ClipboardImageResult;
  } | null>(null);
  const pasteQueueRef = useRef<Array<{ request: ImagePaste; at: number }>>([]);

  const finishImagePaste = useEffectEvent((request: ImagePaste, result: ClipboardImageResult) => {
    if (
      request.controller.signal.aborted ||
      request !== imagePaste ||
      request.epoch !== inputEpoch ||
      request.mode !== mode ||
      request.questionEpoch !== questionEpoch ||
      disabled ||
      commandsOnly === true
    )
      return;
    const paste = pasteQueueRef.current.shift();
    if (paste === undefined || paste.request !== request) return;
    let inserted = result.ok ? attachImage(result.path, paste.at) : null;
    if (inserted === null && request.matchingText !== undefined) {
      inserted = insertText(request.matchingText.normalize('NFC'), paste.at);
      if (!result.ok && result.reason !== 'too-large') feedbackStore.setInfo(null);
    }
    if (
      !result.ok &&
      result.reason !== 'cancelled' &&
      (request.matchingText === undefined || result.reason === 'too-large')
    ) {
      feedbackStore.setError(CLIPBOARD_IMAGE_ERRORS[result.reason]);
    }
    if (inserted !== null) {
      const delta = inserted;
      pasteQueueRef.current = pasteQueueRef.current.map((pending) => ({
        request: { ...pending.request, epoch: inputEpoch + 1 },
        at: pending.at < paste.at ? pending.at : pending.at + delta,
      }));
    }
    setImagePaste(pasteQueueRef.current[0]?.request ?? null);
  });

  useEffect(() => {
    if (imagePaste === null) return;
    if (
      imagePaste.controller.signal.aborted ||
      imagePaste.epoch !== inputEpoch ||
      imagePaste.mode !== mode ||
      imagePaste.questionEpoch !== questionEpoch ||
      disabled ||
      commandsOnly === true
    ) {
      for (const paste of pasteQueueRef.current) paste.request.controller.abort();
      pasteQueueRef.current = [];
      setImagePaste(null);
      return;
    }
    void readClipboardImage({
      signal: imagePaste.controller.signal,
      matchingText: imagePaste.matchingText,
    }).then(
      (result) => {
        if (!imagePaste.controller.signal.aborted)
          setImagePasteResult({ request: imagePaste, result });
      },
      () => {
        if (!imagePaste.controller.signal.aborted) {
          setImagePasteResult({
            request: imagePaste,
            result: { ok: false, reason: 'unavailable' },
          });
        }
      },
    );
    return () => imagePaste.controller.abort();
  }, [imagePaste, inputEpoch, disabled, commandsOnly, mode, questionEpoch, readClipboardImage]);

  useEffect(() => {
    if (imagePasteResult === null) return;
    // Commit concurrent keystrokes before inserting, so a read finishing in the same turn
    // cannot overwrite text that React has not rendered yet.
    finishImagePaste(imagePasteResult.request, imagePasteResult.result);
    setImagePasteResult(null);
  }, [imagePasteResult]);

  const enqueue = (at: number, matchingText?: string): void => {
    const request = {
      controller: new AbortController(),
      epoch: inputEpoch,
      mode,
      questionEpoch,
      matchingText,
    };
    pasteQueueRef.current.push({ request, at });
    if (pasteQueueRef.current.length === 1) setImagePaste(request);
    feedbackStore.setInfo(matchingText === undefined ? 'Pasting image…' : 'Pasting…');
  };

  return {
    pasteImage: () => {
      if (commandsOnly === true) {
        feedbackStore.setInfo(COMMANDS_ONLY_NOTICE);
        return;
      }
      if (!canAttachImage()) return;
      enqueue(caretRef.current);
    },
    enqueue,
    followEdit: (edit) => {
      for (const paste of pasteQueueRef.current) {
        if (edit.start < paste.at) {
          paste.at =
            edit.end <= paste.at
              ? paste.at + edit.text.length - (edit.end - edit.start)
              : edit.start;
        }
      }
    },
    cancel: () => {
      for (const paste of pasteQueueRef.current) paste.request.controller.abort();
      pasteQueueRef.current = [];
      setImagePaste(null);
    },
    refuseSubmit: () => {
      if (pasteQueueRef.current.length === 0) return false;
      feedbackStore.setInfo(imagePaste?.matchingText === undefined ? 'Pasting image…' : 'Pasting…');
      return true;
    },
  };
}
