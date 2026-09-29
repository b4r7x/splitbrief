import type { UserEditConflictKind } from '../schemas/enums.js';
import { assertNever } from '../../utils/type-guards.js';

export function userEditConflictRelation(input: {
  kind: UserEditConflictKind;
  affectedTaskIds: readonly string[];
  currentTaskId?: string | undefined;
}): string {
  const { kind, affectedTaskIds, currentTaskId } = input;
  const briefs = affectedTaskIds.join(', ');
  switch (kind) {
    case 'unrelated':
      return 'outside the remaining briefs';
    case 'future-task-stale-input':
      return briefs === '' ? 'input to a future brief' : `input to ${briefs}`;
    case 'current-task-conflict':
    case 'dependency-file-conflict':
      return `conflict with ${currentTaskId ?? 'the current brief'}`;
    case 'changed-during-approval-promotion':
      return briefs === ''
        ? 'changed during an approval'
        : `changed during the approval of ${briefs}`;
    default:
      return assertNever(kind);
  }
}
