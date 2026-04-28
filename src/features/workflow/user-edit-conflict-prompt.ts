import type { UserEditConflict, UserEditConflictAction } from '../../engine/orchestrator/user-edit-conflicts.js';

function formatFiles(files: string[]): string {
  const visible = files.slice(0, 3).join(', ');
  const hidden = files.length - 3;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible || 'no files';
}

function actionHint(action: UserEditConflictAction): string {
  switch (action) {
    case 'continue-unrelated': return 'continue';
    case 'regenerate-rebase': return 'regenerate/rebase';
    case 'pause': return 'pause';
    case 'skip-current-task': return 'skip';
    case 'abort-workflow': return 'abort';
  }
}

export function formatUserEditConflictPrompt(conflict: UserEditConflict): string {
  const tasks = conflict.affectedTaskIds.length > 0
    ? ` tasks ${conflict.affectedTaskIds.join(',')}`
    : '';
  const actions = conflict.availableActions.map(actionHint).join(' / ');
  return `User edits: ${conflict.kind}${tasks} (${formatFiles(conflict.files)}). ${actions}`;
}

export function parseUserEditConflictAnswer(
  input: string,
  availableActions: UserEditConflictAction[],
): UserEditConflictAction {
  const value = input.trim().toLowerCase();
  const allowed = new Set<UserEditConflictAction>(availableActions);

  if ((value === 'continue' || value === 'c') && allowed.has('continue-unrelated')) return 'continue-unrelated';
  if ((value === 'regenerate' || value === 'rebase' || value === 'r') && allowed.has('regenerate-rebase')) return 'regenerate-rebase';
  if ((value === 'skip' || value === 's') && allowed.has('skip-current-task')) return 'skip-current-task';
  if ((value === 'abort' || value === 'quit' || value === 'q' || value === 'a') && allowed.has('abort-workflow')) return 'abort-workflow';
  return allowed.has('pause') ? 'pause' : availableActions[0] ?? 'pause';
}
