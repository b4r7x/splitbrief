import { describe, expect, it } from 'vitest';
import type { UserEditConflict } from '../../engine/events/workflow-events.js';
import { taskId } from '../../core/schemas/task.js';
import { glyph } from '../../lib/glyphs.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';

const conflict: UserEditConflict = {
  kind: 'current-task-conflict',
  files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
  affectedTaskIds: [taskId('T001')],
  currentTaskId: taskId('T001'),
  fileConflicts: [],
  safeToContinue: false,
  availableActions: ['pause', 'skip-current-task', 'abort-workflow'],
};

describe('user edit conflict prompt', () => {
  it('shows affected task, shortened files, and recovery actions', () => {
    const prompt = formatUserEditConflictPrompt(conflict);

    expect(prompt).toContain('recovery needed · your edits conflict with T001');
    expect(prompt).toContain('files src/a.ts · src/b.ts · src/c.ts · 1 more');
    expect(prompt).toContain('affected T001');
    expect(prompt).toContain(`${glyph('liveBar')} [space]  pause`);
    expect(prompt).toContain('[s]  skip task');
    expect(prompt).toContain('[a]  abort');
    expect(prompt).not.toContain('ask planner');
  });

  it('maps user answers to allowed conflict actions', () => {
    expect(parseUserEditConflictAnswer('p', conflict.availableActions)).toBe('pause');
    expect(parseUserEditConflictAnswer('rebase', conflict.availableActions)).toBe('pause');
    expect(parseUserEditConflictAnswer('skip', conflict.availableActions)).toBe(
      'skip-current-task',
    );
    expect(parseUserEditConflictAnswer('space', conflict.availableActions)).toBe('pause');
    expect(parseUserEditConflictAnswer('abort', conflict.availableActions)).toBe('abort-workflow');
    expect(parseUserEditConflictAnswer('wat', conflict.availableActions)).toBe('pause');
  });

  it('does not return continue when continue is not available', () => {
    expect(parseUserEditConflictAnswer('continue', conflict.availableActions)).toBe('pause');
  });
});
