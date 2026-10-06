import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readSessionFileConfined } from '../../core/sessions/confinement.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir } from '../../core/paths.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { editorStore } from '../../stores/ui/editor.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { useWorkflowInlineEdit } from './hooks/workflow-screen/use-inline-edit.js';

const CTRL_E = '\x05';
const SESSION_ID = '2026-07-08-inline-trigger';

const inputMode: UseInputModeResult = {
  mode: 'review',
  hint: '',
  questionEpoch: 0,
  setReviewMode: async () => ({ approved: false }),
  setQuestionMode: async () => '',
  resolve: () => {},
  resetMode: () => {},
};

function Host() {
  useWorkflowInlineEdit({ promptPending: false, inputMode });
  return <Text>host</Text>;
}

function armReview(phase: Phase) {
  lifecycleStore.__testReset({ phase });
  controlsStore.setInputMode('review');
  overlayStore.close();
  terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
}

describe('Ctrl+E at a review gate', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    editorStore.close();
    overlayStore.close();
    reviewStore.clearReview();
    controlsStore.__testReset();
    lifecycleStore.__testReset();
    feedbackStore.reset();
  });

  it('opens plan.json, the file plan.md is rendered from, at the plan card', async () => {
    const projectDir = createTempDir('trigger-plan');
    try {
      ensureSessionDir(projectDir, SESSION_ID);
      const dir = sessionDir(projectDir, SESSION_ID);
      const planPath = join(dir, 'plan.md');
      writeFileSync(planPath, '# Plan\n', 'utf-8');
      writeFileSync(join(dir, 'plan.json'), '{"summary":"plan json body"}\n', 'utf-8');

      armReview('reviewing-plan');
      const token = reviewStore.setReviewFile(planPath);

      const ui = renderFeature(<Host />);
      unmount = ui.unmount;
      await flushEffects();

      ui.stdin.write(CTRL_E);
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('editor');
      });

      const state = editorStore.get();
      expect(state.status === 'open' ? state.filePath : null).toBe(join(dir, 'plan.json'));
      expect(state.status === 'open' ? state.ownerToken : null).toBe(token);
      expect(state.status === 'open' ? state.value : null).toContain('plan json body');
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('does nothing at an old briefs gate, which no live run opens', async () => {
    armReview('reviewing-briefs');
    reviewStore.setReviewFile('/tmp/tasks.md');

    const ui = renderFeature(<Host />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(CTRL_E);
    await tick();
    await tick();

    expect(editorStore.get().status).toBe('closed');
    expect(overlayStore.get().active).toBe('none');
  });

  it('does nothing at the plan card when no review file is set', async () => {
    armReview('reviewing-plan');
    reviewStore.setReviewFile(null);

    const ui = renderFeature(<Host />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(CTRL_E);
    // A tick past the keypress: the null-filePath guard returns before any confined read is
    // attempted, so the editor never opens AND no error surfaces (removing the guard would
    // instead drive an empty-path read that rejects into feedbackStore).
    await tick();
    await tick();

    expect(editorStore.get().status).toBe('closed');
    expect(overlayStore.get().active).toBe('none');
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('opens the raw editor at the plan card for the active review file', async () => {
    const projectDir = createTempDir('trigger-raw');
    try {
      ensureSessionDir(projectDir, SESSION_ID);
      const dir = sessionDir(projectDir, SESSION_ID);
      const planPath = join(dir, 'plan.json');
      writeFileSync(planPath, '# spec\n\ninline body\n', 'utf-8');

      armReview('reviewing-plan');
      const token = reviewStore.setReviewFile(planPath);

      const ui = renderFeature(<Host />);
      unmount = ui.unmount;
      await flushEffects();

      ui.stdin.write(CTRL_E);
      // The confined read is async; wait for the overlay to open once it resolves.
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('editor');
      });

      const state = editorStore.get();
      expect(state.status === 'open' ? state.ownerToken : null).toBe(token);
      expect(state.status === 'open' ? state.value : null).toContain('inline body');
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('aborts the raw open when the review token advances during the confined read', async () => {
    const projectDir = createTempDir('trigger-stale');
    try {
      ensureSessionDir(projectDir, SESSION_ID);
      const dir = sessionDir(projectDir, SESSION_ID);
      const planPath = join(dir, 'plan.json');
      writeFileSync(planPath, '# spec\n\nbody\n', 'utf-8');

      armReview('reviewing-plan');
      reviewStore.setReviewFile(planPath);

      const ui = renderFeature(<Host />);
      unmount = ui.unmount;
      await tick();

      // The keypress captures the current ownerToken synchronously and kicks off the async
      // confined read. Before it resolves, the owner disconnects: the review token advances.
      await flushEffects();
      ui.stdin.write(CTRL_E);
      reviewStore.setReviewFile(planPath);

      // Drain the fs pipeline so the trigger's in-flight read has definitely resolved (an
      // equivalent read enqueued after it), then flush its post-await continuation.
      await readSessionFileConfined(dir, planPath);
      await tick();
      await tick();

      // The stale-token guard after the read must swallow the result: no editor, no overlay
      // (CON-B — a stale session never seizes the newer live prompt).
      expect(editorStore.get().status).toBe('closed');
      expect(overlayStore.get().active).toBe('none');
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
