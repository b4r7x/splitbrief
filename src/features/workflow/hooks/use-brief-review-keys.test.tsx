import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { useBriefReviewKeys, type BriefReviewNavigate } from './use-brief-review-keys.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { focusHasResolvableCopy, resolveCopyValue } from '../copy/resolve.js';
import type { CopyResult, CopyTarget } from '../../../core/runtime/commands/types.js';

function Harness({
  copyTarget,
  captureNavigate,
}: {
  copyTarget: (target: CopyTarget) => Promise<CopyResult>;
  captureNavigate?: ((navigate: BriefReviewNavigate) => void) | undefined;
}) {
  const navigate = useBriefReviewKeys({
    isActive: true,
    copyTarget,
    canCopyFocused: focusHasResolvableCopy,
  });
  captureNavigate?.(navigate);
  return (
    <Box>
      <Text>ready</Text>
    </Box>
  );
}

function seedVisibleBriefReview(sources: string[], visibleCount = sources.length) {
  controlsStore.setInputMode('review');
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
    await flushEffects();

    ui.stdin.write('y');
    await tick();
    await Promise.resolve();
    await tick();

    expect(copyTarget).toHaveBeenCalledWith('brief');
    expect(copyTarget).toHaveBeenCalledTimes(1);
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
    await flushEffects();

    ui.stdin.write('y');
    await tick();
    await Promise.resolve();
    await tick();

    expect(feedbackStore.get().message).toBe('Could not copy: clipboard failed');
    expect(feedbackStore.get().isError).toBe(true);
    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });
    ui.unmount();
  });

  it.each([
    ['empty', 'Nothing to copy'],
    ['unavailable', 'Could not copy'],
  ] as const)('keeps focus when copy returns %s', async (result, message) => {
    const copyTarget = vi.fn(async (): Promise<CopyResult> => result);
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('y');
    await tick();
    await Promise.resolve();
    await tick();

    expect(feedbackStore.get().message).toBe(message);
    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });
    ui.unmount();
  });

  it('leaves printable text ownership to the composer without copying or clearing focus', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('a');
    await tick();

    expect(copyTarget).not.toHaveBeenCalled();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });
    ui.unmount();
  });

  it('does nothing on y when no row is focused', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('y');
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
    await flushEffects();

    ui.stdin.write('y');
    await tick();

    expect(copyTarget).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('selects a brief with the arrow keys so a keyboard-only user can yank without a mouse', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    const navigation: { current: BriefReviewNavigate | null } = { current: null };
    seedVisibleBriefReview(['first brief', 'second brief']);
    controlsStore.setInputMode('review');

    const ui = renderFeature(
      <Harness
        copyTarget={copyTarget}
        captureNavigate={(next) => {
          navigation.current = next;
        }}
      />,
    );
    await tick();

    const enterReview = navigation.current;
    if (enterReview === null) throw new Error('expected review navigation callback');
    enterReview('down');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });

    await flushEffects();
    ui.stdin.write('\x1b[B');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });

    await flushEffects();
    ui.stdin.write('y');
    await tick();
    await Promise.resolve();
    await tick();

    expect(copyTarget).toHaveBeenCalledWith('brief');
    expect(focusStore.get()).toBeNull();
    ui.unmount();
  });

  it('keeps the brief selection on arrow keys and leaves printable text to the composer', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief', 'second brief', 'third brief']);
    controlsStore.setInputMode('review');
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('\x1b[B');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });

    await flushEffects();
    ui.stdin.write('x');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });
    ui.unmount();
  });

  it('moves past the last visible row using the absolute brief index', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(
      Array.from({ length: 8 }, (_, index) => `brief ${index + 1}`),
      3,
    );
    controlsStore.setInputMode('review');
    reviewStore.setScrollOffset(2);
    focusStore.set('brief', 4);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('\x1b[B');
    await tick();

    expect(focusStore.get()).toEqual({ region: 'brief', index: 5 });
    expect(reviewStore.get().scrollOffset).toBe(3);

    await flushEffects();
    ui.stdin.write('\x1b[A');
    await tick();

    expect(focusStore.get()).toEqual({ region: 'brief', index: 4 });
    expect(reviewStore.get().scrollOffset).toBe(3);
    ui.unmount();
  });

  it('starts keyboard focus at the first absolute index in a scrolled window', async () => {
    let copiedBrief: string | null = null;
    const navigation: { current: BriefReviewNavigate | null } = { current: null };
    const copyTarget = vi.fn(async (target: CopyTarget): Promise<CopyResult> => {
      copiedBrief = resolveCopyValue(target);
      return 'native';
    });
    seedVisibleBriefReview(
      Array.from({ length: 8 }, (_, index) => `brief ${index + 1}`),
      3,
    );
    controlsStore.setInputMode('review');
    reviewStore.setScrollOffset(4);

    const ui = renderFeature(
      <Harness
        copyTarget={copyTarget}
        captureNavigate={(next) => {
          navigation.current = next;
        }}
      />,
    );
    await tick();

    const enterReview = navigation.current;
    if (enterReview === null) throw new Error('expected review navigation callback');
    enterReview('down');
    await tick();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 4 });

    await flushEffects();
    ui.stdin.write('y');
    await tick();
    await Promise.resolve();
    await tick();

    expect(copiedBrief).toBe('brief 5');
    expect(focusStore.get()).toBeNull();
    ui.unmount();
  });

  it('keeps the absolute selection visible and clamps the window after resize', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(
      Array.from({ length: 10 }, (_, index) => `brief ${index + 1}`),
      4,
    );
    controlsStore.setInputMode('review');
    reviewStore.setScrollOffset(6);
    focusStore.set('brief', 9);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await tick();

    reviewStore.setVisibleBriefCount(2);
    await tick();

    expect(focusStore.get()).toEqual({ region: 'brief', index: 9 });
    expect(reviewStore.get().scrollOffset).toBe(8);

    reviewStore.setVisibleBriefCount(8);
    await tick();

    expect(focusStore.get()).toEqual({ region: 'brief', index: 9 });
    expect(reviewStore.get().scrollOffset).toBe(2);
    ui.unmount();
  });

  it('does not clear a newer selection when an earlier copy finishes', async () => {
    let finishCopy: ((result: CopyResult) => void) | undefined;
    const copyTarget = vi.fn(
      () =>
        new Promise<CopyResult>((resolve) => {
          finishCopy = resolve;
        }),
    );
    seedVisibleBriefReview(['first brief', 'second brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('y');
    await tick();
    focusStore.set('brief', 1);
    await tick();
    if (finishCopy === undefined) throw new Error('expected copy to start');
    finishCopy('native');
    await Promise.resolve();
    await tick();

    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });
    ui.unmount();
  });

  it('does not clear a reselected row when an earlier copy finishes', async () => {
    let finishCopy: ((result: CopyResult) => void) | undefined;
    const copyTarget = vi.fn(
      () =>
        new Promise<CopyResult>((resolve) => {
          finishCopy = resolve;
        }),
    );
    seedVisibleBriefReview(['first brief', 'second brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('y');
    await tick();
    focusStore.set('brief', 1);
    focusStore.set('brief', 0);
    await tick();
    if (finishCopy === undefined) throw new Error('expected copy to start');
    finishCopy('native');
    await Promise.resolve();
    await tick();

    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });
    ui.unmount();
  });

  it('does not clear focus owned by a newer review when an earlier copy finishes', async () => {
    let finishCopy: ((result: CopyResult) => void) | undefined;
    const copyTarget = vi.fn(
      () =>
        new Promise<CopyResult>((resolve) => {
          finishCopy = resolve;
        }),
    );
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('y');
    await tick();
    seedVisibleBriefReview(['replacement brief']);
    feedbackStore.setMessage('newer review feedback');
    await tick();
    if (finishCopy === undefined) throw new Error('expected copy to start');
    finishCopy('native');
    await Promise.resolve();
    await tick();

    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });
    expect(feedbackStore.get().message).toBe('newer review feedback');
    ui.unmount();
  });

  it('does not leak clipboard failure feedback into a newer review', async () => {
    let failCopy: ((reason: Error) => void) | undefined;
    const copyTarget = vi.fn(
      () =>
        new Promise<CopyResult>((_resolve, reject) => {
          failCopy = reject;
        }),
    );
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('y');
    await tick();
    seedVisibleBriefReview(['replacement brief']);
    feedbackStore.setMessage('newer review feedback');
    await tick();
    if (failCopy === undefined) throw new Error('expected copy to start');
    failCopy(new Error('old review clipboard failed'));
    await Promise.resolve();
    await tick();

    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });
    expect(feedbackStore.get().message).toBe('newer review feedback');
    expect(feedbackStore.get().isError).toBe(false);
    ui.unmount();
  });

  it.each([
    ['escape', '\x1b'],
    ['page up', '\x1b[5~'],
    ['page down', '\x1b[6~'],
    ['home', '\x1b[H'],
    ['end', '\x1b[F'],
  ])('leaves %s ownership outside the brief hook', async (_label, input) => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief']);
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write(input);
    await tick();

    expect(copyTarget).not.toHaveBeenCalled();
    expect(focusStore.get()).toEqual({ region: 'brief', index: 0 });
    ui.unmount();
  });

  it('does not yank a focus that resolves to no brief, leaving the key for the composer', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    focusStore.set('brief', 0);

    const ui = renderFeature(<Harness copyTarget={copyTarget} />);
    await flushEffects();

    ui.stdin.write('y');
    await tick();

    expect(copyTarget).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('clears focus when the hook unmounts so it does not leak to other screens', async () => {
    const copyTarget = vi.fn(async (_target: CopyTarget): Promise<CopyResult> => 'native');
    seedVisibleBriefReview(['first brief']);
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
    const navigation: { current: BriefReviewNavigate | null } = { current: null };
    seedVisibleBriefReview(['hidden brief'], 0);
    controlsStore.setInputMode('review');

    const ui = renderFeature(
      <Harness
        copyTarget={copyTarget}
        captureNavigate={(next) => {
          navigation.current = next;
        }}
      />,
    );
    await tick();

    const enterReview = navigation.current;
    if (enterReview === null) throw new Error('expected review navigation callback');
    expect(enterReview('down')).toBe(false);
    await tick();

    expect(focusStore.get()).toBeNull();
    ui.unmount();
  });
});
