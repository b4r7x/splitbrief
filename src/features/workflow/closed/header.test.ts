import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../../core/schemas/config.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { readSession } from '../../../core/sessions/io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { recordSeatIdentities } from '../../../core/state/seats.js';
import { finalizeRunAtRest } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { recordedCrewHeader, namesEverySeat } from './header.js';

const crew = makeSummary({
  plannerTool: 'claude-code',
  plannerModel: 'opus',
  implementerTool: 'claude-code',
  implementerModel: 'haiku',
});

/** The cells a three-stage rail paints beside the seat line. */
const RAIL_CELLS = 40;

function header(record: Partial<RunRecord>, cols = 200, railCells = RAIL_CELLS) {
  return recordedCrewHeader({
    record: makeRunRecord({ summary: crew, ...record }),
    railCells,
    cols,
  });
}

function readyState() {
  return makeWorkflowState({
    phase: 'complete',
    reviewStatus: 'passed',
    workspace: {
      kind: 'worktree',
      path: '/tmp/run-workspace',
      base: { snapshotId: 'workspace-base', head: null },
    },
  });
}

describe('recordedCrewHeader', () => {
  it('keeps the recorded crew seat tags, including an inherited reviewer', () => {
    const closed = header({ status: { kind: 'closed', as: 'ended' } });
    expect(closed?.crewNamed).toBe(true);
    expect(closed?.seatLine).toEqual([
      { text: 'PLAN Opus 5.5', seat: 'plan' },
      { text: ' · ' },
      { text: 'BUILD Haiku 5.5', seat: 'build' },
      { text: ' · ' },
      { text: 'REVIEW = PLAN', seat: 'review' },
    ]);
  });

  it('asks the Run block to name the crew when a seat was elided', () => {
    const closed = header({ status: { kind: 'closed', as: 'ended' } }, 60);
    expect(closed?.crewNamed).toBe(false);
    expect(closed?.seatLine.filter((span) => span.seat !== undefined).length).toBeLessThan(3);
  });

  it('fits the crew to the room the painted rail leaves', () => {
    const status = { kind: 'closed', as: 'ended' } as const;
    expect(header({ status }, 120)?.crewNamed).toBe(true);
    expect(header({ status }, 120, 100)?.crewNamed).toBe(false);
  });

  it('names the recorded crew of a run that waits for Apply, also while Apply writes', () => {
    const hydration = { kind: 'loaded', state: readyState() } as const;
    const ready = header({ status: { kind: 'ready-to-apply', override: false }, hydration });
    const applying = header({ status: { kind: 'running' }, hydration });
    expect(ready?.seats.build).toEqual({
      kind: 'named',
      short: 'Haiku 5.5',
      full: 'Claude Code CLI · Haiku 5.5',
    });
    expect(applying?.seatLine).toEqual(ready?.seatLine);
  });

  it('leaves a run that will build again, and a run with no record, to the crew it will use', () => {
    const stopped = header({
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'interrupted' } },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
      hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'implementing' }) },
    });
    expect(stopped).toBeNull();
    expect(header({ summary: null })).toBeNull();
  });
});

describe('recordedCrewHeader of a run closed on its recorded crew', () => {
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
    const line = recordedCrewHeader({
      record: makeRunRecord({ ref, summary }),
      railCells: RAIL_CELLS,
      cols: 200,
    })?.seatLine;
    return line?.find((span) => span.seat === 'review')?.text;
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
