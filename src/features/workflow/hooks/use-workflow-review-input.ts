import { spawn } from 'node:child_process';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { requestEnqueue } from '../handlers.js';
import { isLivePhase, isImplementerPhase } from '../../../core/phases.js';
import { parseReviewCommand } from '../../../core/slash-commands/review-commands.js';
import type { UseInputModeResult } from './use-input-mode.js';

function openInEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR || 'vi';
  return new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', (err) => reject(err));
  });
}

interface UseWorkflowReviewInputOptions {
  inputMode: UseInputModeResult;
}

interface UseWorkflowReviewInputResult {
  handleInput: (text: string) => Promise<void>;
}

export function useWorkflowReviewInput({
  inputMode,
}: UseWorkflowReviewInputOptions): UseWorkflowReviewInputResult {
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
          await openInEditor(filePath).catch((err) =>
            feedbackStore.setError(`Failed to open editor: ${err instanceof Error ? err.message : String(err)}`),
          );
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
