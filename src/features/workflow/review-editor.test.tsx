import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir } from '../../core/paths.js';
import { editorStore } from '../../stores/ui/editor.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import type { Phase } from '../../core/schemas/enums.js';
import { openReviewEditor } from './review-editor.js';

const SESSION_ID = '2026-07-08-inline-trigger';

function armReview(phase: Phase) {
  lifecycleStore.__testReset({ phase });
  overlayStore.close();
  terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
}

describe('openReviewEditor', () => {
  afterEach(() => {
    editorStore.close();
    overlayStore.close();
    reviewStore.clearReview();
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

      await openReviewEditor();
      expect(overlayStore.get().active).toBe('editor');

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

    await openReviewEditor();

    expect(editorStore.get().status).toBe('closed');
    expect(overlayStore.get().active).toBe('none');
  });

  it('does nothing at the plan card when no review file is set', async () => {
    armReview('reviewing-plan');
    reviewStore.setReviewFile(null);

    await openReviewEditor();

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

      await openReviewEditor();
      expect(overlayStore.get().active).toBe('editor');

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

      const opening = openReviewEditor();
      reviewStore.setReviewFile(planPath);
      await opening;
      expect(editorStore.get().status).toBe('closed');
      expect(overlayStore.get().active).toBe('none');
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
