import { linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { readSessionFileConfined } from '../../core/sessions/confinement.js';
import { TASKS_FILE } from '../../core/paths.js';
import { readSpecFile, type SpecFileRef } from '../../core/paths-io.js';
import type { EditorLayout } from '../../core/editor/editor-state.js';
import { visualPositionOf, wrapVisualLines } from '../../core/editor/grapheme-motions.js';
import type { Task } from '../../core/schemas/task.js';
import { briefFieldList, readField } from '../../features/editor/brief-field-model.js';
import { BriefFieldEditor } from '../../features/editor/brief-field-editor.js';
import { reviewStore } from '../workflow/review.js';
import { editorStore } from './editor.js';

const CTRL_S = '\x13';
const BACKSPACE = '\x08';
const LAYOUT: EditorLayout = { columns: 80, rows: 24 };

function validTask(overrides: Parameters<typeof makeTask>[0] = {}): Task {
  return makeTask({
    id: 'T001',
    title: 'Add greeting helper',
    action: 'create',
    file: 'src/greet.ts',
    description: 'Add a helper that returns a friendly greeting string.',
    signature: 'export function greet(name: string): string',
    pattern: 'follow the existing helper shape',
    tests: ['returns hello for an empty name', 'includes the provided name'],
    constraints: ['pure function', 'no external dependencies'],
    typeDefs: 'export type Greeting = string;',
    implementationSteps: ['define the greet function', 'export it from the module'],
    escalation: ['stop if the greeting format is ambiguous'],
    evidence: ['npm test passes', 'greet added'],
    scope: { inBounds: ['only greet'], outOfBounds: ['do not touch the barrel'] },
    ...overrides,
  });
}

const tempDirs: string[] = [];
const unmounts: Array<() => void> = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diptych-editor-')));
  tempDirs.push(dir);
  return dir;
}

function renderEditor(props: {
  tasks: Task[];
  taskIndex: number;
  sessionRef: SpecFileRef;
  resolve: (result: ApprovalReviewResult) => void;
  height?: number;
}): { stdin: { write: (data: string) => void } } {
  const instance = renderFeature(
    createElement(BriefFieldEditor, { ...props, height: props.height ?? LAYOUT.rows }),
  );
  unmounts.push(instance.unmount);
  return { stdin: instance.stdin };
}

beforeEach(() => {
  editorStore.reset();
  reviewStore.reset();
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  editorStore.reset();
  reviewStore.reset();
});

describe('editorStore ownership capture', () => {
  it('openRaw and openField capture the owner token at open time', () => {
    editorStore.openRaw({ filePath: 'spec.md', value: 'body', ownerToken: 7, layout: LAYOUT });
    const raw = editorStore.get();
    expect(raw.status).toBe('open');
    if (raw.status !== 'open') throw new Error('expected open');
    expect(raw.ownerToken).toBe(7);
    expect(raw.surface).toBe('raw');

    editorStore.openField({ filePath: 'tasks.md', value: 'body', ownerToken: 9, layout: LAYOUT });
    const field = editorStore.get();
    if (field.status !== 'open') throw new Error('expected open');
    expect(field.ownerToken).toBe(9);
    expect(field.surface).toBe('field');
  });
});

describe('editorStore scrollBy', () => {
  it('moves scrollTop by the delta and clamps at the top', () => {
    // 40 visual lines in a 24-row viewport → maxTop 16, so these nudges stay within bounds.
    const value = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    editorStore.openRaw({ filePath: 'spec.md', value, ownerToken: 1, layout: LAYOUT });
    expect(editorStore.get()).toMatchObject({ scrollTop: 0 });

    editorStore.scrollBy(3);
    expect(editorStore.get()).toMatchObject({ scrollTop: 3 });

    editorStore.scrollBy(-1);
    expect(editorStore.get()).toMatchObject({ scrollTop: 2 });

    editorStore.scrollBy(-5);
    expect(editorStore.get()).toMatchObject({ scrollTop: 0 });
  });

  it('clamps to the document bottom so over-scrolling down never dead-zones the way back up', () => {
    // 40 visual lines in a 5-row viewport → maxTop 35. Flicking far past the bottom must not
    // accumulate phantom offset above maxTop, or an equal count of wheel-up events would be eaten
    // before the view moves.
    const layout: EditorLayout = { columns: 80, rows: 5 };
    const value = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    editorStore.openRaw({ filePath: 'spec.md', value, ownerToken: 1, layout });

    editorStore.scrollBy(1000);
    expect(editorStore.get()).toMatchObject({ scrollTop: 35 });

    // A single wheel-up moves immediately — no dead-zone from the over-scroll.
    editorStore.scrollBy(-1);
    expect(editorStore.get()).toMatchObject({ scrollTop: 34 });
  });

  it('is a no-op while no session is open', () => {
    editorStore.scrollBy(4);
    expect(editorStore.get().status).toBe('closed');
  });
});

describe('editorStore field-save CAS write-gate', () => {
  it('is a no-op when the review owner token has advanced past the captured token', async () => {
    const sessionRef: SpecFileRef = { projectDir: tempDir(), sessionId: 's1' };
    const task = validTask();
    const captured = reviewStore.setReviewFile('spec.md');
    editorStore.openField({
      filePath: 'tasks.md',
      value: readField(task, briefFieldList(task)[0] ?? 'title'),
      ownerToken: captured,
      layout: LAYOUT,
    });

    // A newer prompt seizes ownership — the captured token is now stale.
    reviewStore.setReviewFile('plan.md');
    expect(reviewStore.get().ownerToken).not.toBe(captured);

    const resolved: ApprovalReviewResult[] = [];
    const { stdin } = renderEditor({
      tasks: [task],
      taskIndex: 0,
      sessionRef,
      resolve: (r) => resolved.push(r),
    });
    await tick(20);
    stdin.write(CTRL_S);
    await tick(20);

    // Stale save never resolves the prompt and never writes tasks.md.
    expect(resolved).toEqual([]);
    expect(editorStore.get().status).toBe('open');
    expect(readSpecFile(sessionRef, TASKS_FILE)).toBeNull();
  });

  it('suppresses edit input once the review owner token advances (suppression ≡ write-gate)', async () => {
    const sessionRef: SpecFileRef = { projectDir: tempDir(), sessionId: 's1' };
    const task = validTask();
    const captured = reviewStore.setReviewFile('spec.md');
    editorStore.openField({ filePath: null, value: 'hello', ownerToken: captured, layout: LAYOUT });
    editorStore.dispatch({ kind: 'set-cursor', index: 5 });

    // A newer prompt seizes ownership — the captured token is now stale, so the owner disconnected.
    reviewStore.setReviewFile('plan.md');
    expect(reviewStore.get().ownerToken).not.toBe(captured);

    const { stdin } = renderEditor({
      tasks: [task],
      taskIndex: 0,
      sessionRef,
      resolve: () => {},
    });
    await tick(20);

    // Input suppression keys on the same predicate as the write-gate (CON-B / REQ-043): a
    // destructive edit key is dropped, so the buffer is untouched after the owner disconnects —
    // the editor is not writable in-buffer, matching the Ctrl+S no-op above.
    stdin.write(BACKSPACE);
    await tick(20);
    expect(editorStore.get()).toMatchObject({ status: 'open', value: 'hello' });
  });

  it('delegates a fresh-token save through the existing settle (action edit), not a BRIEFS_READY skip', async () => {
    const sessionRef: SpecFileRef = { projectDir: tempDir(), sessionId: 's1' };
    const task = validTask();
    const first = briefFieldList(task)[0] ?? 'title';
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openField({
      filePath: 'tasks.md',
      value: readField(task, first),
      ownerToken: owner,
      layout: LAYOUT,
    });

    const resolved: ApprovalReviewResult[] = [];
    const { stdin } = renderEditor({
      tasks: [task],
      taskIndex: 0,
      sessionRef,
      resolve: (r) => resolved.push(r),
    });
    await tick(20);
    stdin.write(CTRL_S);
    await tick(20);

    expect(resolved).toEqual([{ approved: false, action: 'edit' }]);
    expect(editorStore.get().status).toBe('closed');
    expect(readSpecFile(sessionRef, TASKS_FILE)).not.toBeNull();
  });
});

describe('editorStore submit gate', () => {
  it('blocks a destructive delete event once beginSubmit is in flight', async () => {
    const sessionRef: SpecFileRef = { projectDir: tempDir(), sessionId: 's1' };
    const task = validTask();
    const first = briefFieldList(task)[0] ?? 'title';
    const seeded = readField(task, first);
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openField({ filePath: null, value: seeded, ownerToken: owner, layout: LAYOUT });

    const { stdin } = renderEditor({
      tasks: [task],
      taskIndex: 0,
      sessionRef,
      resolve: () => {},
    });
    await tick(20);

    // The editor re-seeds the first field from the task on mount (resetting the cursor to 0), so
    // place the caret at the buffer end before exercising the backward-delete key path.
    editorStore.dispatch({ kind: 'set-cursor', index: seeded.length });

    // Control: while not submitting, backspace deletes one grapheme through the same key path.
    stdin.write(BACKSPACE);
    await tick(20);
    expect(editorStore.get()).toMatchObject({ value: seeded.slice(0, -1) });

    // In flight: destructive keys are disabled, so the delete is dropped.
    editorStore.beginSubmit();
    stdin.write(BACKSPACE);
    await tick(20);
    expect(editorStore.get()).toMatchObject({ value: seeded.slice(0, -1), submitting: true });
  });
});

describe('editorStore wheel scroll origin after keyboard navigation (REQ-030)', () => {
  it('syncs scrollTop on caret motion so scrollBy nudges from what is displayed, not a stale origin', () => {
    const layout: EditorLayout = { columns: 4, rows: 3 };
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openRaw({ filePath: 'spec.md', value: 'a'.repeat(40), ownerToken: owner, layout });

    editorStore.dispatch({ kind: 'motion', motion: 'doc-end', select: false });
    const afterMotion = editorStore.get();
    if (afterMotion.status !== 'open') throw new Error('expected open');
    expect(afterMotion.scrollTop).toBeGreaterThan(0);

    const origin = afterMotion.scrollTop;
    editorStore.scrollBy(-1);
    const scrolled = editorStore.get();
    if (scrolled.status !== 'open') throw new Error('expected open');
    expect(scrolled.scrollTop).toBe(origin - 1);
  });
});

describe('editorStore setLayout re-follows the caret after reflow (REQ-033 / REQ-029)', () => {
  it('keeps the caret in the visible window when a narrower width re-wraps it lower', () => {
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openRaw({
      filePath: 'spec.md',
      value: 'a'.repeat(40),
      ownerToken: owner,
      layout: { columns: 10, rows: 3 },
    });

    // Send the caret to the document end; caret-follow scrolls the window down to it.
    editorStore.dispatch({ kind: 'motion', motion: 'doc-end', select: false });
    const wide = editorStore.get();
    if (wide.status !== 'open') throw new Error('expected open');
    expect(wide.scrollTop).toBeGreaterThan(0);

    // A SIGWINCH narrows the terminal: the same buffer re-wraps taller, pushing the caret's visual
    // row well below the stale scroll window. Without re-following, scrollTop stays put and the
    // caret falls outside [scrollTop, scrollTop + rows) — unpainted until the next keystroke.
    editorStore.setLayout({ columns: 4, rows: 3 });
    const narrow = editorStore.get();
    if (narrow.status !== 'open') throw new Error('expected open');

    const lines = wrapVisualLines(narrow.value, narrow.layout.columns);
    const { row } = visualPositionOf(lines, narrow.cursor);
    expect(row).toBeGreaterThanOrEqual(narrow.scrollTop);
    expect(row).toBeLessThan(narrow.scrollTop + narrow.layout.rows);
  });
});

describe('confined session read at the editor boundary', () => {
  it('reads a plain in-session file', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'tasks.md'), 'ok');
    await expect(readSessionFileConfined(dir, join(dir, 'tasks.md'))).resolves.toBe('ok');
  });

  it('rejects a symlinked target', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'target.md'), 'secret');
    symlinkSync(join(dir, 'target.md'), join(dir, 'link.md'));
    await expect(readSessionFileConfined(dir, join(dir, 'link.md'))).rejects.toThrow(/symlink/i);
  });

  it('rejects a hardlinked target', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'target.md'), 'secret');
    linkSync(join(dir, 'target.md'), join(dir, 'hard.md'));
    await expect(readSessionFileConfined(dir, join(dir, 'hard.md'))).rejects.toThrow(/hardlink/i);
  });

  it('rejects a path that escapes the session root', async () => {
    const dir = tempDir();
    await expect(readSessionFileConfined(dir, '../escape.md')).rejects.toThrow(/escape/i);
  });
});
