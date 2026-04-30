import type { RecoveryAction } from '../../core/schemas/enums.js';
import type { UserEditConflict, UserEditConflictAction } from '../../engine/orchestrator/user-edit/conflicts.js';
import { formatRecoveryActionChoice } from './recovery-prompt.js';

function formatFiles(files: string[]): string {
  const visible = files.slice(0, 3).join(', ');
  const hidden = files.length - 3;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible || 'no files';
}

function toRecoveryAction(action: UserEditConflictAction): RecoveryAction {
  switch (action) {
    case 'continue-unrelated': return 'continue';
    case 'regenerate-rebase': return 'planner-split-rebase';
    case 'pause': return 'pause-run';
    case 'skip-current-task': return 'skip-current-task';
    case 'abort-workflow': return 'abort-workflow';
  }
}

export function formatUserEditConflictPrompt(conflict: UserEditConflict): string {
  const task = conflict.currentTaskId ?? conflict.affectedTaskIds[0];
  const lines = [
    task
      ? `Recovery needed: user edit conflicts with ${task}`
      : 'Recovery needed: user edits require a decision',
    `Files: ${formatFiles(conflict.files)}`,
    conflict.affectedTaskIds.length > 0
      ? `Affected tasks: ${conflict.affectedTaskIds.join(', ')}`
      : '',
    '',
    ...conflict.availableActions.map(action =>
      formatRecoveryActionChoice(toRecoveryAction(action), { reason: 'user-edit-conflict' })
    ),
  ];
  return lines.filter((line, index) => line.length > 0 || lines[index - 1] !== '').join('\n').trimEnd();
}

export function parseUserEditConflictAnswer(
  input: string,
  availableActions: UserEditConflictAction[],
): UserEditConflictAction {
  const value = input.trim().toLowerCase();
  const allowed = new Set<UserEditConflictAction>(availableActions);

  if ((value === 'continue' || value === 'c') && allowed.has('continue-unrelated')) return 'continue-unrelated';
  if (
    (value === 'regenerate' || value === 'rebase' || value === 'planner' || value === 'split' || value === 'p' || value === 'r')
    && allowed.has('regenerate-rebase')
  ) {
    return 'regenerate-rebase';
  }
  if ((value === 'skip' || value === 's') && allowed.has('skip-current-task')) return 'skip-current-task';
  if ((input.length > 0 && input.trim().length === 0 || value === 'space' || value === 'pause') && allowed.has('pause')) return 'pause';
  if ((value === 'abort' || value === 'quit' || value === 'q' || value === 'a') && allowed.has('abort-workflow')) return 'abort-workflow';
  return allowed.has('pause') ? 'pause' : availableActions[0] ?? 'pause';
}
