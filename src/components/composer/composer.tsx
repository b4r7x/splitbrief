import { ThemeText as Text, useTheme } from '../theme.js';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Box, type Key } from 'ink';
import { MultilineInput, type InputEdit } from '../input/multiline-input.js';
import { CommandCompletionMenu } from './completion/command/menu.js';
import { ReferenceCompletionMenu } from './completion/reference/menu.js';
import { useCommandCompletion } from './completion/command/hook.js';
import { useReferenceCompletion } from './completion/reference/hook.js';
import type { Theme } from '../../core/theme/palette.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { completionStore } from '../../stores/ui/completion.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import { SOFT_SEP } from '../../core/separators.js';
import { isTextEntryInput } from '../../lib/terminal/text-entry.js';
import type { Screen } from '../../core/navigation/types.js';
import type { InputMode } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useHistory } from './use-history.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { attachmentShortName, resolveAttachment } from '../../core/attachments/resolve.js';
import { formatAttachmentFailure } from '../../core/attachments/failure.js';
import { createDraftDocument, draftLength } from '../../core/composer/document.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import {
  type DraftSubmission,
  isCommandDraft,
  prepareDraftSubmission,
} from '../../core/composer/submission.js';
import { draftDocumentText, getInputHistoryDocuments } from '../../stores/ui/input-history.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { formatSeatIdentity } from '../../core/crew/identity.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { plannerSupportsImages } from '../../core/runners/capabilities.js';
import { computeCompletionOverlayRows, computeCompletionCap } from './completion/layout.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import {
  deriveHomeHintLines,
  formatSubmissionFailure,
  noVisionFeedbackMessage,
} from './home-hint.js';
import { useProjectFiles } from './use-project-files.js';
import { trimDraftDocument, usePasteDrafts } from './use-paste-drafts.js';
import {
  computeComposerHintBudget,
  computeComposerInputColumns,
  fitComposerHintKeys,
} from './hint-zones.js';
import { useReviewKeys } from './use-review-keys.js';
import { useDraftSync } from './use-draft-sync.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { composerLiveStore } from '../../stores/ui/composer-live.js';
import { stopStore } from '../../stores/workflow/stop.js';
import {
  readClipboardImage as readSystemClipboardImage,
  type ClipboardImageResult,
} from '../../core/attachments/clipboard-image.js';
import { routerStore } from '../../stores/navigation/router.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import {
  loadSessionDraft,
  saveSessionDraft,
  flushSessionDrafts,
} from '../../stores/ui/session-drafts.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import type { listProjectFiles } from '../../lib/file-listing.js';

const MAX_REFERENCE_SUGGESTIONS = 8;

export const COMMANDS_ONLY_NOTICE = `Only /commands here${SOFT_SEP}⏎ on an empty line goes home`;

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

// The prompt glyph is structure: it marks where typing goes, it does not name a category. Weight
// and position carry it, never hue — so normal and review draw the same mark. Question mode keeps
// its tone for now because the answer gate has no other cue at the caret; if that becomes a
// different glyph, this whole function goes.
function promptColorForMode(
  mode: InputMode,
  theme: Pick<Theme, 'text' | 'textDim' | 'warning'>,
): string | undefined {
  if (mode === 'review') return theme.textDim;
  if (mode === 'question') return theme.warning;
  return theme.text;
}

function placeholderForMode(input: {
  mode: InputMode;
  stopping: boolean;
  hint?: string | undefined;
}): string {
  if (input.hint) return input.hint;
  // The gate panel above owns approve, edit and reject; the composer only ever takes the comment.
  if (input.mode === 'review') return 'Type a comment…';
  if (input.mode === 'question') return 'Type your answer…';
  // A run being torn down takes no new work, and the legend row above already says so; repeating
  // an invitation to queue here would contradict it.
  if (input.stopping) return '';
  return 'Describe a change…';
}

export interface ComposerBoxHints {
  keys: string;
}

interface ComposerProps {
  onSubmit?: ((submission: Extract<DraftSubmission, { ok: true }>) => void) | undefined;
  onSendNow?: ((submission: Extract<DraftSubmission, { ok: true }>) => boolean) | undefined;
  onRuntimeCommand: (command: string) => void;
  commands: RuntimeCommandDef[];
  mode: InputMode;
  hint: string;
  currentScreen: Screen;
  width?: number;
  maxRows?: number | undefined;
  disabled?: boolean;
  submitKeepsDraft?: boolean;
  /** A record of a finished run takes commands, not work: plain text is refused, not queued. */
  commandsOnly?: boolean | undefined;
  /** Home keeps its example under the caret; a chat input hides it the moment it is focused. */
  keepPlaceholderWhileFocused?: boolean | undefined;
  promptGlyph?: string | undefined;
  homeHint?: string | undefined;
  /** What the screen is waiting on. It takes the reserved row for as long as it lasts. */
  homeStatus?: string | undefined;
  boxHints?: ComposerBoxHints | undefined;
  onEmptySubmit?: (() => void) | undefined;
  onTab?: (() => void) | undefined;
  onEditShortcut?: (() => void) | undefined;
  onReviewBoundaryNavigate?: ((direction: 'up' | 'down') => boolean | undefined) | undefined;
  onReviewInteraction?: (() => void) | undefined;
  questionEpoch?: number | undefined;
  inputPaddingX?: number | undefined;
  readClipboardImage?: typeof readSystemClipboardImage | undefined;
  listProjectFiles?: typeof listProjectFiles | undefined;
}

export function Composer(props: ComposerProps) {
  // The session draft belongs to the workflow's own composer. The review composer is a
  // per-owner comment box: it neither restores the draft nor overwrites it with comment text,
  // and the key keeps the two mounts apart so switching modes never carries text across.
  const ownsSessionDraft = props.currentScreen === 'workflow' && props.mode !== 'review';
  const ref = routerStore.use((route) =>
    ownsSessionDraft && route.screen === 'workflow' ? route.run.ref : null,
  );
  return (
    <ComposerInput
      key={
        ref === null
          ? `${props.currentScreen}:${props.mode === 'review' ? 'review' : 'root'}`
          : JSON.stringify([ref.projectDir, ref.sessionId])
      }
      {...props}
      sessionRef={ref}
    />
  );
}

function ComposerInput({
  sessionRef,
  onSubmit,
  onSendNow,
  onRuntimeCommand,
  commands,
  mode,
  hint,
  currentScreen,
  keepPlaceholderWhileFocused,
  width,
  maxRows = 6,
  disabled,
  submitKeepsDraft,
  commandsOnly,
  promptGlyph,
  homeHint,
  homeStatus,
  boxHints,
  onEmptySubmit,
  onTab,
  onEditShortcut,
  onReviewBoundaryNavigate,
  onReviewInteraction,
  questionEpoch,
  inputPaddingX = 1,
  readClipboardImage = readSystemClipboardImage,
  listProjectFiles,
}: ComposerProps & { sessionRef: SessionRef | null }) {
  const theme = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const [{ projectDir, config }] = useStores(configStore);
  const [{ message: feedbackMessage, isError: feedbackIsError }] = useStores(feedbackStore);
  const [caretSeed, setCaretSeed] = useState<{ epoch: number; index: number } | null>(null);
  const caretRef = useRef(0);
  const [visibleRows, setVisibleRows] = useState(1);
  const [imagePaste, setImagePaste] = useState<ImagePaste | null>(null);
  const [imagePasteResult, setImagePasteResult] = useState<{
    request: ImagePaste;
    result: ClipboardImageResult;
  } | null>(null);
  const pasteQueueRef = useRef<Array<{ request: ImagePaste; at: number }>>([]);
  const submittedImageIdsRef = useRef<readonly string[]>([]);

  const [restoredDraft] = useState(() => {
    try {
      return {
        document: sessionRef === null ? createDraftDocument('') : loadSessionDraft(sessionRef),
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
  const draft = usePasteDrafts({
    initialDocument: () => restoredDraft.document,
    onDocumentChange: (document) => {
      if (sessionRef !== null) saveSessionDraft(sessionRef, document);
    },
  });
  useEffect(
    () => () => {
      if (sessionRef === null) return;
      try {
        flushSessionDrafts();
      } catch (error) {
        feedbackStore.setError(`Could not save session draft: ${toErrorMessage(error)}`);
      }
    },
    [sessionRef?.projectDir, sessionRef?.sessionId],
  );
  const document = draft.document;
  const view = draft.view;
  const { inputEpoch, bumpEpoch, handleBoundaryNavigate, resetHistory, noteEdit, historyActive } =
    useHistory({
      disabled,
      document,
      setDocument: draft.replaceDocument,
      currentScreen,
    });

  const insertDraftImage = (attachment: Attachment, at = caretRef.current) => {
    const index = draft.insertImage(attachment, at);
    const nextCaret = caretRef.current < at ? caretRef.current : caretRef.current + index - at;
    setCaretSeed({ epoch: inputEpoch + 1, index: nextCaret });
    return index - at;
  };

  const handleChange = (_value: string, edit: InputEdit) => {
    onReviewInteraction?.();
    noteEdit();
    for (const paste of pasteQueueRef.current) {
      if (edit.start < paste.at) {
        paste.at =
          edit.end <= paste.at ? paste.at + edit.text.length - (edit.end - edit.start) : edit.start;
      }
    }
    draft.applyEdit(edit);
  };
  const setText = (next: string) => {
    for (const paste of pasteQueueRef.current) paste.request.controller.abort();
    pasteQueueRef.current = [];
    setImagePaste(null);
    noteEdit();
    draft.setText(next);
  };
  const { clearDraft } = useDraftSync({
    mode,
    questionEpoch,
    actions: {
      setDocument: draft.replaceDocument,
      insertImage: insertDraftImage,
      resetHistory,
      bumpEpoch,
    },
  });
  const projectFiles = useProjectFiles(projectDir, listProjectFiles);

  // A command runs from an answer too, so its list opens there.
  const command = useCommandCompletion({
    commands,
    currentScreen,
    value: mode === 'review' ? '' : view.text,
    setValue: setText,
    onRuntimeCommand,
    disabled,
    suppressed: historyActive,
  });

  const reference = useReferenceCompletion({
    files: projectFiles,
    value: mode === 'normal' ? view.text : '',
    setValue: setText,
    disabled,
    suppressed: historyActive,
  });

  const showCommandSuggestions = command.showSuggestions;
  const showReferenceSuggestions = reference.showSuggestions && !showCommandSuggestions;

  const detectionProviders = modelCacheStore.use((cache) => cache.detection.providers);
  const supportsImages = plannerSupportsImages(config, detectionProviders);

  const canAttachImage = (): boolean => {
    if (!supportsImages) {
      if (config === null) {
        feedbackStore.setError(
          'Cannot attach image: the planner cannot see images. Choose a vision model with /crew plan.',
        );
        return false;
      }
      const displayName = resolveSeatDisplayName(config.planner, 'planner', modelCacheStore);
      feedbackStore.setError(
        noVisionFeedbackMessage(formatSeatIdentity({ seat: config.planner, displayName })),
      );
      return false;
    }
    return true;
  };

  const handleFileDrop = (path: string, at = caretRef.current) => {
    if (!canAttachImage()) return null;
    const result = resolveAttachment({ path, projectDir });
    if (!result.ok) {
      feedbackStore.setError(
        formatAttachmentFailure({ action: 'attach-image', reason: result.reason }),
      );
      return null;
    }
    onReviewInteraction?.();
    // The image is a part of the draft at the caret, so the caret has to land after it on remount.
    // The seed is spent by the epoch it was made for; a later remount starts at the end as usual.
    noteEdit();
    const inserted = insertDraftImage(result.attachment, at);
    bumpEpoch();
    // The box already says where the image went; this row says which file it was, in a name that
    // survives the narrow widths an absolute path is truncated to nothing at.
    feedbackStore.setMessage(`Attached: ${attachmentShortName(result.attachment.path)}`);
    return inserted;
  };

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
    let inserted = result.ok ? handleFileDrop(result.path, paste.at) : null;
    if (inserted === null && request.matchingText !== undefined) {
      const text = request.matchingText.normalize('NFC');
      noteEdit();
      draft.applyEdit({ start: paste.at, end: paste.at, text });
      inserted = text.length;
      setCaretSeed({
        epoch: inputEpoch + 1,
        index: caretRef.current < paste.at ? caretRef.current : caretRef.current + inserted,
      });
      bumpEpoch();
      if (!result.ok && result.reason !== 'too-large') feedbackStore.setMessage(null);
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

  const enqueueImagePaste = (at: number, matchingText?: string): void => {
    const request = {
      controller: new AbortController(),
      epoch: inputEpoch,
      mode,
      questionEpoch,
      matchingText,
    };
    pasteQueueRef.current.push({ request, at });
    if (pasteQueueRef.current.length === 1) setImagePaste(request);
    feedbackStore.setMessage(matchingText === undefined ? 'Pasting image…' : 'Pasting…');
  };

  const handleImagePaste = (): void => {
    if (commandsOnly === true) {
      feedbackStore.setMessage(COMMANDS_ONLY_NOTICE);
      return;
    }
    if (!canAttachImage()) return;
    enqueueImagePaste(caretRef.current);
  };

  // One send path for every mode: the serializer decides what the runner reads, and the images it
  // validated are the ones parked for the call. Only the gates in front of it differ.
  const send = (
    candidate: DraftDocument,
    record: boolean,
    deliverNow?: ComposerProps['onSendNow'],
  ): boolean => {
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
    if (record) inputHistoryStore.pushDocumentSubmission(submission.document, { currentScreen });
    if (deliverNow === undefined) onSubmit?.(submission);
    return true;
  };

  const handleSubmit = (deliverNow?: ComposerProps['onSendNow']) => {
    if (pasteQueueRef.current.length > 0) {
      feedbackStore.setMessage(
        imagePaste?.matchingText === undefined ? 'Pasting image…' : 'Pasting…',
      );
      return;
    }
    if (showCommandSuggestions || showReferenceSuggestions) return;
    const trimmed = trimDraftDocument(document);
    // A command runs in every mode: typed under a question or a recovery menu, it is never the answer.
    if (isCommandDraft(trimmed)) {
      inputHistoryStore.pushDocumentSubmission(trimmed, { currentScreen });
      clearDraft();
      onRuntimeCommand(draftDocumentText(trimmed));
      return;
    }

    if (mode !== 'normal') {
      if (send(document, false) && !submitKeepsDraft) clearDraft();
      return;
    }

    if (trimmed.parts.length === 0) {
      if (deliverNow === undefined) onEmptySubmit?.();
      return;
    }

    if (commandsOnly === true) {
      feedbackStore.setMessage(COMMANDS_ONLY_NOTICE);
      return;
    }

    if (send(document, true, deliverNow) && !submitKeepsDraft) clearDraft();
  };

  const textDraftEmpty = draftLength(document) === 0;

  // Only the first character of a draft decides this: once a line is under way the keys are text
  // again, so editing a command never has to pass the gate a second time.
  const commandsOnlyGate = (input: string, key: Key): boolean => {
    if (commandsOnly !== true || !textDraftEmpty) return true;
    if (!isTextEntryInput(input, key) || input.startsWith('/')) return true;
    feedbackStore.setMessage(COMMANDS_ONLY_NOTICE);
    return false;
  };

  const reviewCommenting = useReviewKeys({ mode, disabled, draftEmpty: textDraftEmpty });

  const isEditShortcut = (input: string, key: Key): boolean =>
    mode === 'review' && key.ctrl && input === 'e';

  const handleInputBoundaryNavigate = (direction: 'up' | 'down') => {
    if (showCommandSuggestions || showReferenceSuggestions) return true;
    if (mode !== 'normal') {
      if (mode === 'review' && !reviewCommenting) onReviewBoundaryNavigate?.(direction);
      return true;
    }
    return handleBoundaryNavigate(direction);
  };

  const hintBoxWidth = width ?? cols;
  const hintKeys = fitComposerHintKeys(
    boxHints?.keys ?? '',
    computeComposerHintBudget({ boxWidth: hintBoxWidth, paddingX: inputPaddingX }),
  );
  const inputColumns = computeComposerInputColumns({
    boxWidth: hintBoxWidth,
    paddingX: inputPaddingX,
    hintKeys,
  });

  const completionCap = computeCompletionCap(rows, visibleRows);
  const referenceSuggestionsCap = Math.min(MAX_REFERENCE_SUGGESTIONS, completionCap);
  const commandOverlayRows = showCommandSuggestions
    ? computeCompletionOverlayRows({
        itemCount: command.filtered.length,
        maxVisible: completionCap,
        hasFuzzyMatch: command.fuzzyMatch !== null,
        hasEmptyMessage: command.filtered.length === 0 && command.fuzzyMatch === null,
      })
    : 0;
  const referenceOverlayRows = showReferenceSuggestions
    ? computeCompletionOverlayRows({
        itemCount: reference.filtered.length,
        maxVisible: referenceSuggestionsCap,
      })
    : 0;
  const lifecycleRunning = lifecycleStore.use((state) => state.status === 'running');
  const parked = stopStore.use((state) => state.phase === 'parked');
  const stopping = stopStore.use((state) => state.intent !== 'none');
  const reserveHomeHint = currentScreen === 'home';
  // A check the screen is waiting on owns the row while it runs. An affordance never rides a
  // status, so the drop invitation stands down until the row is a hint again.
  const { feedbackLine, homeHintLine } = deriveHomeHintLines({
    active: reserveHomeHint && !showCommandSuggestions && !showReferenceSuggestions,
    homeHint: homeStatus ?? homeHint,
    feedbackMessage,
    width: width ?? cols,
    dropEnabled: homeStatus === undefined && !disabled && supportsImages && commandsOnly !== true,
  });

  useEffect(() => {
    inputHeightStore.setRows(visibleRows + 2);
  }, [visibleRows]);

  // The app-level esc ladder decides between the stop sheet and a protected draft, and it reads
  // keys outside this component, so what is typed here has to be published.
  useEffect(() => {
    composerLiveStore.setDraft(document);
  }, [document]);

  const completionOpen = showCommandSuggestions || showReferenceSuggestions;
  useEffect(() => {
    completionStore.setOpen(completionOpen);
    return () => completionStore.setOpen(false);
  }, [completionOpen]);

  return (
    <Box flexDirection="column" width="100%" flexShrink={0} overflow="visible">
      {reserveHomeHint && (
        <Box justifyContent="center" height={1}>
          {feedbackLine !== null ? (
            <Text color={feedbackIsError ? theme.error : theme.textDim} wrap="truncate-end">
              {feedbackLine}
            </Text>
          ) : homeHintLine !== null ? (
            <Text color={theme.textDim} wrap="truncate-end">
              {homeHintLine}
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
      )}
      <Box flexDirection="column" width="100%" overflow="visible">
        <Box
          borderStyle={borderStyleFor('round')}
          borderColor={!disabled ? theme.accent : theme.border}
          paddingX={inputPaddingX}
          width="100%"
          minHeight={3}
          flexShrink={0}
        >
          <Text color={promptColorForMode(mode, theme)}>
            {`${promptGlyph ?? glyph('prompt')} `}
          </Text>
          <Box flexGrow={1} flexBasis={0} overflow="hidden">
            <MultilineInput
              key={`${command.inputKey}:${reference.inputKey}:${inputEpoch}`}
              value={view.text}
              atoms={view.atoms}
              {...(caretSeed?.epoch === inputEpoch ? { initialCursorIndex: caretSeed.index } : {})}
              onCursorChange={(index) => {
                caretRef.current = index;
              }}
              onChange={handleChange}
              onSubmit={() => handleSubmit()}
              onPaste={(text, at) => {
                if (!supportsImages || commandsOnly === true) return false;
                enqueueImagePaste(at, text);
                return true;
              }}
              {...(commandsOnly === true ? {} : { onFileDrop: handleFileDrop })}
              columns={inputColumns}
              focus={!disabled}
              shouldHandleInput={(input, key) => {
                if (
                  key.return &&
                  key.ctrl &&
                  onSendNow !== undefined &&
                  mode === 'normal' &&
                  (lifecycleRunning || parked)
                ) {
                  handleSubmit(onSendNow);
                  return false;
                }
                // An open list owns Tab: it completes the row, and focus stays in the box.
                if (onTab !== undefined && !completionOpen && (key.tab || (key.shift && key.tab))) {
                  onTab();
                  return false;
                }
                if (key.ctrl && input === 'v') {
                  handleImagePaste();
                  return false;
                }
                return commandsOnlyGate(input, key);
              }}
              placeholder={placeholderForMode({
                mode,
                stopping,
                hint,
              })}
              keepPlaceholderWhileFocused={keepPlaceholderWhileFocused === true || lifecycleRunning}
              rows={1}
              maxRows={maxRows}
              onVisibleRowsChange={setVisibleRows}
              keyBindings={{
                submit: (key: { return: boolean; shift: boolean }) => key.return && !key.shift,
                newline: (key: { return: boolean; shift: boolean }) => key.return && key.shift,
                ...(onEditShortcut ? { shortcut: isEditShortcut } : {}),
              }}
              {...(onEditShortcut ? { onShortcut: onEditShortcut } : {})}
              onBoundaryNavigate={handleInputBoundaryNavigate}
            />
          </Box>
          {hintKeys.length > 0 && (
            <Box flexShrink={0} marginLeft={2}>
              <Text color={theme.textDim}>{hintKeys}</Text>
            </Box>
          )}
        </Box>
        {showCommandSuggestions && (
          <Box position="absolute" width="100%" marginTop={-commandOverlayRows}>
            <CommandCompletionMenu
              filtered={command.filtered}
              selectedIndex={command.selectedIndex}
              fuzzyMatch={command.fuzzyMatch}
              maxVisible={completionCap}
            />
          </Box>
        )}
        {showReferenceSuggestions && (
          <Box position="absolute" width="100%" marginTop={-referenceOverlayRows}>
            <ReferenceCompletionMenu
              filtered={reference.filtered}
              selectedIndex={reference.selectedIndex}
              maxVisible={referenceSuggestionsCap}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
