import type { UserEditConflictAction } from '../../core/schemas/enums.js';
import type { UserEditConflict } from '../../engine/events/workflow-events.js';
import { formatMiddotList, formatRecoveryActionLines } from './recovery-prompt.js';
import { userEditActionToRecoveryAction } from '../../core/recovery/user-edit-actions.js';

function formatFiles(files: string[]): string {
  return formatMiddotList(files, 3) || 'no files';
}

export function formatUserEditConflictPrompt(conflict: UserEditConflict): string {
  const task = conflict.currentTaskId ?? conflict.affectedTaskIds[0];
  const actions = conflict.availableActions.map((action) => userEditActionToRecoveryAction(action));
  const recommended = actions.includes('pause-run') ? 'pause-run' : actions[0];
  const lines = [
    task
      ? `recovery needed · your edits conflict with ${task}`
      : 'recovery needed · your edits require a decision',
    '',
    `files ${formatFiles(conflict.files)}`,
    conflict.affectedTaskIds.length > 0
      ? `affected ${formatMiddotList(conflict.affectedTaskIds, 3)}`
      : '',
    '',
    ...formatRecoveryActionLines(actions, { reason: 'user-edit-conflict' }, recommended),
  ];
  return lines
    .filter((line, index) => line.length > 0 || lines[index - 1] !== '')
    .join('\n')
    .trimEnd();
}

export function parseUserEditConflictAnswer(
  input: string,
  availableActions: UserEditConflictAction[],
): UserEditConflictAction {
  const value = input.trim().toLowerCase();
  const allowed = new Set<UserEditConflictAction>(availableActions);

  if ((value === 'continue' || value === 'c') && allowed.has('continue-unrelated'))
    return 'continue-unrelated';
  if ((value === 'skip' || value === 's') && allowed.has('skip-current-task'))
    return 'skip-current-task';
  const isWhitespaceOnly = input.length > 0 && input.trim().length === 0;
  if ((isWhitespaceOnly || value === 'space' || value === 'pause') && allowed.has('pause'))
    return 'pause';
  if (
    (value === 'abort' || value === 'quit' || value === 'q' || value === 'a') &&
    allowed.has('abort-workflow')
  )
    return 'abort-workflow';
  return allowed.has('pause') ? 'pause' : (availableActions[0] ?? 'pause');
}
