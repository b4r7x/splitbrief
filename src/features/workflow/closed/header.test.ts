import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeView } from '#testing/helpers/factories/summary-view.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../../core/schemas/config.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { readSession } from '../../../core/sessions/io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { recordSeatIdentities } from '../../../core/state/seats.js';
import { finalizeRunAtRest } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { closedHeader, namesEverySeat } from './header.js';
import { reviewSeatView } from './projections.js';

describe('closedHeader', () => {
  it('keeps the recorded crew seat tags, including an inherited reviewer', () => {
    const header = closedHeader({ view: makeView(), cols: 200 });
    expect(header.crewNamed).toBe(true);
    expect(header.seatLine).toEqual([
      { text: 'PLAN claude-sonnet-4', seat: 'plan' },
      { text: ' · ' },
      { text: 'BUILD qwen2.5-coder:7b', seat: 'build' },
      { text: ' · ' },
      { text: 'REVIEW = PLAN', seat: 'review' },
    ]);
  });

  it('asks the Run block to name the crew when a seat was elided', () => {
    const header = closedHeader({ view: makeView(), cols: 60 });
    expect(header.crewNamed).toBe(false);
    expect(header.seatLine.filter((span) => span.seat !== undefined).length).toBeLessThan(3);
  });
});

describe('closedHeader of a run closed on its recorded crew', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  function reviewSpanOfRunClosedOn(config: Config): string | undefined {
    const projectDir = createTempDir('closed-header-review');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: 'sess-closed-review' };
    ensureSessionDir(projectDir, ref.sessionId);
    recordSeatIdentities(ref, config);
    finalizeRunAtRest({ ref, state: { ...createInitialState('feat'), phase: 'implementing' } });
    const summary = readSession(ref)?.summary;
    if (!summary) throw new Error('the closed run saved no summary');
    const view = makeView({ seats: { ...makeView().seats, review: reviewSeatView(summary) } });
    const line = closedHeader({ view, cols: 200 }).seatLine;
    return line.find((span) => span.seat === 'review')?.text;
  }

  it('names a reviewer seat set to the planner tool and model as its own seat', () => {
    const opus = { kind: 'cli', tool: 'claude-code', model: 'opus' } as const;
    const review = reviewSpanOfRunClosedOn(makeConfig({ planner: opus, reviewer: opus }));
    expect(review).toBe('REVIEW Opus 5.5');
  });

  it('marks a review seat that follows the planner with = PLAN', () => {
    expect(reviewSpanOfRunClosedOn(makeConfig())).toBe('REVIEW = PLAN');
  });
});

describe('namesEverySeat', () => {
  it('reads the tags even when an identity contains labels and separators', () => {
    expect(
      namesEverySeat([
        { text: 'custom PLAN · BUILD', seat: 'plan' },
        { text: 'worker', seat: 'build' },
        { text: '= PLAN', seat: 'review' },
      ]),
    ).toBe(true);
  });

  it('does not mistake a review inheritance mark for the missing planner span', () => {
    expect(
      namesEverySeat([
        { text: 'BUILD worker', seat: 'build' },
        { text: 'REVIEW = PLAN', seat: 'review' },
      ]),
    ).toBe(false);
    expect(namesEverySeat([{ text: 'PLAN one · BUILD two · REVIEW three' }])).toBe(false);
  });
});
