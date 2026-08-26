import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { markInterruptResumed } from '../../stores/workflow/actions/resume.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { requestEnqueue } from './handlers.js';
import { editorDisplayLabel, resolveEditorArgv } from './editor-command.js';
import { isLivePhase, isImplementerPhase } from '../../core/phases.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import {
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

const spawnEditorProcess: SpawnEditor = (command, args) =>
  spawn(command, args, { stdio: 'inherit' });

interface RunEditorOptions {
  command: string;
  args: string[];
  filePath: string;
  spawnEditor: SpawnEditor;
}

function runEditor({
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
  if (lifecycleStore.get().phase === 'reviewing-briefs') {
    const result = reviewCommandToApprovalReviewResult({ action: 'external_edit_applied' });
    if (result) {
      feedbackStore.setMessage(`${lead} — applying changes`);
      inputMode.resolve(result);
    }
    return;
  }
  reviewStore.reloadReviewFile();
  feedbackStore.setMessage(`${lead} — content reloaded`);
}

let externalEditorOpen = false;

export async function openReviewFileExternally(
  inputMode: UseInputModeResult,
  spawnEditor: SpawnEditor = spawnEditorProcess,
): Promise<void> {
  const { filePath, ownerToken: reviewOwner } = reviewStore.get();
  if (!filePath) return;
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
    const before = await readReviewSnapshot(filePath);
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
      setPostEditorFeedback(
        reviewOwner,
        `Failed to open editor (${editorLabel}): ${toErrorMessage(err)}`,
        true,
      );
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

export function createReviewInputHandler(inputMode: UseInputModeResult): ReviewInputHandler {
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
      if (isImplementerPhase(phase)) {
        feedbackStore.setError(
          'Input disabled during task implementation. Press Ctrl-C to abort, or /redo-task <id> after the task finishes.',
        );
        return;
      }
      if (isLivePhase(phase)) {
        const trimmed = text.trim();
        if (trimmed) {
          const result = await requestEnqueue(trimmed, phase);
          if (!result) {
            feedbackStore.setError('Cannot queue message: no active workflow.');
          } else if (result.status === 'rejected') {
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
      if (parsed.kind === 'open-external-editor') {
        await openReviewFileExternally(inputMode);
      }
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
