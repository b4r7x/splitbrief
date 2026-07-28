import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Box } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { ApprovalReviewResult } from '../../../src/core/approval/types.js';
import type { EditorLayout } from '../../../src/core/editor/editor-state.js';
import { TASKS_FILE } from '../../../src/core/paths.js';
import { readSpecFile, type SpecFileRef } from '../../../src/core/paths-io.js';
import type { Task } from '../../../src/core/schemas/task.js';
import { parseTasksStrict } from '../../../src/engine/spec/tasks/parse.js';
import { briefFieldList, readField } from '../../../src/features/editor/brief-field-model.js';
import { BriefFieldEditor } from '../../../src/features/editor/brief-field-editor.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { externalEditRequestStore } from '../../../src/stores/ui/external-edit-request.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';

const CTRL_S = '\x13';
const CTRL_O = '\x0f';
const TAB = '\t';
const BACKSPACE = '\x08';
const LAYOUT = { columns: 40, rows: 6 };
const STORE_LAYOUT: EditorLayout = { columns: 80, rows: 24 };
const SESSION_REF = { projectDir: '/tmp', sessionId: 's1' };

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

function view() {
  return createElement(BriefFieldEditor, {
    tasks: [makeTask({ id: 'T001', title: 'Create hello module' })],
    taskIndex: 0,
    sessionRef: SESSION_REF,
    resolve: () => {},
    height: 6,
  });
}

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'splitbrief-editor-')));
  tempDirs.push(dir);
  return dir;
}

const tempDirs: string[] = [];

describe('BriefFieldEditor mount ownership', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    editorStore.close();
    reviewStore.clearReview();
  });

  it('renders the field while the session token still owns the live prompt', async () => {
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({
      filePath: '/tmp/TASKS.md',
      value: 'Create hello module',
      ownerToken: token,
      layout: LAYOUT,
    });

    const ui = renderFeature(view());
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('T001');
  });

  it('seeds the buffer from the focused Task when the trigger opens an empty field session', async () => {
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({ filePath: null, value: '', ownerToken: token, layout: LAYOUT });

    const ui = renderFeature(view());
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('Create hello module');
    expect(editorStore.get()).toMatchObject({ status: 'open', value: 'Create hello module' });
  });

  it('renders nothing once the review token advances past the session token', async () => {
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({
      filePath: '/tmp/TASKS.md',
      value: 'Create hello module',
      ownerToken: token,
      layout: LAYOUT,
    });

    const ui = renderFeature(view());
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('T001');

    reviewStore.setReviewFile('/tmp/TASKS.md');
    await tick();
    expect(ui.lastFrame()).not.toContain('T001');
    expect(editorStore.get().status).toBe('open');
  });
});

describe('BriefFieldEditor multi-field editing and save gate', () => {
  let unmount: (() => void) | undefined;
  const sessionTempDirs: string[] = [];

  function tempSessionRef(): SpecFileRef {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'splitbrief-brief-field-')));
    sessionTempDirs.push(dir);
    return { projectDir: dir, sessionId: 's1' };
  }

  function open(task: Task, sessionRef: SpecFileRef, resolved: ApprovalReviewResult[], height = 6) {
    const first = briefFieldList(task)[0] ?? 'title';
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openField({
      filePath: 'tasks.md',
      value: readField(task, first),
      ownerToken: owner,
      layout: LAYOUT,
    });
    const ui = renderFeature(
      createElement(BriefFieldEditor, {
        tasks: [task],
        taskIndex: 0,
        sessionRef,
        resolve: (r) => resolved.push(r),
        height,
      }),
    );
    unmount = ui.unmount;
    return ui;
  }

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    for (const dir of sessionTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    editorStore.close();
    externalEditRequestStore.reset();
    reviewStore.clearReview();
  });

  it('discards the in-progress field edit on Ctrl+O and emits the external-edit intent (REQ-142/150)', async () => {
    const sessionRef = tempSessionRef();
    const task = validTask();
    const resolved: ApprovalReviewResult[] = [];
    const ui = open(task, sessionRef, resolved);
    await tick(20);

    const owner = reviewStore.get().ownerToken;

    ui.stdin.write('Z');
    await tick(20);

    ui.stdin.write(CTRL_O);
    await tick(20);

    expect(readSpecFile(sessionRef, TASKS_FILE)).toBeNull();
    expect(resolved).toEqual([]);
    expect(editorStore.get().status).toBe('closed');
    expect(externalEditRequestStore.get()).toEqual({ status: 'requested', ownerToken: owner });
  });

  it('accumulates edits from multiple fields into the written tasks.md when Tab moves between them', async () => {
    const sessionRef = tempSessionRef();
    const task = validTask();
    const resolved: ApprovalReviewResult[] = [];
    const ui = open(task, sessionRef, resolved);
    await tick(20);

    ui.stdin.write('Z');
    await tick(20);

    ui.stdin.write(TAB);
    await tick(20);
    ui.stdin.write('Q');
    await tick(20);

    ui.stdin.write(CTRL_S);
    await tick(20);

    expect(resolved).toEqual([{ approved: false, action: 'edit' }]);
    expect(editorStore.get().status).toBe('closed');
    const written = readSpecFile(sessionRef, TASKS_FILE);
    expect(written).not.toBeNull();
    const parsed = parseTasksStrict(written ?? '');
    expect(parsed[0]?.title).toBe('ZAdd greeting helper');
    expect(parsed[0]?.file).toBe('Qsrc/greet.ts');
  });

  it('keeps its whole surface within the region height so the decision controls stay visible (CON-D)', async () => {
    const sessionRef = tempSessionRef();
    const tallTitle = Array.from({ length: 15 }, (_, i) => `row ${i}`).join('\n');
    const task = validTask({ title: tallTitle });
    const ui = open(task, sessionRef, [], 8);
    await tick(20);

    const lines = (ui.lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(ui.lastFrame()).toContain('ctrl+s save');
  });

  it('rejects a save that fails the brief gate: surfaces the first error, does not write or resolve, keeps the session open', async () => {
    const sessionRef = tempSessionRef();
    const task = validTask({ tests: ['works'] });
    const resolved: ApprovalReviewResult[] = [];
    const ui = open(task, sessionRef, resolved);
    await tick(20);

    ui.stdin.write(CTRL_S);
    await tick(20);

    expect(ui.lastFrame()).toContain('vague');
    expect(resolved).toEqual([]);
    expect(editorStore.get().status).toBe('open');
    expect(readSpecFile(sessionRef, TASKS_FILE)).toBeNull();
  });
});

describe('BriefFieldEditor footer stays one controls row (F-201)', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    editorStore.close();
    reviewStore.clearReview();
  });

  function renderAtWidth(task: Task, width: number, height = 8) {
    const owner = reviewStore.setReviewFile('spec.md');
    const first = briefFieldList(task)[0] ?? 'title';
    editorStore.openField({
      filePath: 'tasks.md',
      value: readField(task, first),
      ownerToken: owner,
      layout: LAYOUT,
    });
    const ui = renderFeature(
      createElement(
        Box,
        { width, overflow: 'hidden' },
        createElement(BriefFieldEditor, {
          tasks: [task],
          taskIndex: 0,
          sessionRef: SESSION_REF,
          resolve: () => {},
          height,
        }),
      ),
    );
    unmount = ui.unmount;
    return ui;
  }

  function footerRowCount(frame: string | undefined): number {
    return (frame ?? '').split('\n').filter((line) => /tab field|esc cancel/.test(line)).length;
  }

  it('keeps the controls hint on one row at a narrow inner width with a full field and save error', async () => {
    const task = validTask({ title: 'x'.repeat(300), tests: ['works'] });
    const ui = renderAtWidth(task, 54, 8);
    await tick(20);

    ui.stdin.write(CTRL_S);
    await tick(20);

    const frame = ui.lastFrame();
    expect(frame).toContain('tab field');
    expect(frame).toMatch(/vague|round-trip/);
    expect(footerRowCount(frame)).toBe(1);
    const lineCount = (frame ?? '').split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(8);
  });

  it('negative control: at a wide inner width the same hint already fits one row', async () => {
    const task = validTask({ tests: ['works'] });
    const ui = renderAtWidth(task, 120, 8);
    await tick(20);

    ui.stdin.write(CTRL_S);
    await tick(20);

    const frame = ui.lastFrame();
    expect(frame).toContain('esc cancel');
    expect(footerRowCount(frame)).toBe(1);
  });
});

describe('BriefFieldEditor field-save CAS write-gate', () => {
  const unmounts: Array<() => void> = [];

  function renderEditor(props: {
    tasks: Task[];
    taskIndex: number;
    sessionRef: SpecFileRef;
    resolve: (result: ApprovalReviewResult) => void;
    height?: number;
  }): { stdin: { write: (data: string) => void } } {
    const instance = renderFeature(
      createElement(BriefFieldEditor, { ...props, height: props.height ?? STORE_LAYOUT.rows }),
    );
    unmounts.push(instance.unmount);
    return { stdin: instance.stdin };
  }

  afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    editorStore.reset();
    reviewStore.reset();
  });

  it('is a no-op when the review owner token has advanced past the captured token', async () => {
    const sessionRef: SpecFileRef = { projectDir: tempDir(), sessionId: 's1' };
    const task = validTask();
    const captured = reviewStore.setReviewFile('spec.md');
    editorStore.openField({
      filePath: 'tasks.md',
      value: readField(task, briefFieldList(task)[0] ?? 'title'),
      ownerToken: captured,
      layout: STORE_LAYOUT,
    });

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

    expect(resolved).toEqual([]);
    expect(editorStore.get().status).toBe('open');
    expect(readSpecFile(sessionRef, TASKS_FILE)).toBeNull();
  });

  it('suppresses edit input once the review owner token advances (suppression ≡ write-gate)', async () => {
    const sessionRef: SpecFileRef = { projectDir: tempDir(), sessionId: 's1' };
    const task = validTask();
    const captured = reviewStore.setReviewFile('spec.md');
    editorStore.openField({
      filePath: null,
      value: 'hello',
      ownerToken: captured,
      layout: STORE_LAYOUT,
    });
    editorStore.dispatch({ kind: 'set-cursor', index: 5 });

    reviewStore.setReviewFile('plan.md');
    expect(reviewStore.get().ownerToken).not.toBe(captured);

    const { stdin } = renderEditor({
      tasks: [task],
      taskIndex: 0,
      sessionRef,
      resolve: () => {},
    });
    await tick(20);

    stdin.write(BACKSPACE);
    await tick(20);
    expect(editorStore.get()).toMatchObject({ status: 'open', value: 'hello' });
  });
});

describe('BriefFieldEditor submit gate', () => {
  const unmounts: Array<() => void> = [];

  function renderEditor(props: {
    tasks: Task[];
    taskIndex: number;
    sessionRef: SpecFileRef;
    resolve: (result: ApprovalReviewResult) => void;
  }): { stdin: { write: (data: string) => void } } {
    const instance = renderFeature(
      createElement(BriefFieldEditor, { ...props, height: STORE_LAYOUT.rows }),
    );
    unmounts.push(instance.unmount);
    return { stdin: instance.stdin };
  }

  afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    editorStore.reset();
    reviewStore.reset();
  });

  it('blocks a destructive delete event once beginSubmit is in flight', async () => {
    const sessionRef: SpecFileRef = { projectDir: tempDir(), sessionId: 's1' };
    const task = validTask();
    const first = briefFieldList(task)[0] ?? 'title';
    const seeded = readField(task, first);
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openField({
      filePath: null,
      value: seeded,
      ownerToken: owner,
      layout: STORE_LAYOUT,
    });

    const { stdin } = renderEditor({
      tasks: [task],
      taskIndex: 0,
      sessionRef,
      resolve: () => {},
    });
    await tick(20);

    editorStore.dispatch({ kind: 'set-cursor', index: seeded.length });

    stdin.write(BACKSPACE);
    await tick(20);
    expect(editorStore.get()).toMatchObject({ value: seeded.slice(0, -1) });

    editorStore.beginSubmit();
    stdin.write(BACKSPACE);
    await tick(20);
    expect(editorStore.get()).toMatchObject({ value: seeded.slice(0, -1), submitting: true });
  });
});
