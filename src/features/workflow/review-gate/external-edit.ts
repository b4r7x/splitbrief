import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { resolveEditorArgv, editorDisplayLabel } from '../external-editor/command.js';
import {
  type SpawnEditor,
  spawnEditorProcess,
  OPENING_SIGNAL_PAINT_MS,
  type EditorExit,
  runEditor,
} from '../external-editor/spawn.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import { reviewEditPath } from './plan-editor.js';

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
    // interactive, and a typed review command can settle the gate — clearing the review owner.
    // Opening the editor then would freeze a live workflow and later resolve the wrong gate.
    if (reviewStore.get().ownerToken !== reviewOwner) {
      if (feedbackStore.get().message === openingMessage) feedbackStore.setMessage(null);
      return;
    }
    let exit: EditorExit;
    try {
      exit = await runEditor({
        command,
        args,
        kind: 'editor',
        filePath,
        purpose: 'edit',
        spawnEditor,
      });
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
