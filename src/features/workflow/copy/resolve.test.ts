import { beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { resolveCopyValue } from './resolve.js';

beforeEach(() => {
  eventsStore.__testReset();
  tokensStore.__testReset();
  tasksStore.__testReset();
  modelCacheStore.reset();
  configStore.__testReset();
  reviewStore.reset();
  routerStore.reset();
});

function seedVisibleBriefs(sources: string[], visibleCount = sources.length) {
  reviewStore.setBriefSources(sources);
  reviewStore.setBriefPaths(sources.map((_, index) => `src/b${index}.ts`));
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

  it('resolves the cost target from the canonical frozen-run evidence', () => {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        summary: makeSummary({ costBreakdown: makeCostBreakdown({ totalActualCost: 3 }) }),
      }),
      execution: { kind: 'at-rest' },
    });

    expect(resolveCopyValue('cost')).toBe('$3.00 (legacy estimate; rates not recorded)');
  });

  it('returns null for the cost target while no priced usage has accrued', () => {
    expect(resolveCopyValue('cost')).toBeNull();
  });

  it('resolves the brief at the top of the visible window', () => {
    seedVisibleBriefs(['first', 'second', 'third'], 2);
    reviewStore.setScrollOffset(2);

    expect(resolveCopyValue('brief')).toBe('second');
  });
});

describe('brief copy negative visibility matrix', () => {
  it.each(
    [
      { label: 'no compiled briefs', seed: () => {} },
      {
        label: 'brief sources exist but no row is rendered',
        seed: () => seedVisibleBriefs(['hidden brief'], 0),
      },
    ].flatMap((testCase) =>
      (['brief', 'path'] as const).map((target) => ({ ...testCase, target })),
    ),
  )('$label blocks $target copy', ({ seed, target }) => {
    seed();

    expect(resolveCopyValue(target)).toBeNull();
  });
});

describe('resolveCopyValue path target', () => {
  it('relativizes an absolute brief file against the project dir', () => {
    configStore.__testReset({ projectDir: '/repo/root', config: makeConfig() });
    reviewStore.setBriefPaths(['src/a.ts', '/repo/root/src/deep/b.ts']);
    reviewStore.setRenderedLineCount(2);
    reviewStore.setVisibleBriefCount(1);
    reviewStore.setScrollOffset(1);

    expect(resolveCopyValue('path')).toBe('src/deep/b.ts');
  });

  it('returns the brief file unchanged when already repo-relative', () => {
    configStore.__testReset({ projectDir: '/repo/root', config: makeConfig() });
    reviewStore.setBriefPaths(['src/a.ts', 'src/b.ts']);
    reviewStore.setRenderedLineCount(2);
    reviewStore.setVisibleBriefCount(2);

    expect(resolveCopyValue('path')).toBe('src/a.ts');
  });

  it('resolves the scroll-top brief file', () => {
    configStore.__testReset({ projectDir: '/repo/root', config: makeConfig() });
    reviewStore.setBriefPaths(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    reviewStore.setRenderedLineCount(3);
    reviewStore.setVisibleBriefCount(2);
    reviewStore.setScrollOffset(1);

    expect(resolveCopyValue('path')).toBe('src/b.ts');
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
