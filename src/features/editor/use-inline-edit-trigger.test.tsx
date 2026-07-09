import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readSessionFileConfined } from '../../core/sessions/confinement.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir } from '../../core/paths.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { editorStore } from '../../stores/ui/editor.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { focusStore } from '../../stores/ui/focus.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import type { Phase } from '../../core/schemas/enums.js';
import { useInlineEditTrigger } from './use-inline-edit-trigger.js';

const CTRL_E = '\x05';
const SESSION_ID = '2026-07-08-inline-trigger';

function Host({ sessionDirPath }: { sessionDirPath: string | undefined }) {
  useInlineEditTrigger({ isActive: true, sessionDirPath });
  return <Text>host</Text>;
}

function armReview(phase: Phase) {
  lifecycleStore.__testReset({ phase });
  controlsStore.setInputMode('review');
  overlayStore.close();
  terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
}

describe('useInlineEditTrigger', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    editorStore.close();
    overlayStore.close();
    reviewStore.clearReview();
    focusStore.clear();
    controlsStore.__testReset();
    lifecycleStore.__testReset();
    feedbackStore.reset();
  });

  it('opens a field session at the briefs gate when a brief is focused', async () => {
    armReview('reviewing-briefs');
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    focusStore.set('brief', 2);

    const ui = renderFeature(<Host sessionDirPath="/tmp" />);
    unmount = ui.unmount;
    await tick();

    ui.stdin.write(CTRL_E);
    await tick();

    const state = editorStore.get();
    expect(state.status).toBe('open');
    // The briefs branch opens the FIELD surface with an empty buffer and no confined read; the
    // captured review ownerToken becomes the field session's owner (CON-C / REQ-043).
    expect(state.status === 'open' ? state.surface : null).toBe('field');
    expect(state.status === 'open' ? state.ownerToken : null).toBe(token);
    expect(state.status === 'open' ? state.filePath : 'x').toBeNull();
  });

  it('does nothing at the briefs gate when no brief is focused', async () => {
    armReview('reviewing-briefs');
    reviewStore.setReviewFile('/tmp/TASKS.md');
    focusStore.clear();

    const ui = renderFeature(<Host sessionDirPath="/tmp" />);
    unmount = ui.unmount;
    await tick();

    ui.stdin.write(CTRL_E);
    await tick();

    expect(editorStore.get().status).toBe('closed');
    expect(overlayStore.get().active).toBe('none');
  });

  it('does nothing at the spec gate when no review file is set', async () => {
    armReview('reviewing-spec');
    reviewStore.setReviewFile(null);

    const ui = renderFeature(<Host sessionDirPath="/tmp" />);
    unmount = ui.unmount;
    await tick();

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

  it('opens the raw editor at the spec gate for the active review file', async () => {
    const projectDir = createTempDir('trigger-raw');
    try {
      ensureSessionDir(projectDir, SESSION_ID);
      const dir = sessionDir(projectDir, SESSION_ID);
      const specPath = join(dir, 'spec.md');
      writeFileSync(specPath, '# spec\n\ninline body\n', 'utf-8');

      armReview('reviewing-spec');
      const token = reviewStore.setReviewFile(specPath);

      const ui = renderFeature(<Host sessionDirPath={dir} />);
      unmount = ui.unmount;
      await tick();

      ui.stdin.write(CTRL_E);
      // The confined read is async; wait for the overlay to open once it resolves.
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('editor');
      });

      const state = editorStore.get();
      expect(state.status === 'open' ? state.surface : null).toBe('raw');
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
      const specPath = join(dir, 'spec.md');
      writeFileSync(specPath, '# spec\n\nbody\n', 'utf-8');

      armReview('reviewing-spec');
      reviewStore.setReviewFile(specPath);

      const ui = renderFeature(<Host sessionDirPath={dir} />);
      unmount = ui.unmount;
      await tick();

      // The keypress captures the current ownerToken synchronously and kicks off the async
      // confined read. Before it resolves, the owner disconnects: the review token advances.
      ui.stdin.write(CTRL_E);
      reviewStore.setReviewFile(specPath);

      // Drain the fs pipeline so the trigger's in-flight read has definitely resolved (an
      // equivalent read enqueued after it), then flush its post-await continuation.
      await readSessionFileConfined(dir, specPath);
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
