import { ThemeText as Text, useTheme } from '../theme.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, type Key } from 'ink';
import { MultilineInput } from '../input/field.js';
import type { InputEdit } from '../input/atoms.js';
import { useCommandCompletion } from './completion/command/hook.js';
import { useReferenceCompletion } from './completion/reference/hook.js';
import { CompletionOverlay } from './completion/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { completionStore } from '../../stores/ui/completion.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-many.js';
import type { Screen } from '../../core/navigation/types.js';
import type { InputMode } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useHistory } from './use-history.js';
import { createDraftDocument, draftLength } from '../../core/composer/document.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DraftSubmission } from '../../core/composer/submission.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import { deriveHomeHintLines } from './home-hint.js';
import { placeholderForMode, promptColorForMode } from './prompt-mode.js';
import { HomeHintRow } from './home-hint-row.js';
import { useProjectFiles } from './use-project-files.js';
import { usePasteDrafts } from './use-paste-drafts.js';
import {
  computeComposerHintBudget,
  computeComposerInputColumns,
  fitComposerHintKeys,
} from './hint-zones.js';
import { useReviewKeys } from './use-review-keys.js';
import { useDraftSync } from './use-draft-sync.js';
import { useRestoredDraft } from './use-restored-draft.js';
import { useAttachImage } from './use-attach-image.js';
import { useImagePaste } from './use-image-paste.js';
import { useSend } from './use-send.js';
import { COMMANDS_ONLY_NOTICE, gateComposerKey } from './key-gate.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle/state.js';
import { composerLiveStore } from '../../stores/ui/composer-live.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { readClipboardImage as readSystemClipboardImage } from '../../core/attachments/clipboard-image.js';
import { routerStore } from '../../stores/navigation/router.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { listProjectFiles } from '../../lib/fs/listing.js';

export interface ComposerBoxHints {
  keys: string;
}

export interface HomeNotice {
  text: string;
  tone: 'textDim' | 'warning' | 'error';
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
  /** A notice that keeps the reserved row under feedback, where the hint gives it up. */
  homeNotice?: HomeNotice | undefined;
  boxHints?: ComposerBoxHints | undefined;
  onEmptySubmit?: (() => void) | undefined;
  /** A question mode whose empty answer means nothing refuses it here and keeps the focus. */
  emptyAnswerNotice?: string | undefined;
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
  homeNotice,
  boxHints,
  onEmptySubmit,
  emptyAnswerNotice,
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

  const restoredDraft = useRestoredDraft({ sessionRef, currentScreen, projectDir });
  const draft = usePasteDrafts({
    initialDocument: () => restoredDraft.document,
    onDocumentChange: restoredDraft.save,
    onDraftBack: () => holdMenus(),
  });
  const document = draft.document;
  const view = draft.view;
  const {
    inputEpoch,
    bumpEpoch,
    handleBoundaryNavigate,
    resetHistory,
    noteEdit,
    holdMenus,
    menusHeld,
  } = useHistory({
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
    imagePaste.followEdit(edit);
    // The draft a command stood over is back. The caret goes to the side the delete moves away
    // from, so a held Backspace or Delete stops at the draft's edge instead of eating into it.
    if (draft.applyEdit(edit)) {
      if (edit.caret >= edit.end) setCaretSeed({ epoch: inputEpoch + 1, index: 0 });
      bumpEpoch();
    }
    // Last, so the lists open over a draft that this edit brought back, as after any edit.
    noteEdit();
  };
  const setText = (next: string) => {
    imagePaste.cancel();
    noteEdit();
    if (draft.setText(next)) bumpEpoch();
  };
  const { clearDraft } = useDraftSync({
    mode,
    questionEpoch,
    actions: {
      setDocument: draft.replaceDocument,
      holdDocument: draft.holdDocument,
      prependDocument: draft.prependDocument,
      insertImage: insertDraftImage,
      resetHistory,
      holdMenus,
      bumpEpoch,
    },
  });
  const projectFiles = useProjectFiles(projectDir, listProjectFiles);

  // The one exit of a command, typed or run from the list; `send` is the one exit of a text.
  const runCommand = (line: string): void => {
    inputHistoryStore.pushDocumentSubmission(createDraftDocument(line), { currentScreen });
    onRuntimeCommand(line);
  };

  // A command runs from an answer too, so its list opens there.
  const command = useCommandCompletion({
    commands,
    currentScreen,
    value: mode === 'review' ? '' : view.text,
    setValue: setText,
    onRuntimeCommand: runCommand,
    disabled,
    suppressed: menusHeld,
  });

  const reference = useReferenceCompletion({
    files: projectFiles,
    value: mode === 'normal' ? view.text : '',
    setValue: setText,
    disabled,
    suppressed: menusHeld,
  });

  const showCommandSuggestions = command.showSuggestions;
  const showReferenceSuggestions = reference.showSuggestions && !showCommandSuggestions;
  const completionOpen = showCommandSuggestions || showReferenceSuggestions;

  const { supportsImages, canAttachImage, handleFileDrop } = useAttachImage({
    config,
    projectDir,
    caretRef,
    onReviewInteraction,
    noteEdit,
    insertImage: insertDraftImage,
    bumpEpoch,
  });

  const insertPastedText = (text: string, at: number): number => {
    noteEdit();
    draft.applyEdit({ start: at, end: at, text });
    setCaretSeed({
      epoch: inputEpoch + 1,
      index: caretRef.current < at ? caretRef.current : caretRef.current + text.length,
    });
    bumpEpoch();
    return text.length;
  };

  const imagePaste = useImagePaste({
    readClipboardImage,
    inputEpoch,
    mode,
    questionEpoch,
    disabled,
    commandsOnly,
    caretRef,
    canAttachImage,
    attachImage: handleFileDrop,
    insertText: insertPastedText,
  });

  const { submit, sendNow } = useSend({
    projectDir,
    supportsImages,
    currentScreen,
    mode,
    document,
    commandsOnly,
    submitKeepsDraft,
    emptyAnswerNotice,
    completionOpen,
    onSubmit,
    onSendNow,
    onEmptySubmit,
    refuseSubmit: imagePaste.refuseSubmit,
    clearDraft,
    runCommand,
  });

  const textDraftEmpty = draftLength(document) === 0;

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

  const lifecycleRunning = lifecycleStore.use((state) => state.status === 'running');
  const parked = stopStore.use((state) => state.phase === 'parked');
  const stopping = stopStore.use((state) => state.intent !== 'none');
  const reserveHomeHint = currentScreen === 'home';
  // A check the screen is waiting on owns the row while it runs, under feedback too. An
  // affordance never rides a status or a warning, so the drop invitation stands down until the row
  // is a hint or a plain notice again.
  const noticeTone = homeStatus === undefined ? (homeNotice?.tone ?? 'textDim') : 'textDim';
  const { feedbackLine, homeHintLine } = deriveHomeHintLines({
    active: reserveHomeHint && !showCommandSuggestions && !showReferenceSuggestions,
    homeHint,
    notice: homeStatus ?? homeNotice?.text,
    feedbackMessage,
    width: width ?? cols,
    dropEnabled:
      homeStatus === undefined &&
      noticeTone === 'textDim' &&
      !disabled &&
      supportsImages &&
      commandsOnly !== true,
  });
  const feedbackRows = feedbackLine?.split('\n') ?? [];
  const hintRows = Math.max(1, feedbackRows.length + (homeHintLine === null ? 0 : 1));
  // Home plans its body around this height, so it counts the home row and its message rows.
  const dockRows = (reserveHomeHint ? hintRows : 0) + visibleRows + 2;

  useEffect(() => {
    inputHeightStore.setRows(dockRows);
  }, [dockRows]);

  // The app-level esc ladder decides between the stop sheet and a protected draft, and it reads
  // keys outside this component, so what is typed here has to be published. It is a layout
  // effect so that a panel opening in the same commit reads this draft and not the last screen's.
  useLayoutEffect(() => {
    composerLiveStore.setDraft(document);
  }, [document]);

  useEffect(() => {
    completionStore.setOpen(completionOpen);
    return () => completionStore.setOpen(false);
  }, [completionOpen]);

  return (
    <Box flexDirection="column" width="100%" flexShrink={0} overflow="visible">
      {reserveHomeHint && (
        <HomeHintRow
          height={hintRows}
          feedbackRows={feedbackRows}
          feedbackIsError={feedbackIsError}
          hintLine={homeHintLine}
          hintTone={noticeTone}
        />
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
              onSubmit={submit}
              onPaste={(text, at) => {
                if (!supportsImages || commandsOnly === true) return false;
                imagePaste.enqueue(at, text);
                return true;
              }}
              {...(commandsOnly === true ? {} : { onFileDrop: handleFileDrop })}
              columns={inputColumns}
              focus={!disabled}
              shouldHandleInput={(input, key) => {
                const action = gateComposerKey(input, key, {
                  mode,
                  hasSendNow: onSendNow !== undefined,
                  runActive: lifecycleRunning || parked,
                  hasTab: onTab !== undefined,
                  completionOpen,
                  commandsOnly: commandsOnly === true,
                  draftEmpty: textDraftEmpty,
                });
                if (action === 'send-now') sendNow();
                else if (action === 'tab') onTab?.();
                else if (action === 'paste-image') imagePaste.pasteImage();
                else if (action === 'commands-only') feedbackStore.setMessage(COMMANDS_ONLY_NOTICE);
                return action === 'input';
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
        <CompletionOverlay
          command={command}
          reference={reference}
          showCommand={showCommandSuggestions}
          showReference={showReferenceSuggestions}
          rows={rows}
          visibleRows={visibleRows}
        />
      </Box>
    </Box>
  );
}
