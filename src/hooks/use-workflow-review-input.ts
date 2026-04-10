import { workflowStore } from '../stores/workflow.js';
import { feedbackStore } from '../stores/feedback.js';
import { parseReviewCommand } from '../core/commands/review-commands.js';
import { openInEditor } from '../utils/editor.js';
import type { UseInputModeResult } from './use-input-mode.js';

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
        const filePath = workflowStore.get().reviewFilePath;
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
