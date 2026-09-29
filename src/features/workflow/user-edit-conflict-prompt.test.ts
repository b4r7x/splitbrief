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

    expect(prompt).toContain('recovery needed · conflict with T001');
    expect(prompt).toContain('files src/a.ts · src/b.ts · src/c.ts · +1 more');
    expect(prompt).toContain('affected T001');
    expect(prompt).toContain(`${glyph('liveBar')} [space]  pause`);
    expect(prompt).toContain('[s]  skip task');
    expect(prompt).toContain('[a]  end run');
    expect(prompt).not.toContain('ask planner');
  });

  it('names the affected future brief and leads with its changed file', () => {
    const future: UserEditConflict = {
      ...conflict,
      kind: 'future-task-stale-input',
      files: ['docs/a.ts', 'docs/b.ts', 'docs/c.ts', 'src/future.ts'],
      affectedTaskIds: [taskId('T901')],
      currentTaskId: taskId('T900'),
      fileConflicts: [
        { file: 'docs/a.ts', kind: 'unrelated', affectedTaskIds: [] },
        { file: 'docs/b.ts', kind: 'unrelated', affectedTaskIds: [] },
        { file: 'docs/c.ts', kind: 'unrelated', affectedTaskIds: [] },
        {
          file: 'src/future.ts',
          kind: 'future-task-stale-input',
          affectedTaskIds: [taskId('T901')],
        },
        { file: 'ghost.ts', kind: 'future-task-stale-input', affectedTaskIds: [taskId('T901')] },
      ],
      safeToContinue: true,
      availableActions: ['continue-unrelated', 'pause', 'abort-workflow'],
    };
    const prompt = formatUserEditConflictPrompt(future);

    expect(prompt.split('\n')[0]).toBe('input to T901');
    expect(prompt).toContain('files src/future.ts · docs/a.ts · docs/b.ts · +1 more');
    expect(prompt).not.toContain('ghost.ts');
    expect(prompt).toContain('[c]  continue');
    expect(parseUserEditConflictAnswer('c', future.availableActions)).toBe('continue-unrelated');
    expect(parseUserEditConflictAnswer('', future.availableActions)).toBe('pause');
  });

  it('describes unrelated edits without a conflict claim', () => {
    const unrelated: UserEditConflict = {
      ...conflict,
      kind: 'unrelated',
      affectedTaskIds: [],
      safeToContinue: true,
      availableActions: ['continue-unrelated', 'pause', 'abort-workflow'],
    };

    expect(formatUserEditConflictPrompt(unrelated).split('\n')[0]).toBe(
      'outside the remaining briefs',
    );
  });

  it('names current and dependency conflicts by the stopped brief', () => {
    const dependency: UserEditConflict = {
      ...conflict,
      kind: 'dependency-file-conflict',
      affectedTaskIds: [taskId('T901')],
      currentTaskId: taskId('T900'),
    };
    expect(formatUserEditConflictPrompt(dependency).split('\n')[0]).toBe(
      'recovery needed · conflict with T900',
    );
    expect(formatUserEditConflictPrompt(conflict).split('\n')[0]).toBe(
      'recovery needed · conflict with T001',
    );
  });

  it('keeps the relation truthful when no task ID is known', () => {
    const noIds = { ...conflict, affectedTaskIds: [], currentTaskId: undefined };
    expect(
      formatUserEditConflictPrompt({
        ...noIds,
        kind: 'future-task-stale-input',
        safeToContinue: true,
        availableActions: ['continue-unrelated', 'pause'],
      }).split('\n')[0],
    ).toBe('input to a future brief');
    for (const kind of ['current-task-conflict', 'dependency-file-conflict'] as const) {
      expect(formatUserEditConflictPrompt({ ...noIds, kind }).split('\n')[0]).toBe(
        'recovery needed · conflict with the current brief',
      );
    }
    expect(
      formatUserEditConflictPrompt({ ...noIds, kind: 'changed-during-approval-promotion' }).split(
        '\n',
      )[0],
    ).toBe('recovery needed · changed during an approval');
  });

  it('does not mistake an affected brief for the stopped brief when its ID is missing', () => {
    for (const kind of ['current-task-conflict', 'dependency-file-conflict'] as const) {
      const prompt = formatUserEditConflictPrompt({
        ...conflict,
        kind,
        affectedTaskIds: [taskId('T901')],
        currentTaskId: undefined,
      });
      expect(prompt.split('\n')[0]).toBe('recovery needed · conflict with the current brief');
      expect(prompt).toContain('affected T901');
    }
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
    expect(parseUserEditConflictAnswer('c', conflict.availableActions)).toBe('pause');
  });
});
