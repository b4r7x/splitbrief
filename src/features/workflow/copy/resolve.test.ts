import { beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { seedPricedRuntimeCost } from '#testing/helpers/seed-priced-cost.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { formatCost } from '../../../core/formatting.js';
import { focusHasResolvableCopy, resolveCopyValue } from './resolve.js';

beforeEach(() => {
  eventsStore.__testReset();
  tokensStore.__testReset();
  tasksStore.__testReset();
  modelCacheStore.reset();
  configStore.__testReset();
  reviewStore.reset();
  focusStore.clear();
});

function seedVisibleBriefs(sources: string[], visibleCount = sources.length) {
  reviewStore.setBriefSources(sources);
  reviewStore.setRenderedLineCount(sources.length);
  reviewStore.setVisibleBriefCount(visibleCount);
}

describe('resolveCopyValue', () => {
  it('resolves the message target to the latest assistant planner_text', () => {
    eventsStore.__testReset({
      events: [
        { type: 'planner_text', ts: 1, phase: 'specifying', text: 'first draft' },
        { type: 'planner_text', ts: 2, phase: 'planning', text: 'final answer' },
      ],
    });

    expect(resolveCopyValue('message')).toBe('final answer');
  });

  it('returns null for the message target when no assistant text has streamed', () => {
    expect(resolveCopyValue('message')).toBeNull();
  });

  it('resolves the cost target to the canonical sidebar spend once pricing is known', () => {
    seedPricedRuntimeCost();

    expect(resolveCopyValue('cost')).toBe(formatCost(3));
  });

  it('returns null for the cost target while no priced usage has accrued', () => {
    expect(resolveCopyValue('cost')).toBeNull();
  });

  it('resolves the focused brief by index', () => {
    seedVisibleBriefs(['first', 'second', 'third']);
    focusStore.set('brief', 1);

    expect(resolveCopyValue('brief')).toBe('second');
  });

  it('falls back to the top of the visible window when nothing is focused (keyboard path)', () => {
    seedVisibleBriefs(['first', 'second', 'third'], 2);
    reviewStore.setScrollOffset(2);

    expect(resolveCopyValue('brief')).toBe('second');
  });

  it('returns null for the brief target with no compiled briefs', () => {
    expect(resolveCopyValue('brief')).toBeNull();
  });

  it('returns null when the focused brief index is out of range', () => {
    seedVisibleBriefs(['only one']);
    focusStore.set('brief', 5);

    expect(resolveCopyValue('brief')).toBeNull();
  });

  it('returns null when brief sources exist but no row is rendered', () => {
    seedVisibleBriefs(['hidden brief'], 0);

    expect(resolveCopyValue('brief')).toBeNull();
  });

  it('returns null when the focused brief is outside the visible window', () => {
    seedVisibleBriefs(['b0', 'b1', 'b2', 'b3', 'b4'], 2);
    focusStore.set('brief', 4);

    expect(resolveCopyValue('brief')).toBeNull();
  });
});

describe('resolveCopyValue path target', () => {
  it('relativizes an absolute focused brief file against the project dir', () => {
    configStore.__testReset({ projectDir: '/repo/root', config: makeConfig() });
    reviewStore.setBriefPaths(['src/a.ts', '/repo/root/src/deep/b.ts']);
    reviewStore.setRenderedLineCount(2);
    reviewStore.setVisibleBriefCount(2);
    focusStore.set('brief', 1);

    expect(resolveCopyValue('path')).toBe('src/deep/b.ts');
  });

  it('returns the focused brief file unchanged when already repo-relative', () => {
    configStore.__testReset({ projectDir: '/repo/root', config: makeConfig() });
    reviewStore.setBriefPaths(['src/a.ts', 'src/b.ts']);
    reviewStore.setRenderedLineCount(2);
    reviewStore.setVisibleBriefCount(2);
    focusStore.set('brief', 0);

    expect(resolveCopyValue('path')).toBe('src/a.ts');
  });

  it('falls back to the scroll-top brief file when nothing is focused', () => {
    configStore.__testReset({ projectDir: '/repo/root', config: makeConfig() });
    reviewStore.setBriefPaths(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    reviewStore.setRenderedLineCount(3);
    reviewStore.setVisibleBriefCount(2);
    reviewStore.setScrollOffset(1);

    expect(resolveCopyValue('path')).toBe('src/b.ts');
  });

  it('returns null when there are no brief rows', () => {
    expect(resolveCopyValue('path')).toBeNull();
  });

  it('returns null when brief paths exist but no row is rendered', () => {
    reviewStore.setBriefPaths(['src/a.ts']);
    reviewStore.setRenderedLineCount(1);
    reviewStore.setVisibleBriefCount(0);

    expect(resolveCopyValue('path')).toBeNull();
  });

  it('returns null when the focused brief index is out of range', () => {
    reviewStore.setBriefPaths(['src/a.ts']);
    reviewStore.setRenderedLineCount(1);
    reviewStore.setVisibleBriefCount(1);
    focusStore.set('brief', 5);

    expect(resolveCopyValue('path')).toBeNull();
  });
});

describe('resolveCopyValue command target', () => {
  it('resolves the configured planner shell command', () => {
    configStore.__testReset({
      projectDir: '/repo/root',
      config: makeConfig({ planner: { kind: 'shell', command: 'my-planner --plan' } }),
    });

    expect(resolveCopyValue('command')).toBe('my-planner --plan');
  });

  it('returns null when the planner exposes no command', () => {
    configStore.__testReset({
      projectDir: '/repo/root',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });

    expect(resolveCopyValue('command')).toBeNull();
  });
});

describe('brief focus reconciliation gates copy', () => {
  it('does not yank a brief that has scrolled offscreen', () => {
    reviewStore.setBriefSources(['b0', 'b1', 'b2', 'b3', 'b4']);
    reviewStore.setRenderedLineCount(5);
    reviewStore.setVisibleBriefCount(2);
    focusStore.set('brief', 4);

    reviewStore.setScrollOffset(0);

    expect(focusStore.get()).toBeNull();
    expect(resolveCopyValue('brief')).toBe('b0');
  });
});

describe('focusHasResolvableCopy', () => {
  it('is false when nothing is focused', () => {
    expect(focusHasResolvableCopy(null)).toBe(false);
  });

  it('is true for a focused brief region with a compiled brief', () => {
    seedVisibleBriefs(['raw brief markdown']);
    focusStore.set('brief', 0);

    expect(focusHasResolvableCopy(focusStore.get())).toBe(true);
  });

  it('is false for a focused brief region with no compiled briefs', () => {
    focusStore.set('brief', 0);

    expect(focusHasResolvableCopy(focusStore.get())).toBe(false);
  });

  it('is false when the focused brief index is out of range', () => {
    seedVisibleBriefs(['only one']);
    focusStore.set('brief', 5);

    expect(focusHasResolvableCopy(focusStore.get())).toBe(false);
  });

  it('is false when brief sources exist but no row is rendered', () => {
    seedVisibleBriefs(['hidden brief'], 0);
    focusStore.set('brief', 0);

    expect(focusHasResolvableCopy(focusStore.get())).toBe(false);
  });

  it('is false when the focused brief is outside the visible window', () => {
    seedVisibleBriefs(['b0', 'b1', 'b2'], 1);
    focusStore.set('brief', 2);

    expect(focusHasResolvableCopy(focusStore.get())).toBe(false);
  });
});
