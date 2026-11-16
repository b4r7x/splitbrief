import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushEffects,
  type RenderFeatureResult,
  renderFeature,
  tick,
} from '#testing/helpers/ink.js';
import { PLAN_JSON_FILE, SPEC_FILE } from '../../core/paths.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import type { PlanProposal } from '../../core/schemas/plan.js';
import { readSpecFile } from '../../core/sessions/spec-files.js';
import type { EditorLayout } from '../../core/editor/types.js';
import { configStore } from '../../stores/project/config.js';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { externalEditRequestStore } from '../../stores/ui/external-edit-request.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { EditorOverlay } from './editor.js';

const CTRL_S = '\x13';
const CTRL_O = '\x0f';
const LAYOUT: EditorLayout = { columns: 80, rows: 24 };
const SESSION_ID = 's1';
const FOOTER = 'ctrl+s save';
const MISSING_CONTEXT_FILE = 'src/features/workflow/run-requests/end-run.test.ts';

/** The reason rows above the key legend, as one text with the frame borders and the spaces out. */
function reasonText(frame: string): string {
  const lines = frame.split('\n');
  const first = lines.findIndex((line) => line.includes('Not saved:'));
  const legend = lines.findIndex((line) => line.includes(FOOTER));
  return lines
    .slice(first, legend)
    .join('')
    .replace(/[│|\s]/gu, '');
}

const tempDirs: string[] = [];
const unmounts: Array<() => void> = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'splitbrief-raw-editor-')));
  tempDirs.push(dir);
  return dir;
}

function renderOverlay(): {
  stdin: { write: (data: string) => void };
  lastFrame: () => string | undefined;
} {
  const instance = renderFeature(createElement(EditorOverlay));
  unmounts.push(instance.unmount);
  return { stdin: instance.stdin, lastFrame: instance.lastFrame };
}

beforeEach(() => {
  editorStore.reset();
  reviewStore.reset();
  overlayStore.reset();
  externalEditRequestStore.reset();
  terminalSizeStore.__testReset();
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  editorStore.reset();
  reviewStore.reset();
  overlayStore.reset();
  externalEditRequestStore.reset();
  terminalSizeStore.__testReset();
  configStore.__testReset();
});

describe('raw editor overlay CAS write-gate', () => {
  it('is a no-op when the review owner token has advanced past the captured token', async () => {
    const projectDir = tempDir();
    configStore.__testReset({ projectDir });
    const captured = reviewStore.setReviewFile(join(projectDir, SESSION_ID, 'plan.md'));
    editorStore.openRaw({
      filePath: join(projectDir, SESSION_ID, PLAN_JSON_FILE),
      value: JSON.stringify(makePlanProposal()),
      ownerToken: captured,
      layout: LAYOUT,
    });
    overlayStore.open('editor');

    // A newer prompt seizes ownership — the captured token is now stale.
    reviewStore.setReviewFile(join(projectDir, SESSION_ID, 'plan.md'));
    expect(reviewStore.get().ownerToken).not.toBe(captured);

    const { stdin } = renderOverlay();
    await flushEffects();
    stdin.write(CTRL_S);
    await tick(20);

    // Stale save never writes the captured file and never asks the card to apply it.
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, PLAN_JSON_FILE)).toBeNull();
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
  });
});

describe('raw editor overlay plan.json save', () => {
  function openPlanJson(value: string): { projectDir: string; owner: number } {
    const projectDir = tempDir();
    configStore.__testReset({ projectDir });
    const owner = reviewStore.setReviewFile(join(projectDir, SESSION_ID, 'plan.md'));
    editorStore.openRaw({
      filePath: join(projectDir, SESSION_ID, PLAN_JSON_FILE),
      value,
      ownerToken: owner,
      layout: LAYOUT,
    });
    overlayStore.open('editor');
    return { projectDir, owner };
  }

  it('refuses a plan that fails its checks and stays open with the reason', async () => {
    const plan = makePlanProposal({
      criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: [] }],
    });
    const { projectDir } = openPlanJson(JSON.stringify(plan));

    const { stdin, lastFrame } = renderOverlay();
    await flushEffects();
    stdin.write(CTRL_S);
    await tick(20);

    expect(lastFrame()).toContain('Not saved: Criterion C1 names no check that verifies it.');
    expect(lastFrame()).not.toContain('criterion-without-check');
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, PLAN_JSON_FILE)).toBeNull();
    expect(overlayStore.get().active).toBe('editor');
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
  });

  it('refuses text that is not JSON', async () => {
    openPlanJson('{ not json');

    const { stdin, lastFrame } = renderOverlay();
    await flushEffects();
    stdin.write(CTRL_S);
    await tick(20);

    expect(lastFrame()).toContain('Not saved: plan.json is not valid JSON');
    expect(overlayStore.get().active).toBe('editor');
  });

  it('gives a long reason the rows it needs, with the whole path, at 80x24', async () => {
    const plan = makePlanProposal({
      tasks: [makeTaskSpec({ contextFiles: [MISSING_CONTEXT_FILE] })],
    });
    openPlanJson(JSON.stringify(plan));
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });

    const { stdin, lastFrame } = renderOverlay();
    await flushEffects();
    stdin.write(CTRL_S);
    await tick(20);

    expect(reasonText(lastFrame() ?? ''), lastFrame()).toBe(
      `Notsaved:TaskT001reads${MISSING_CONTEXT_FILE},whichdoesnotexistandneitherthistasknoranearlieronewrites.`,
    );
    expect(overlayStore.get().active).toBe('editor');
  });

  it('writes a valid plan and asks the review prompt to apply the edit', async () => {
    const text = JSON.stringify(makePlanProposal(), null, 2);
    const { projectDir, owner } = openPlanJson(text);

    const { stdin } = renderOverlay();
    await flushEffects();
    stdin.write(CTRL_S);
    await tick(20);

    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, PLAN_JSON_FILE)).toBe(text);
    expect(externalEditRequestStore.get()).toEqual({
      status: 'requested',
      ownerToken: owner,
      action: 'apply-edit',
    });
    expect(editorStore.get().status).toBe('closed');
    expect(overlayStore.get().active).toBe('none');
  });
});

describe('raw editor overlay Ctrl+O external escape hatch', () => {
  it('pre-saves the buffer on a fresh token and emits the external-edit request', async () => {
    const projectDir = tempDir();
    configStore.__testReset({ projectDir });
    const filePath = join(projectDir, SESSION_ID, SPEC_FILE);
    const owner = reviewStore.setReviewFile(filePath);
    editorStore.openRaw({
      filePath,
      value: 'external edited body',
      ownerToken: owner,
      layout: LAYOUT,
    });
    overlayStore.open('editor');

    const { stdin } = renderOverlay();
    await flushEffects();
    stdin.write(CTRL_O);
    await tick(20);

    // Fresh token: the buffer is persisted to the file the parser reads and the intent is emitted.
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, SPEC_FILE)).toBe(
      'external edited body',
    );
    const request = externalEditRequestStore.get();
    expect(request).toEqual({
      status: 'requested',
      ownerToken: owner,
      action: 'open-external',
      baseline: 'external edited body',
    });
    expect(editorStore.get().status).toBe('closed');
    expect(overlayStore.get().active).toBe('none');
  });

  it('writes nothing on a stale token but still emits the external-edit request', async () => {
    const projectDir = tempDir();
    configStore.__testReset({ projectDir });
    const filePath = join(projectDir, SESSION_ID, SPEC_FILE);
    const captured = reviewStore.setReviewFile(filePath);
    editorStore.openRaw({
      filePath,
      value: 'stale edited body',
      ownerToken: captured,
      layout: LAYOUT,
    });
    overlayStore.open('editor');

    // A newer prompt seizes ownership — the captured token is now stale.
    reviewStore.setReviewFile(join(projectDir, SESSION_ID, 'plan.md'));
    expect(reviewStore.get().ownerToken).not.toBe(captured);

    const { stdin } = renderOverlay();
    await flushEffects();
    stdin.write(CTRL_O);
    await tick(20);

    // Stale token: the pre-save CAS gates the write, but the neutral intent still fires.
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, SPEC_FILE)).toBeNull();
    const request = externalEditRequestStore.get();
    expect(request).toEqual({
      status: 'requested',
      ownerToken: captured,
      action: 'open-external',
      baseline: 'stale edited body',
    });
  });
});

describe('raw editor overlay after the project folder moved away', () => {
  const CONTEXT_FILE = 'src/greeting/format.ts';

  /** Opens the editor on `plan` in a project that holds `CONTEXT_FILE` and an npm test script, then moves the project. */
  async function movedProjectEditor(
    plan: PlanProposal,
    viewport: { cols: number; rows: number },
  ): Promise<{ projectDir: string; instance: RenderFeatureResult }> {
    const parent = tempDir();
    const projectDir = join(parent, 'project');
    mkdirSync(join(projectDir, 'src', 'greeting'), { recursive: true });
    writeFileSync(join(projectDir, CONTEXT_FILE), 'export const format = 1;\n');
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } }),
    );
    configStore.__testReset({ projectDir });
    editorStore.openRaw({
      filePath: join(projectDir, SESSION_ID, PLAN_JSON_FILE),
      value: JSON.stringify(plan, null, 2),
      ownerToken: reviewStore.setReviewFile(join(projectDir, SESSION_ID, 'plan.md')),
      layout: LAYOUT,
    });
    overlayStore.open('editor');
    terminalSizeStore.__testReset(viewport);
    const instance = renderFeature(createElement(EditorOverlay), viewport);
    unmounts.push(instance.unmount);
    await flushEffects();
    renameSync(projectDir, join(parent, 'moved'));
    return { projectDir, instance };
  }

  function expectEditorKept(projectDir: string): void {
    expect(overlayStore.get().active).toBe('editor');
    expect(editorStore.get().status).toBe('open');
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
    expect(existsSync(projectDir)).toBe(false);
  }

  it.each([
    ['Ctrl+S', CTRL_S],
    ['Ctrl+O', CTRL_O],
  ])('keeps the editor open on %s and says that the project folder is gone', async (_name, key) => {
    // The frame is wide enough for the whole sentence with the folder on one row.
    const { projectDir, instance } = await movedProjectEditor(makePlanProposal(), {
      cols: 400,
      rows: 24,
    });

    instance.stdin.write(key);

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain(`Not saved: the project folder ${projectDir} is gone`);
    });
    expectEditorKept(projectDir);
  });

  it.each([
    ['Ctrl+S', CTRL_S],
    ['Ctrl+O', CTRL_O],
  ])('ends the reason on %s with "is gone" at 60x18', async (_name, key) => {
    const { projectDir, instance } = await movedProjectEditor(makePlanProposal(), {
      cols: 60,
      rows: 18,
    });

    instance.stdin.write(key);

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('Not saved:');
    });
    expect(reasonText(instance.lastFrame()), instance.lastFrame()).toMatch(
      /^Notsaved:theprojectfolder\/.*\/projectisgone$/u,
    );
    expectEditorKept(projectDir);
  });

  it.each([
    [
      'a task that reads a file of the project',
      makePlanProposal({ tasks: [makeTaskSpec({ contextFiles: [CONTEXT_FILE] })] }),
    ],
    [
      'an npm run check that package.json defines',
      makePlanProposal({
        tasks: [makeTaskSpec({ checks: [{ id: 'K1', kind: 'cmd', value: 'npm run test' }] })],
      }),
    ],
  ])('says on Ctrl+S that the project folder is gone for %s', async (_name, plan) => {
    const { projectDir, instance } = await movedProjectEditor(plan, { cols: 400, rows: 24 });

    instance.stdin.write(CTRL_S);

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('Not saved:');
    });
    expect(instance.lastFrame()).toContain(`Not saved: the project folder ${projectDir} is gone`);
    expectEditorKept(projectDir);
  });
});

describe('raw editor overlay frame layout', () => {
  function openEditor(projectDir: string): void {
    const filePath = join(projectDir, SESSION_ID, SPEC_FILE);
    const owner = reviewStore.setReviewFile(filePath);
    editorStore.openRaw({
      filePath,
      value: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
      ownerToken: owner,
      layout: LAYOUT,
    });
    overlayStore.open('editor');
  }

  it('fills the full terminal height with the footer on the final interior row at 80x24', async () => {
    const projectDir = tempDir();
    configStore.__testReset({ projectDir });
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    openEditor(projectDir);

    const { lastFrame } = renderOverlay();
    await tick(20);

    const lines = (lastFrame() ?? '').split('\n');
    // The painted frame occupies exactly `rows` lines — no reserve≠render gap.
    expect(lines).toHaveLength(24);
    // Footer sits on the last interior row (rows-2); only the bottom border is beneath it.
    expect(lines[22]).toContain(FOOTER);
    expect(lines[21]).not.toContain(FOOTER);
    // No blank band beneath the footer: the final line is the border row, not empty space.
    expect(lines[23]).not.toContain(FOOTER);
    expect(lines[23]?.trim()).not.toBe('');
  });

  it('keeps the frame full-height with the footer on the final interior row at a short 80x8', async () => {
    const projectDir = tempDir();
    configStore.__testReset({ projectDir });
    terminalSizeStore.__testReset({ cols: 80, rows: 8 });
    openEditor(projectDir);

    const { lastFrame } = renderOverlay();
    await tick(20);

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[6]).toContain(FOOTER);
    expect(lines[5]).not.toContain(FOOTER);
    expect(lines[7]?.trim()).not.toBe('');
  });

  it.each([
    [24, 16],
    [8, 1],
  ])(
    'keeps the frame full-height at 80x%i under a long reason (buffer rows: %i)',
    async (rows, bufferRows) => {
      const projectDir = tempDir();
      configStore.__testReset({ projectDir });
      terminalSizeStore.__testReset({ cols: 80, rows });
      editorStore.openRaw({
        filePath: join(projectDir, SESSION_ID, PLAN_JSON_FILE),
        value: JSON.stringify(
          makePlanProposal({ tasks: [makeTaskSpec({ contextFiles: [MISSING_CONTEXT_FILE] })] }),
        ),
        ownerToken: reviewStore.setReviewFile(join(projectDir, SESSION_ID, 'plan.md')),
        layout: LAYOUT,
      });
      overlayStore.open('editor');

      const { stdin, lastFrame } = renderOverlay();
      await flushEffects();
      stdin.write(CTRL_S);
      await tick(20);

      const lines = (lastFrame() ?? '').split('\n');
      expect(lastFrame()).toContain('Not saved: Task T001 reads');
      expect(lines, lastFrame()).toHaveLength(rows);
      expect(lines[rows - 2]).toContain(FOOTER);
      expect(lines[rows - 1]?.trim()).not.toBe('');
      expect(editorStore.get()).toMatchObject({ layout: { rows: bufferRows } });
    },
  );

  it('recomputes the viewport, wrap width, and caret layout when the terminal resizes mid-session', async () => {
    const projectDir = tempDir();
    configStore.__testReset({ projectDir });
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    openEditor(projectDir);

    const { lastFrame } = renderOverlay();
    await tick(20);

    expect((lastFrame() ?? '').split('\n')).toHaveLength(24);
    // columns = cols - OVERLAY_FRAME_COLS(4) - 1; rows = terminalRows - FRAME_ROWS(5).
    expect(editorStore.get()).toMatchObject({ layout: { columns: 75, rows: 19 } });

    terminalSizeStore.__testReset({ cols: 100, rows: 30 });
    await tick(20);

    const resized = (lastFrame() ?? '').split('\n');
    expect(resized).toHaveLength(30);
    expect(resized[28]).toContain(FOOTER);
    // Both the wrap width and the content viewport track the new terminal, so the buffer view
    // re-wraps and re-places the caret against the new layout.
    expect(editorStore.get()).toMatchObject({ layout: { columns: 95, rows: 25 } });
  });
});
