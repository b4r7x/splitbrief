import { spawn } from 'node:child_process';
import { markInterruptResumed } from '../../stores/workflow/actions.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { requestEnqueue } from './handlers.js';
import { resolveEditorArgv } from './editor-command.js';
import { isLivePhase, isImplementerPhase } from '../../core/phases.js';
import { briefReviewCommandToApprovalReviewResult } from '../../core/schemas/brief-review-command.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import {
  REVIEW_HINT,
  BRIEFS_REVIEW_HINT,
  REVIEW_UNKNOWN_COMMAND_MESSAGE,
  parseReviewCommand,
  reviewOpeningPromptMessage,
} from './review-commands.js';

export { REVIEW_HINT, BRIEFS_REVIEW_HINT, parseReviewCommand };

function openInEditor(filePath: string): Promise<void> {
  const { command, args } = resolveEditorArgv();
  return (async () => {
    suspendTerminalForEditor();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args, filePath], { stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code === 0) {
            resolve();
            return;
          }
          const exit = signal ? `signal ${signal}` : `status ${code ?? 'unknown'}`;
          reject(new Error(`Editor exited with ${exit}`));
        });
      });
    } finally {
      resumeTerminalAfterEditor();
    }
  })();
}

export async function openReviewFileExternally(inputMode: UseInputModeResult): Promise<void> {
  const filePath = reviewStore.get().filePath;
  if (!filePath) return;
  try {
    await openInEditor(filePath);
    const phase = lifecycleStore.get().phase;
    if (phase === 'reviewing-briefs') {
      const result = briefReviewCommandToApprovalReviewResult({
        action: 'external_edit_applied',
      });
      if (result) inputMode.resolve(result);
    } else {
      reviewStore.reloadReviewFile();
    }
  } catch (err) {
    feedbackStore.setError(`Failed to open editor: ${toErrorMessage(err)}`);
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
        feedbackStore.setError(reviewOpeningPromptMessage(phase));
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
        const result = briefReviewCommandToApprovalReviewResult(parsed.command);
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
