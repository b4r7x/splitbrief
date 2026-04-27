import { describe, expect, it } from 'vitest';
import type { UserEditConflict } from '../../engine/orchestrator/user-edit-conflicts.js';
import { taskId } from '../../core/schemas/task.js';
import { formatUserEditConflictPrompt, parseUserEditConflictAnswer } from './user-edit-conflict-prompt.js';

const conflict: UserEditConflict = {
  kind: 'current-task-conflict',
  files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
  affectedTaskIds: [taskId('T001')],
  currentTaskId: taskId('T001'),
  fileConflicts: [],
  safeToContinue: false,
  availableActions: ['regenerate-rebase', 'pause', 'skip-current-task', 'abort-workflow'],
};

describe('user edit conflict prompt', () => {
  it('shows conflict kind, affected task, shortened files, and available actions', () => {
    expect(formatUserEditConflictPrompt(conflict)).toBe(
      'User edits: current-task-conflict tasks T001 (src/a.ts, src/b.ts, src/c.ts, +1 more). regenerate/rebase / pause / skip / abort',
    );
  });

  it('maps user answers to allowed conflict actions', () => {
    expect(parseUserEditConflictAnswer('rebase', conflict.availableActions)).toBe('regenerate-rebase');
    expect(parseUserEditConflictAnswer('skip', conflict.availableActions)).toBe('skip-current-task');
    expect(parseUserEditConflictAnswer('abort', conflict.availableActions)).toBe('abort-workflow');
    expect(parseUserEditConflictAnswer('wat', conflict.availableActions)).toBe('pause');
  });

  it('does not return continue when continue is not available', () => {
    expect(parseUserEditConflictAnswer('continue', conflict.availableActions)).toBe('pause');
  });
});
