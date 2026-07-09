import { Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { editorStore } from '../../stores/ui/editor.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { useFieldSessionOwned } from './use-field-session-owned.js';

const LAYOUT = { columns: 40, rows: 6 };

function Host() {
  const owned = useFieldSessionOwned();
  return <Text>{owned ? 'owned' : 'unowned'}</Text>;
}

describe('useFieldSessionOwned', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    editorStore.close();
    reviewStore.clearReview();
  });

  it('is false when no editor session is open', async () => {
    const ui = renderFeature(<Host />);
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('unowned');
  });

  it('is true only while the field session token still owns the live prompt', async () => {
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({
      filePath: '/tmp/TASKS.md',
      value: 'x',
      ownerToken: token,
      layout: LAYOUT,
    });

    const ui = renderFeature(<Host />);
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('owned');

    // The owner disconnects: the RPC dispatcher advances reviewStore.ownerToken. The editor
    // session still carries the stale token, so ownership — and mount/suppression/keys — drop.
    reviewStore.setReviewFile('/tmp/TASKS.md');
    await tick();
    expect(ui.lastFrame()).toContain('unowned');
  });

  it('is false for a raw session even when the review token matches', async () => {
    const token = reviewStore.setReviewFile('/tmp/spec.md');
    editorStore.openRaw({
      filePath: '/tmp/spec.md',
      value: 'x',
      ownerToken: token,
      layout: LAYOUT,
    });

    const ui = renderFeature(<Host />);
    unmount = ui.unmount;
    await tick();
    expect(ui.lastFrame()).toContain('unowned');
  });
});
