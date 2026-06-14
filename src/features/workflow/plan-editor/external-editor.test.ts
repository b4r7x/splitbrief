import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { makeTask } from '#testing/helpers/factories/task.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { terminalSequences } from '../../../lib/terminal/control.js';
import { setActiveTerminalHandover } from '../../../lib/terminal/editor-handover.js';
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
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
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
if (mode === 'capture-input') {
  const received = readFileSync(filePath, 'utf-8');
  writeFileSync(process.env.FAKE_EDITOR_CAPTURE_PATH, received);
  process.exit(0);
}
if (mode === 'two-tasks') {
  writeFileSync(filePath, process.env.FAKE_EDITOR_CONTENT + '\\n' + process.env.FAKE_EDITOR_CONTENT_2);
  process.exit(0);
}
writeFileSync(filePath, process.env.FAKE_EDITOR_CONTENT ?? '');
`,
    'utf-8',
  );
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
  setActiveTerminalHandover(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(sessionDir, { recursive: true, force: true });
});

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('openExternalEditor edit mode', () => {
  it('writes a temp file, opens the configured editor, applies the edited task, and cleans up', async () => {
    const task = makeTask({
      id: 'T001',
      title: 'Original',
      implementationSteps: ['step'],
      tests: ['test'],
    });
    planEditorStore.initEditor([task]);

    openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });

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

    openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });

    expect(planEditorStore.get().saveError).toContain('Failed to open editor');
    expect(planEditorStore.get().saveError).toContain('ENOENT');
  });

  it('surfaces non-zero editor exit status without applying edits', () => {
    const task = makeTask({
      id: 'T001',
      title: 'Original',
      implementationSteps: ['step'],
      tests: ['test'],
    });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'exit-42');

    openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });

    expect(planEditorStore.get().tasks[0]?.title).toBe('Original');
    expect(planEditorStore.get().saveError).toContain('Editor exited with status 42');
  });

  itUnix('refuses to open the editor when the temp file path is a symlink', async () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    const outside = await mkdtemp(join(tmpdir(), 'external-editor-outside-'));
    try {
      await writeFile(join(outside, 'edit.md'), 'outside');
      await symlink(join(outside, 'edit.md'), join(sessionDir, `edit-${task.id}.md`));

      openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });

      expect(planEditorStore.get().saveError).toContain(
        'Refusing to write editor file through symlink',
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('surfaces temp file write failures', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    openExternalEditor({ task, mode: 'edit', sessionDirPath: join(sessionDir, 'missing-session') });

    expect(planEditorStore.get().saveError).toContain('Failed to write editor file');
  });

  it('surfaces edited temp file read failures', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'delete-file');

    openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });

    expect(planEditorStore.get().saveError).toContain('Failed to read editor file');
  });

  it('surfaces parse errors from edited task markdown', () => {
    const task = makeTask({ id: 'T001', implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv(
      'FAKE_EDITOR_CONTENT',
      makeValidTaskMarkdown('T001').replace('depends_on: []', 'depends_on: [T001]'),
    );

    openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });

    expect(planEditorStore.get().saveError).toMatch(/Edit (parse|validation) failed/);
  });

  itUnix('does not preserve failed edits through a preexisting .bad symlink', async () => {
    const task = makeTask({ id: 'T001', implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'invalid-parse');
    const outside = await mkdtemp(join(tmpdir(), 'external-editor-bad-outside-'));
    try {
      const outsideBad = join(outside, 'captured.md');
      await writeFile(outsideBad, 'outside');
      await symlink(outsideBad, join(sessionDir, `edit-${task.id}.md.bad`));

      openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });

      expect(await readFile(outsideBad, 'utf-8')).toBe('outside');
      expect(await readFile(join(sessionDir, `edit-${task.id}.md.bad.1`), 'utf-8')).toBe(
        'not a task brief\n',
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('allows edit mode tasks that depend on earlier tasks in the full plan', () => {
    const first = makeTask({
      id: 'T001',
      title: 'First',
      implementationSteps: ['step'],
      tests: ['test'],
    });
    const second = makeTask({
      id: 'T002',
      title: 'Second',
      dependsOn: ['T001'],
      implementationSteps: ['step'],
      tests: ['test'],
    });
    planEditorStore.initEditor([first, second]);
    vi.stubEnv(
      'FAKE_EDITOR_CONTENT',
      makeValidTaskMarkdown('T002', 'Updated second').replace(
        'depends_on: []',
        'depends_on: [T001]',
      ),
    );

    openExternalEditor({ task: second, mode: 'edit', sessionDirPath: sessionDir });

    expect(planEditorStore.get().tasks).toHaveLength(2);
    expect(planEditorStore.get().tasks[1]?.title).toBe('Updated second');
    expect(planEditorStore.get().saveError).toBeNull();
  });

  it('rejects multiple tasks in edit mode', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'two-tasks');

    openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });

    expect(planEditorStore.get().saveError).toContain('expects exactly 1 task');
  });

  it('brackets the editor spawn with terminal handover and resumes stdin', () => {
    const task = makeTask({
      id: 'T001',
      title: 'Original',
      implementationSteps: ['step'],
      tests: ['test'],
    });
    planEditorStore.initEditor([task]);

    const stdinCalls: string[] = [];
    const sourceStdin = Object.assign(new PassThrough(), {
      pause(): NodeJS.ReadStream {
        stdinCalls.push('pause');
        return sourceStdin as unknown as NodeJS.ReadStream;
      },
      resume(): NodeJS.ReadStream {
        stdinCalls.push('resume');
        return sourceStdin as unknown as NodeJS.ReadStream;
      },
    });
    setActiveTerminalHandover({
      fullscreen: true,
      mouse: true,
      sourceStdin: sourceStdin as unknown as NodeJS.ReadStream,
    });

    const written: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      openExternalEditor({ task, mode: 'edit', sessionDirPath: sessionDir });
    } finally {
      process.stdout.write = originalWrite;
    }

    const exitIndex = written.indexOf(terminalSequences.exitAltBuffer);
    const enterIndex = written.indexOf(terminalSequences.enterAltBuffer);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(enterIndex).toBeGreaterThan(exitIndex);
    expect(stdinCalls).toEqual(['pause', 'resume']);
  });
});

describe('openExternalEditor split mode', () => {
  it('writes split instructions before opening the editor', async () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'append-marker');

    openExternalEditor({ task, mode: 'split', sessionDirPath: sessionDir });

    const leftovers = await readdir(sessionDir);
    expect(leftovers).not.toContain(`split-${task.id}.md`);
    expect(planEditorStore.get().saveError).toBeNull();
  });

  it('instructs that each new split task needs its own frontmatter block', async () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    const capturePath = join(sessionDir, 'captured-input.md');
    vi.stubEnv('FAKE_EDITOR_MODE', 'capture-input');
    vi.stubEnv('FAKE_EDITOR_CAPTURE_PATH', capturePath);

    openExternalEditor({ task, mode: 'split', sessionDirPath: sessionDir });

    const received = await readFile(capturePath, 'utf-8');
    expect(received).toContain('Each new task needs its own');
    expect(received).toContain('--- id/title/action/file ---');
  });

  it('surfaces split parse failures', () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'invalid-parse');

    openExternalEditor({ task, mode: 'split', sessionDirPath: sessionDir });

    expect(planEditorStore.get().saveError).not.toBeNull();
  });

  it('replaces the edited task with the split tasks merged into the full plan', async () => {
    const task = makeTask({
      id: 'T001',
      title: 'Original',
      implementationSteps: ['step'],
      tests: ['test'],
    });
    planEditorStore.initEditor([task]);
    vi.stubEnv('FAKE_EDITOR_MODE', 'two-tasks');
    vi.stubEnv('FAKE_EDITOR_CONTENT', makeValidTaskMarkdown('T001', 'First half'));
    vi.stubEnv('FAKE_EDITOR_CONTENT_2', makeValidTaskMarkdown('T002', 'Second half'));

    openExternalEditor({ task, mode: 'split', sessionDirPath: sessionDir });

    const tasks = planEditorStore.get().tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.title)).toEqual(['First half', 'Second half']);
    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);
    expect(planEditorStore.get().saveError).toBeNull();
    const leftovers = await readdir(sessionDir);
    expect(leftovers).not.toContain(`split-${task.id}.md`);
  });
});
