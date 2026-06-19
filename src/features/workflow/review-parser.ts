import { spawn } from 'node:child_process';
import { reviewStore } from '../../stores/workflow/review.js';
import { planEditorStore } from '../../stores/workflow/plan-editor.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { requestEnqueue } from './handlers.js';
import { resolveEditorArgv } from './editor-command.js';
import { isLivePhase, isImplementerPhase } from '../../core/phases.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

export const REVIEW_HINT = 'approve / edit / comment <text> / quit';
export const BRIEFS_REVIEW_HINT = 'approve | e/edit | E/edit-file | comment <text> | reject';

const APPROVE_ALIASES = new Set(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue']);
const QUIT_ALIASES = new Set(['quit', 'reject', 'no', 'n']);

export type ReviewAction =
  | { action: 'approve'; comment?: string }
  | { action: 'quit' }
  | { action: 'edit' }
  | { action: 'edit-file' }
  | null;

export function parseReviewCommand(text: string): ReviewAction {
  const raw = text.trim();
  const cmd = raw.toLowerCase();
  if (APPROVE_ALIASES.has(cmd)) return { action: 'approve' };
  if (QUIT_ALIASES.has(cmd)) return { action: 'quit' };
  if (cmd === 'edit-file' || raw === 'E') return { action: 'edit-file' };
  if (cmd === 'edit' || cmd === 'e') return { action: 'edit' };
  if (cmd.startsWith('comment ')) {
    const trimmed = text.trim();
    return { action: 'approve', comment: trimmed.slice(8).trim() };
  }
  return null;
}

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

export interface ReviewInputHandler {
  handleInput: (text: string) => Promise<void>;
}

export function createReviewInputHandler(inputMode: UseInputModeResult): ReviewInputHandler {
  const handleInput = async (text: string) => {
    if (inputMode.mode === 'normal') {
      const phase = lifecycleStore.get().phase;
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
        const phase = lifecycleStore.get().phase;
        if (phase === 'reviewing-briefs') {
          planEditorStore.setRuntimeRichMode(true);
          feedbackStore.setError(null);
          return;
        }
        const filePath = reviewStore.get().filePath;
        if (filePath) {
          try {
            await openInEditor(filePath);
          } catch (err) {
            feedbackStore.setError(`Failed to open editor: ${toErrorMessage(err)}`);
          }
        }
      } else if (parsed.action === 'edit-file') {
        const filePath = reviewStore.get().filePath;
        if (filePath) {
          try {
            await openInEditor(filePath);
            const phase = lifecycleStore.get().phase;
            if (phase === 'reviewing-briefs') {
              inputMode.resolve({ approved: false, action: 'edit' });
            }
          } catch (err) {
            feedbackStore.setError(`Failed to open editor: ${toErrorMessage(err)}`);
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
