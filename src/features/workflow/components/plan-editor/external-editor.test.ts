import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { planEditorStore } from '../../../../stores/workflow/plan-editor.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { openExternalEditor } from './external-editor.js';

const sessionDir = '/tmp/test-session';

function makeValidTaskMarkdown(id = 'T001'): string {
  return `---
id: ${id}
title: Test task
action: create
file: src/foo.ts
depends_on: []
---

### Description
Do something useful

### Implementation Steps
1. First step

### Tests
- returns true

### Constraints
- pure function
`;
}

beforeEach(() => {
  planEditorStore.__testReset();
  vi.clearAllMocks();
});

describe('openExternalEditor — edit mode', () => {
  it('writes temp file and reads back updated task', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as unknown as ReturnType<typeof spawnSync>);
    vi.mocked(readFileSync).mockReturnValue(makeValidTaskMarkdown('T001'));

    openExternalEditor(task, 'edit', sessionDir);

    expect(writeFileSync).toHaveBeenCalledWith(
      join(sessionDir, `edit-${task.id}.md`),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      [join(sessionDir, `edit-${task.id}.md`)],
      { stdio: 'inherit' },
    );
  });

  it('sets saveError when spawnSync returns an error', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      error: new Error('editor not found'),
    } as unknown as ReturnType<typeof spawnSync>);

    openExternalEditor(task, 'edit', sessionDir);

    expect(planEditorStore.get().saveError).toBe('Editor not found. Set $EDITOR.');
  });

  it('sets saveError when parsed result is not exactly 1 task', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as unknown as ReturnType<typeof spawnSync>);
    // return two tasks
    vi.mocked(readFileSync).mockReturnValue(
      makeValidTaskMarkdown('T001') + '\n' + makeValidTaskMarkdown('T002'),
    );

    openExternalEditor(task, 'edit', sessionDir);

    expect(planEditorStore.get().saveError).not.toBeNull();
  });

  it('replaces task at cursor position after successful edit', () => {
    const t1 = makeTask({ id: 'T001', title: 'Original', implementationSteps: ['step'], tests: ['test'] });
    const t2 = makeTask({ id: 'T002', title: 'Second', file: 'src/bar.ts', implementationSteps: ['step2'], tests: ['test2'] });
    planEditorStore.initEditor([t1, t2]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as unknown as ReturnType<typeof spawnSync>);
    vi.mocked(readFileSync).mockReturnValue(makeValidTaskMarkdown('T001'));

    openExternalEditor(t1, 'edit', sessionDir);

    const updatedTasks = planEditorStore.get().tasks;
    expect(updatedTasks).toHaveLength(2);
    expect(updatedTasks[0]?.title).toBe('Test task');
  });

  it('cleans up temp file', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as unknown as ReturnType<typeof spawnSync>);
    vi.mocked(readFileSync).mockReturnValue(makeValidTaskMarkdown('T001'));

    openExternalEditor(task, 'edit', sessionDir);

    expect(rmSync).toHaveBeenCalledWith(join(sessionDir, `edit-${task.id}.md`), { force: true });
  });
});

describe('openExternalEditor — split mode', () => {
  it('writes temp file with split instruction comment', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as unknown as ReturnType<typeof spawnSync>);
    vi.mocked(readFileSync).mockReturnValue(makeValidTaskMarkdown('T001'));

    openExternalEditor(task, 'split', sessionDir);

    const writtenContent = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
    expect(writtenContent).toContain('---');
    expect(writtenContent.startsWith('#')).toBe(true);
  });

  it('uses split- prefix for temp filename', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as unknown as ReturnType<typeof spawnSync>);
    vi.mocked(readFileSync).mockReturnValue(makeValidTaskMarkdown('T001'));

    openExternalEditor(task, 'split', sessionDir);

    expect(writeFileSync).toHaveBeenCalledWith(
      join(sessionDir, `split-${task.id}.md`),
      expect.any(String),
      expect.anything(),
    );
  });

  it('sets saveError when split produces no tasks', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, error: undefined } as unknown as ReturnType<typeof spawnSync>);
    vi.mocked(readFileSync).mockReturnValue('# no tasks here\n');

    openExternalEditor(task, 'split', sessionDir);

    expect(planEditorStore.get().saveError).not.toBeNull();
  });
});
