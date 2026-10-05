import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { markInterruptResumed } from '../../stores/workflow/actions/resume.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { requestEnqueue } from './handlers.js';
import { openReviewEditor, reviewEditPath } from './review-editor.js';
import { editorDisplayLabel, resolveEditorArgv } from './editor-command.js';
import { isImplementerPhase, isLivePhase } from '../../core/phases.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import {
  REVIEW_COMMENT_DRAFT,
  REVIEW_UNKNOWN_COMMAND_MESSAGE,
  parseReviewCommand,
  reviewCommandToApprovalReviewResult,
  reviewOpeningPromptMessage,
} from './review-commands.js';

// Ink paints at most every ~33ms (maxFps 30), so the "Opening …" byline needs one frame
// on screen before the terminal handover freezes the TUI.
const OPENING_SIGNAL_PAINT_MS = 60;

interface EditorExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface EditorProcess {
  once(event: 'error', listener: (err: Error) => void): void;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export type SpawnEditor = (command: string, args: string[]) => EditorProcess;

export const spawnEditorProcess: SpawnEditor = (command, args) =>
  spawn(command, args, { stdio: 'inherit' });

interface RunEditorOptions {
  command: string;
  args: string[];
  filePath: string;
  spawnEditor: SpawnEditor;
}

export function runEditor({
  command,
  args,
  filePath,
  spawnEditor,
}: RunEditorOptions): Promise<EditorExit> {
  suspendTerminalForEditor();
  return new Promise<EditorExit>((resolve, reject) => {
    const child = spawnEditor(command, [...args, filePath]);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    resumeTerminalAfterEditor();
  });
}

async function readReviewSnapshot(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function setPostEditorFeedback(reviewOwner: number, message: string, isError = false): void {
  if (reviewStore.get().ownerToken !== reviewOwner) return;
  if (isError) {
    feedbackStore.setError(message);
    return;
  }
  feedbackStore.setMessage(message);
}

function applyExternalEdit(
  inputMode: UseInputModeResult,
  filePath: string,
  reviewOwner: number,
  lead: string,
): void {
  const fileName = basename(filePath);
  // The gate can settle — or be superseded by a new review — while the editor is out;
  // resolving now would settle the wrong gate with a stale edit. Gate identity is the
  // review owner token: settling clears it, a new review replaces it.
  if (reviewStore.get().ownerToken !== reviewOwner) {
    feedbackStore.setError(`Review closed while editing — ${fileName} saved but not applied`);
    return;
  }
  // The plan card shows plan.md, rendered from the plan.json just edited: only the engine can
  // check and compile it, so the edit settles the gate.
  feedbackStore.setMessage(`${lead} — applying changes`);
  inputMode.resolve({ approved: false, action: 'edit' });
}

let externalEditorOpen = false;

/**
 * `baseline` is the text the edit started from when it did not start from the file: the editor
 * overlay saves its buffer before it hands over, so its opening text is what an edit changed.
 */
export async function openReviewFileExternally(
  inputMode: UseInputModeResult,
  spawnEditor: SpawnEditor = spawnEditorProcess,
  baseline?: string | undefined,
): Promise<void> {
  const reviewOwner = reviewStore.get().ownerToken;
  const filePath = reviewEditPath();
  if (filePath === null) return;
  // A buffered second "e" while the editor is already out would stack a second handover
  // and a second editor over the same tty.
  if (externalEditorOpen) return;
  externalEditorOpen = true;
  try {
    const { command, args } = resolveEditorArgv();
    const editorLabel = editorDisplayLabel(command);
    const fileName = basename(filePath);
    const openingMessage = `Opening ${editorLabel} — ${fileName}…`;
    feedbackStore.setMessage(openingMessage);
    const before = baseline ?? (await readReviewSnapshot(filePath));
    await new Promise((resolve) => setTimeout(resolve, OPENING_SIGNAL_PAINT_MS));
    // Last check before the handover, so nothing may await after it: the paint window stays
    // interactive, and another armed review key ('y'/'q') can settle the gate — clearing the
    // review owner. Opening the editor then would freeze a live workflow and later resolve
    // the wrong gate.
    if (reviewStore.get().ownerToken !== reviewOwner) {
      if (feedbackStore.get().message === openingMessage) feedbackStore.setMessage(null);
      return;
    }
    let exit: EditorExit;
    try {
      exit = await runEditor({ command, args, filePath, spawnEditor });
    } catch (err) {
      const failure = `Failed to open editor (${editorLabel}): ${toErrorMessage(err)}`;
      // The overlay saved its edit before the handover: that edit still settles the card.
      const saved = await readReviewSnapshot(filePath);
      if (before !== null && saved !== null && before !== saved) {
        applyExternalEdit(inputMode, filePath, reviewOwner, failure);
        return;
      }
      setPostEditorFeedback(reviewOwner, failure, true);
      return;
    }
    const after = await readReviewSnapshot(filePath);
    const readable = before !== null && after !== null;
    const unchanged = readable && before === after;
    const changed = readable && before !== after;
    if (exit.signal === 'SIGINT') {
      // Ctrl+C in cooked mode signals the whole foreground process group; the TUI masks its
      // own handlers during the handover, so the editor child is the one that dies. That is
      // the user bailing out of the edit, not an app failure — unless the file was saved
      // first, in which case the saved content still counts.
      if (changed) {
        applyExternalEdit(inputMode, filePath, reviewOwner, `Edited ${fileName}`);
        return;
      }
      setPostEditorFeedback(reviewOwner, `Edit cancelled — ${editorLabel} closed by ctrl+c`);
      return;
    }
    // A failed exit says nothing about the file: an editor that saved and then crashed left
    // the new content on disk, and that content is what approval reads. Discarding it in the
    // UI only makes the review overlay disagree with the file.
    if (exit.signal !== null) {
      if (changed) {
        applyExternalEdit(
          inputMode,
          filePath,
          reviewOwner,
          `${editorLabel} terminated by ${exit.signal} but saved ${fileName}`,
        );
        return;
      }
      setPostEditorFeedback(
        reviewOwner,
        `Editor failed: ${editorLabel} terminated by ${exit.signal}`,
        true,
      );
      return;
    }
    if (exit.code !== 0) {
      const status = exit.code ?? 'unknown';
      if (changed) {
        applyExternalEdit(
          inputMode,
          filePath,
          reviewOwner,
          `Editor exited with status ${status} (${editorLabel}) but saved ${fileName}`,
        );
        return;
      }
      setPostEditorFeedback(
        reviewOwner,
        `Editor exited with status ${status} (${editorLabel}) — edit not applied`,
        true,
      );
      return;
    }
    if (unchanged) {
      setPostEditorFeedback(reviewOwner, `Editor closed — no changes to ${fileName}`);
      return;
    }
    // An unreadable file on either side leaves the edit unverifiable. The approval loop reads
    // the file itself, so the gate still settles on what is on disk — the wording just must
    // not claim an edit nobody confirmed.
    applyExternalEdit(
      inputMode,
      filePath,
      reviewOwner,
      readable ? `Edited ${fileName}` : `Could not read ${fileName} after editing`,
    );
  } finally {
    externalEditorOpen = false;
  }
}

export interface ReviewInputHandler {
  handleInput: (text: string) => Promise<void>;
}

/**
 * The two effects live review input spends outside the stores: the editor process and the
 * planner queue. Supplied whole or not at all — a caller that hands over one function owns
 * both, so no surface can start a real editor while it believes it is running on fixtures.
 */
export interface ReviewInputEffects {
  openExternalEditor: (inputMode: UseInputModeResult, baseline?: string) => Promise<void>;
  enqueue: typeof requestEnqueue;
}

const productionReviewInputEffects: ReviewInputEffects = {
  openExternalEditor: (inputMode, baseline) =>
    openReviewFileExternally(inputMode, spawnEditorProcess, baseline),
  enqueue: requestEnqueue,
};

export function createReviewInputHandler(
  inputMode: UseInputModeResult,
  effects: ReviewInputEffects = productionReviewInputEffects,
): ReviewInputHandler {
  const handleInput = async (text: string) => {
    if (inputMode.mode === 'normal') {
      const lifecycle = lifecycleStore.get();
      // Dead-zone window: the interrupt landed but the continuation prompt has not
      // parked yet, so typed text can neither steer nor queue — tell the user why.
      if (lifecycle.status === 'interrupted' && !lifecycle.interruptParked) {
        if (text.trim()) {
          feedbackStore.setMessage('Interrupt pending — stopping at the next step boundary.');
        }
        return;
      }
      const phase = lifecycle.phase;
      if (isLivePhase(phase) || isImplementerPhase(phase)) {
        const trimmed = text.trim();
        if (trimmed) {
          const result = await effects.enqueue(trimmed, phase);
          if (!result) {
            composerDraftStore.request(trimmed);
            feedbackStore.setError('Cannot queue message: no active workflow.');
          } else if (result.status === 'rejected') {
            // The submission was refused: the draft the composer just cleared comes back, so a
            // rejection never loses what the operator typed.
            composerDraftStore.request(trimmed);
            feedbackStore.setError(result.message);
          } else {
            feedbackStore.setMessage('Message queued for the next planner turn.');
          }
        }
      } else if (
        text.trim() &&
        (phase === 'reviewing-spec' || phase === 'reviewing-plan' || phase === 'reviewing-briefs')
      ) {
        feedbackStore.setError(reviewOpeningPromptMessage());
      }
      return;
    }

    if (inputMode.mode === 'review') {
      const parsed = parseReviewCommand(text);
      if (!parsed) {
        // Any other text at the plan card is a correction the planning session answers.
        const correction = text.trim();
        if (correction !== '' && reviewEditPath() !== null) {
          inputMode.resolve({ approved: false, action: 'revise', comment: correction });
          return;
        }
        feedbackStore.setError(REVIEW_UNKNOWN_COMMAND_MESSAGE);
        return;
      }
      if (parsed.kind === 'brief-review-command') {
        const result = reviewCommandToApprovalReviewResult(parsed.command);
        if (result) {
          inputMode.resolve(result);
          return;
        }
        if (parsed.command.action === 'save_draft') {
          feedbackStore.setError('Draft save is not available in the TUI. Use edit-file instead.');
          return;
        }
        feedbackStore.setMessage('Review prompt is still pending.');
        return;
      }
      if (parsed.kind === 'comment-draft') {
        composerDraftStore.request(REVIEW_COMMENT_DRAFT);
        return;
      }
      if (parsed.kind === 'open-editor') await openReviewEditor();
      return;
    }

    if (inputMode.mode === 'question') {
      // Contract: must call markInterruptResumed() before resolve() — a resolve
      // reaching a still-'interrupted' loop is treated as superseded and re-asked.
      if (lifecycleStore.get().status === 'interrupted') markInterruptResumed();
      inputMode.resolve(text);
    }
  };

  return { handleInput };
}
