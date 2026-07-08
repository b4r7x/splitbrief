import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { SPEC_FILE } from '../../core/paths.js';
import { readSpecFile } from '../../core/paths-io.js';
import type { EditorLayout } from '../../core/editor/editor-state.js';
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

const tempDirs: string[] = [];
const unmounts: Array<() => void> = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diptych-raw-editor-')));
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
    await tick(20);
    stdin.write(CTRL_S);
    await tick(20);

    // Stale save never writes the captured file and never reloads the review buffer.
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, SPEC_FILE)).toBeNull();
    expect(reviewStore.get().revision).toBe(0);
  });

  it('writes the captured session file and reloads the review buffer on a fresh-token save', async () => {
    const projectDir = tempDir();
    configStore.__testReset({ projectDir });
    const filePath = join(projectDir, SESSION_ID, SPEC_FILE);
    const owner = reviewStore.setReviewFile(filePath);
    editorStore.openRaw({
      filePath,
      value: 'fresh edited body',
      ownerToken: owner,
      layout: LAYOUT,
    });
    overlayStore.open('editor');

    const { stdin } = renderOverlay();
    await tick(20);
    stdin.write(CTRL_S);
    await tick(20);

    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, SPEC_FILE)).toBe(
      'fresh edited body',
    );
    expect(reviewStore.get().revision).toBe(1);
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
    await tick(20);
    stdin.write(CTRL_O);
    await tick(20);

    // Fresh token: the buffer is persisted to the file the parser reads and the intent is emitted.
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, SPEC_FILE)).toBe(
      'external edited body',
    );
    const request = externalEditRequestStore.get();
    expect(request).toEqual({ status: 'requested', ownerToken: owner });
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
    await tick(20);
    stdin.write(CTRL_O);
    await tick(20);

    // Stale token: the pre-save CAS gates the write, but the neutral intent still fires.
    expect(readSpecFile({ projectDir, sessionId: SESSION_ID }, SPEC_FILE)).toBeNull();
    const request = externalEditRequestStore.get();
    expect(request).toEqual({ status: 'requested', ownerToken: captured });
  });
});

describe('raw editor overlay frame layout (REQ-122/123/124/125)', () => {
  const FOOTER = 'Ctrl+S save';

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
    // The painted frame occupies exactly `rows` lines — no reserve≠render gap (REQ-122).
    expect(lines).toHaveLength(24);
    // Footer sits on the last interior row (rows-2); only the bottom border is beneath it (REQ-123).
    expect(lines[22]).toContain(FOOTER);
    expect(lines[21]).not.toContain(FOOTER);
    // No blank band beneath the footer: the final line is the border row, not empty space (REQ-124).
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

  it('recomputes the viewport, wrap width, and caret layout when the terminal resizes mid-session (REQ-125)', async () => {
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
    // re-wraps and re-places the caret against the new layout (REQ-125).
    expect(editorStore.get()).toMatchObject({ layout: { columns: 95, rows: 25 } });
  });
});
