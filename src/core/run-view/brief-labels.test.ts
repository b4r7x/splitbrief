import { describe, it, expect } from 'vitest';
import { taskRowLabel, taskTargetLabel, taskTargetParts } from './brief-labels.js';

describe('taskTargetLabel', () => {
  it('never renders a missing target as the literal string undefined', () => {
    // The resume path rebuilds tasks from persisted state that carries neither field.
    expect(taskTargetLabel({ id: 'T001', title: 'Resumed', status: 'pending' })).toBe('');
    expect(taskTargetLabel({ id: 'T001', title: 'Resumed', status: 'pending', file: 'a.ts' })).toBe(
      'a.ts',
    );
  });

  it('taskTargetLabel counts the rest of a slice in its own token, with the unit', () => {
    expect(
      taskTargetLabel({
        id: 'T001',
        title: 'Slice',
        status: 'in_progress',
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        action: 'modify',
      }),
    ).toBe('src/a.ts (modify) · +2 files');

    expect(
      taskTargetLabel({
        id: 'T001',
        title: 'Slice',
        status: 'in_progress',
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/b.ts'],
        action: 'modify',
      }),
    ).toBe('src/a.ts (modify) · +1 file');
  });

  it('returns the target path and annotations as separate parts', () => {
    expect(
      taskTargetParts({
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        action: 'modify',
      }),
    ).toEqual({ path: 'src/a.ts', note: '(modify)', extraFiles: '+2 files' });
    expect(taskTargetParts({ file: 'src/a.ts', files: ['src/a.ts', 'src/b.ts'] })).toEqual({
      path: 'src/a.ts',
      note: '',
      extraFiles: '+1 file',
    });
    expect(taskTargetParts({})).toEqual({
      path: '',
      note: '',
      extraFiles: '',
    });
  });

  it('keeps the extra file count separate when the target has no action', () => {
    expect(
      taskTargetLabel({
        id: 'T001',
        title: 'Slice',
        status: 'pending',
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/b.ts'],
      }),
    ).toBe('src/a.ts · +1 file');
  });
});

describe('taskRowLabel', () => {
  const task = {
    id: 'T006',
    title: 'Look up books',
    status: 'pending' as const,
    file: 'src/books.ts',
    action: 'modify' as const,
  };

  it.each([
    [45, 'T006 Look up books · src/books.ts (modify)'],
    [42, 'T006 Look up books · src/books.ts (modify)'],
    [41, 'T006 Look up books'],
    [18, 'T006 Look up books'],
    [17, 'T006 Look up boo…'],
    [13, 'T006 Look up…'],
    [6, 'T006 …'],
    [5, 'T006'],
    [4, 'T006'],
    [2, 'T006'],
  ])('fits the label at %i cells without splitting its target or id', (cells, expected) => {
    expect(taskRowLabel(task, cells)).toBe(expected);
  });

  it('uses terminal cells when it truncates a wide title', () => {
    expect(taskRowLabel({ ...task, title: '図書一覧' }, 11)).toBe('T006 図書…');
  });

  it('sanitizes the title and target before measuring them', () => {
    expect(taskRowLabel({ ...task, title: '\u001b[31mBooks\u001b[0m', file: 'a.ts' }, 80)).toBe(
      'T006 Books · a.ts (modify)',
    );
    expect(taskRowLabel({ id: task.id, title: '', status: task.status }, 4)).toBe('T006');
  });
});
