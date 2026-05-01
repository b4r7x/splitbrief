import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTask } from '#testing/helpers/factories/task.js';
import { planEditorStore } from '../../../../stores/workflow/plan-editor.js';
import { openExternalEditor } from './external-editor.js';

let sessionDir: string;
let editorPath: string;

function makeValidTaskMarkdown(id = 'T001', title = 'Test task'): string {
  return `---
id: ${id}
title: ${title}
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

async function writeFakeEditor(): Promise<string> {
  const scriptPath = join(sessionDir, 'fake-editor.js');
  await writeFile(scriptPath, `#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const filePath = process.argv[2];
const mode = process.env.FAKE_EDITOR_MODE ?? 'valid-edit';

if (mode === 'exit-42') process.exit(42);
if (!filePath) process.exit(64);
if (mode === 'delete-file') {
  rmSync(filePath, { force: true });
  process.exit(0);
}
if (mode === 'append-marker') {
  const current = readFileSync(filePath, 'utf-8');
  if (!current.startsWith('# Edit the task below.')) process.exit(43);
  writeFileSync(filePath, current + '\\n<!-- touched -->\\n');
  process.exit(0);
}
if (mode === 'invalid-parse') {
  writeFileSync(filePath, 'not a task brief\\n');
  process.exit(0);
}
if (mode === 'two-tasks') {
  writeFileSync(filePath, process.env.FAKE_EDITOR_CONTENT + '\\n' + process.env.FAKE_EDITOR_CONTENT_2);
  process.exit(0);
}
writeFileSync(filePath, process.env.FAKE_EDITOR_CONTENT ?? '');
`, 'utf-8');
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

beforeEach(async () => {
  planEditorStore.__testReset();
  vi.clearAllMocks();
  sessionDir = await mkdtemp(join(tmpdir(), 'external-editor-test-'));
  editorPath = await writeFakeEditor();
  vi.stubEnv('EDITOR', editorPath);
  vi.stubEnv('FAKE_EDITOR_MODE', 'valid-edit');
  vi.stubEnv('FAKE_EDITOR_CONTENT', makeValidTaskMarkdown('T001', 'Updated task'));
  vi.stubEnv('FAKE_EDITOR_CONTENT_2', makeValidTaskMarkdown('T002', 'Second task'));
});

afterEach(async () => {
  planEditorStore.__testReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(sessionDir, { recursive: true, force: true });
});

describe('openExternalEditor edit mode', () => {
  it('writes a temp file, opens the configured editor, applies the edited task, and cleans up', async () => {
    const task = makeTask({ id: 'T001', title: 'Original', implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    openExternalEditor(task, 'edit', sessionDir);

    const updatedTasks = planEditorStore.get().tasks;
    expect(updatedTasks).toHaveLength(1);
    expect(updatedTasks[0]?.title).toBe('Updated task');
    expect(planEditorStore.get().saveError).toBeNull();
    await expect(readFile(join(sessionDir, `edit-${task.id}.md`), 'utf-8')).rejects.toThrow();
  });

  it('surfaces editor startup failures', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('EDITOR', join(sessionDir, 'missing-editor'));

    openExternalEditor(task, 'edit', sessionDir);

    expect(planEditorStore.get().saveError).toContain('Failed to open editor');
    expect(planEditorStore.get().saveError).toContain('ENOENT');
  });

  it('surfaces non-zero editor exit status without applying edits', () => {
    const task = makeTask({ id: 'T001', title: 'Original', implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'exit-42');

    openExternalEditor(task, 'edit', sessionDir);

    expect(planEditorStore.get().tasks[0]?.title).toBe('Original');
    expect(planEditorStore.get().saveError).toContain('Editor exited with status 42');
  });

  it('surfaces temp file write failures', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    openExternalEditor(task, 'edit', join(sessionDir, 'missing-session'));

    expect(planEditorStore.get().saveError).toContain('Failed to write editor file');
  });

  it('surfaces edited temp file read failures', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'delete-file');

    openExternalEditor(task, 'edit', sessionDir);

    expect(planEditorStore.get().saveError).toContain('Failed to read editor file');
  });

  it('surfaces parse errors from edited task markdown', () => {
    const task = makeTask({ id: 'T001', implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_CONTENT', makeValidTaskMarkdown('T001').replace('depends_on: []', 'depends_on: [T001]'));

    openExternalEditor(task, 'edit', sessionDir);

    expect(planEditorStore.get().saveError).toContain('Edit parse failed');
  });

  it('rejects multiple tasks in edit mode', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'two-tasks');

    openExternalEditor(task, 'edit', sessionDir);

    expect(planEditorStore.get().saveError).toContain('expects exactly 1 task');
  });
});

describe('openExternalEditor split mode', () => {
  it('writes split instructions before opening the editor', async () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'append-marker');

    openExternalEditor(task, 'split', sessionDir);

    const leftovers = await readdir(sessionDir);
    expect(leftovers).not.toContain(`split-${task.id}.md`);
    expect(planEditorStore.get().saveError).toBeNull();
  });

  it('surfaces split parse failures', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'invalid-parse');

    openExternalEditor(task, 'split', sessionDir);

    expect(planEditorStore.get().saveError).not.toBeNull();
  });
});
