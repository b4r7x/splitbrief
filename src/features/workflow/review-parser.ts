import { spawn } from 'node:child_process';
import { reviewStore } from '../../stores/workflow/review.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { requestEnqueue } from './handlers.js';
import { isLivePhase, isImplementerPhase } from '../../core/phases.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

export const REVIEW_HINT = 'approve / edit / comment <text> / quit';
export const BRIEFS_REVIEW_HINT = 'approve | e/edit | comment <text> | reject';

const APPROVE_ALIASES = new Set(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue']);
const QUIT_ALIASES = new Set(['quit', 'reject', 'no', 'n']);

export type ReviewAction =
  | { action: 'approve'; comment?: string }
  | { action: 'quit' }
  | { action: 'edit' }
  | null;

export function parseReviewCommand(text: string): ReviewAction {
  const cmd = text.toLowerCase().trim();
  if (APPROVE_ALIASES.has(cmd)) return { action: 'approve' };
  if (QUIT_ALIASES.has(cmd)) return { action: 'quit' };
  if (cmd === 'edit' || cmd === 'e') return { action: 'edit' };
  if (cmd.startsWith('comment ')) {
    const trimmed = text.trim();
    return { action: 'approve', comment: trimmed.slice(8).trim() };
  }
  return null;
}

function openInEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR || 'vi';
  return new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', (err) => reject(err));
  });
}

export interface ReviewInputHandler {
  handleInput: (text: string) => Promise<void>;
}

export function createReviewInputHandler(inputMode: UseInputModeResult): ReviewInputHandler {
  const handleInput = async (text: string) => {
    if (inputMode.mode === 'normal') {
      const phase = lifecycleStore.get().phase;
      if (isImplementerPhase(phase)) {
        feedbackStore.setError('Input disabled during task implementation. Press Ctrl-C to abort, or /redo-task <id> after the task finishes.');
        return;
      }
      if (isLivePhase(phase)) {
        const trimmed = text.trim();
        if (trimmed) {
          if (!requestEnqueue(trimmed, phase)) {
            feedbackStore.setError('Cannot queue message: no active workflow.');
          }
        }
      }
      return;
    }

    if (inputMode.mode === 'review') {
      const parsed = parseReviewCommand(text);
      if (!parsed) {
        feedbackStore.setError('Unknown command. Use: approve, edit, comment <text>, or quit');
        return;
      }
      if (parsed.action === 'approve') {
        inputMode.resolve({ approved: true, comment: parsed.comment });
      } else if (parsed.action === 'quit') {
        inputMode.resolve({ approved: false });
      } else if (parsed.action === 'edit') {
        const filePath = reviewStore.get().filePath;
        if (filePath) {
          try {
            await openInEditor(filePath);
            const phase = lifecycleStore.get().phase;
            if (phase === 'reviewing-briefs') {
              inputMode.resolve({ approved: false, action: 'edit' });
            }
          } catch (err) {
            feedbackStore.setError(`Failed to open editor: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return;
    }

    if (inputMode.mode === 'question') {
      inputMode.resolve(text);
    }
  };

  return { handleInput };
}
