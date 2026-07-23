import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { useBriefReviewKeys } from './use-brief-review-keys.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { focusHasResolvableCopy } from '../copy/resolve.js';
import type { CopyResult, CopyTarget } from '../../../core/runtime/commands/types.js';

function writeKey(ui: { stdin: { write: (d: string) => void } }, chars: string) {
  ui.stdin.write(chars);
}

function Harness({ copyTarget }: { copyTarget: (target: CopyTarget) => Promise<CopyResult> }) {
  useBriefReviewKeys({
    isActive: true,
    copyTarget,
    canCopyFocused: focusHasResolvableCopy,
  });
  return (
    <Box>
      <Text>ready</Text>
    </Box>
  );
}

function seedVisibleBriefReview(sources: string[], visibleCount = sources.length) {
  reviewStore.setReviewFile('specs/001/tasks.md');
  reviewStore.setBriefSources(sources);
  reviewStore.setRenderedLineCount(sources.length);
  reviewStore.setVisibleBriefCount(visibleCount);
}

describe('useBriefReviewKeys: y yank', () => {
  beforeEach(() => {
    resetAllStores();
    routerStore.navigate({ to: 'workflow', feature: 'test' });
  });

  afterEach(() => {
    focusStore.reset();
    feedbackStore.reset();
  });

  it('copies the focused region target and toasts the path on y', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, 'y');
    await tick();
    await Promise.resolve();
    await tick();

    expect(copyTarget).toHaveBeenCalledWith('brief');
    expect(feedbackStore.get().message).toBe('Copied (native)');
    expect(focusStore.get()).toBeNull();
    ui.unmount();
  });

  it('surfaces clipboard failure feedback on y without clearing focus', async () => {
    const copyTarget = vi.fn(async (): Promise<CopyResult> => {
      throw new Error('clipboard failed');
    });
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, 'y');
    await tick();
    await Promise.resolve();
    await tick();

    expect(feedbackStore.get().message).toBe('Could not copy: clipboard failed');
    expect(feedbackStore.get().isError).toBe(true);
    ui.unmount();
  });

  it('clears the row focus on a non-yank key without copying', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, 'a');
    await tick();

    expect(copyTarget).not.toHaveBeenCalled();
    expect(focusStore.get()).toBeNull();
    ui.unmount();
  });

  it('does nothing on y when no row is focused', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, 'y');
    await tick();

    expect(copyTarget).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('does not yank while an overlay is open', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);
    overlayStore.open('settings');

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, 'y');
    await tick();

    expect(copyTarget).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('selects a brief with the arrow keys so a keyboard-only user can yank without a mouse', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief', 'second brief']);
    controlsStore.setInputMode('review');

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, '\x1b[B');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });

    writeKey(ui, '\x1b[B');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });

    writeKey(ui, 'y');
    await tick();
    await Promise.resolve();
    await tick();

    expect(copyTarget).toHaveBeenCalledWith('brief');
    expect(focusStore.get()).toBeNull();
    ui.unmount();
  });

  it('keeps the brief selection on arrow keys instead of clearing it like other keys', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief', 'second brief', 'third brief']);
    controlsStore.setInputMode('review');
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, '\x1b[B');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });

    writeKey(ui, 'x');
    await tick();
    expect(focusStore.get()).toBeNull();
    ui.unmount();
  });

  it('does not yank a focus that resolves to no brief, leaving the key for the composer', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, 'y');
    await tick();

    expect(copyTarget).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('clears focus when the hook unmounts so it does not leak to other screens', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();
    expect(focusStore.get()).not.toBeNull();

    ui.unmount();
    await tick();

    expect(focusStore.get()).toBeNull();
  });

  it('does not create brief focus with arrow keys when no row is rendered', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['hidden brief'], 0);
    controlsStore.setInputMode('review');

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    writeKey(ui, '\x1b[B');
    await tick();

    expect(focusStore.get()).toBeNull();
    ui.unmount();
  });
});
