import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { EMPTY_BRIEFS } from '../../../core/run-view/briefs.js';
import { EMPTY_RUN_VIEW, type RunView } from '../../../core/run-view/reduce.js';
import { taskId } from '../../../core/schemas/task.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { seatWaitSentence } from '../../../core/sessions/seat-wait-line.js';
import { glyph } from '../../../lib/glyphs.js';
import type {
  LifecycleState,
  RunningLifecycleState,
} from '../../../stores/workflow/lifecycle/types.js';
import type { RunningOperation } from '../../../stores/workflow/operations/state.js';
import type { LiveStatus } from './live-activity.js';
import { type BylineLeadInput, deriveBylineLead } from './byline-lead.js';

// Far in the past of the wall clock: a lead that read the wall clock in place of `now` reads it.
const NOW = 1_700_000_000_000;
const FRAME = '⠋';

function running(extra: Partial<RunningLifecycleState> = {}): RunningLifecycleState {
  return {
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth: 0,
    queuedMessageIds: new Set(),
    steerableCall: null,
    stall: null,
    retry: null,
    startedAt: NOW - 60_000,
    endedAt: null,
    durationMs: null,
    reason: null,
    ...extra,
  };
}

function cancelled(reason: string): LifecycleState {
  return {
    ...running(),
    status: 'cancelled',
    cancelled: true,
    endedAt: NOW,
    durationMs: 60_000,
    reason,
  };
}

// Two briefs of three passed, and the run builds the third.
const building: RunView = {
  ...EMPTY_RUN_VIEW,
  phase: 'implementing',
  briefs: {
    ...EMPTY_BRIEFS,
    tasks: [
      { id: 'T001', title: 'One', status: 'done' },
      { id: 'T002', title: 'Two', status: 'done' },
      { id: 'T003', title: 'Three', status: 'in_progress' },
    ],
    currentTask: 3,
    totalTasks: 3,
  },
};

const live: LiveStatus = {
  stageStart: NOW - 42_000,
  waitedMs: 2_000,
  parts: [{ text: 'Building T003', tone: 'implementer' }],
};

const stall = { since: NOW - 5_000, silentMs: 60_000, runnerName: 'opencode' };

const resetAt = new Date(NOW + 10 * 60_000).toISOString();

function input(extra: Partial<BylineLeadInput> = {}): BylineLeadInput {
  return {
    lifecycle: running(),
    runView: building,
    activeOperation: null,
    inputMode: 'normal',
    recoveryOpen: false,
    stopped: null,
    waiting: false,
    liveStatus: null,
    resuming: false,
    runChecking: false,
    slowProbe: null,
    buildBlockShown: false,
    frame: FRAME,
    cols: 120,
    now: NOW,
    ...extra,
  };
}

const stageTail = [
  { text: SOFT_SEP, tone: 'textDim' },
  { text: 'Build', tone: 'implementer' },
  { text: ' 2/3', tone: 'textDim' },
];

const liveLead = {
  lead: [{ text: `${FRAME} `, tone: 'accent' }, ...live.parts],
  leadClock: '0:40',
  hintText: null,
};

describe('deriveBylineLead', () => {
  it('leads with the stage-done pip, the stage and its fraction when nothing else holds the row', () => {
    expect(deriveBylineLead(input({ lifecycle: { ...running(), status: 'complete' } }))).toEqual({
      lead: [
        { text: `${glyph('stageDone')} `, tone: 'success' },
        { text: 'Build', tone: 'implementer' },
        { text: ' 2/3', tone: 'textDim' },
      ],
      hintText: null,
    });
  });

  it('states no lead before the run reaches a stage', () => {
    expect(
      deriveBylineLead(
        input({
          lifecycle: { ...running(), status: 'idle', startedAt: null },
          runView: EMPTY_RUN_VIEW,
        }),
      ),
    ).toEqual({ lead: [], hintText: null });
  });

  it('keeps the clock of a live status apart from its words, without the time spent waiting on the user', () => {
    expect(deriveBylineLead(input({ liveStatus: live }))).toEqual(liveLead);
  });

  it('gives a live status with no stage start no clock', () => {
    expect(deriveBylineLead(input({ liveStatus: { ...live, stageStart: 0 } }))).toEqual({
      ...liveLead,
      leadClock: '',
    });
  });

  it('says the run waits for the response while an API call has not answered', () => {
    const call: RunningOperation = {
      callId: 'call-1',
      role: 'implementer',
      phase: 'implementing',
      label: 'implementer',
      runnerName: 'anthropic',
      startedAt: NOW - 3_000,
      status: 'running',
      endedAt: null,
      durationMs: null,
      partial: false,
      reason: null,

      warnings: [],
      apiRuntimeStatus: { phase: 'waiting-first-response', loadState: 'unknown', observedAt: NOW },
    };
    expect(deriveBylineLead(input({ liveStatus: live, activeOperation: call }))).toEqual({
      ...liveLead,
      lead: [
        { text: `${FRAME} `, tone: 'accent' },
        { text: 'Waiting for response', tone: 'textDim' },
      ],
    });
  });

  it('a stall with no build block on screen states its silence at the given now, ahead of the live status', () => {
    expect(deriveBylineLead(input({ lifecycle: running({ stall }), liveStatus: live }))).toEqual({
      lead: [{ text: `${glyph('statusWarning')} No output for 1:05`, tone: 'warning' }],
      hintText: 'tools report when done',
    });
  });

  it('leaves a stall to the build block while the block is on screen', () => {
    expect(
      deriveBylineLead(
        input({ lifecycle: running({ stall }), liveStatus: live, buildBlockShown: true }),
      ),
    ).toEqual(liveLead);
  });

  it('a resuming run wins over a stall and names the brief it is on', () => {
    expect(deriveBylineLead(input({ lifecycle: running({ stall }), resuming: true }))).toEqual({
      lead: [
        { text: `${FRAME} `, tone: 'accent' },
        { text: 'Resuming ', tone: 'text' },
        { text: 'T003', tone: 'implementer' },
      ],
      hintText: null,
    });
  });

  it('a resuming run with no brief names its stage, Apply, or the run', () => {
    const resumed = (runView: RunView) =>
      deriveBylineLead(input({ runView, resuming: true })).lead.at(-1);
    expect(resumed({ ...EMPTY_RUN_VIEW, phase: 'implementing' })).toEqual({
      text: 'the build',
      tone: 'implementer',
    });
    expect(
      resumed({ ...EMPTY_RUN_VIEW, phase: 'final-review', afterLastBrief: { kind: 'apply' } }),
    ).toEqual({ text: 'Apply', tone: 'text' });
    expect(resumed(EMPTY_RUN_VIEW)).toEqual({ text: 'the run', tone: 'text' });
  });

  it('the check of an API seat wins over a resuming run and fits the width it is given', () => {
    const checking = (cols: number) =>
      deriveBylineLead(
        input({
          resuming: true,
          runChecking: true,
          slowProbe: { name: 'Claude Code', check: 'sign-in' },
          cols,
        }),
      );
    expect(checking(120)).toEqual({
      lead: [
        { text: `${FRAME} `, tone: 'accent' },
        { text: `Checking tools${SOFT_SEP}Claude Code sign-in`, tone: 'textDim' },
      ],
      hintText: null,
    });
    expect(checking(34).lead[1]).toEqual({ text: 'Claude Code sign-in', tone: 'textDim' });
  });

  it('a retry wins over the check of an API seat', () => {
    expect(
      deriveBylineLead(
        input({
          lifecycle: running({ retry: { attempt: 2, delayMs: 5_000 } }),
          runChecking: true,
          slowProbe: { name: 'Claude Code', check: 'sign-in' },
        }),
      ),
    ).toEqual({
      lead: [
        { text: `${FRAME} `, tone: 'accent' },
        { text: `Network or server failure${SOFT_SEP}retry 2 of 10 in 5s`, tone: 'textDim' },
      ],
      hintText: null,
    });
  });

  it('a live seat wait wins over a retry, with its reset read at the given now', () => {
    expect(
      deriveBylineLead(
        input({
          lifecycle: running({ retry: { attempt: 2, delayMs: 5_000 } }),
          runView: {
            ...building,
            seatWait: { tool: 'Codex', live: true, wait: { seat: 'build', resetAt } },
          },
        }),
      ),
    ).toEqual({
      lead: [
        {
          text: `${glyph('statusPending')} ${seatWaitSentence('Codex', resetAt, NOW)}`,
          tone: 'warning',
        },
      ],
      hintText: null,
    });
  });

  it('a seat wait that only the saved state holds leaves the row to the live status', () => {
    expect(
      deriveBylineLead(
        input({
          runView: {
            ...building,
            seatWait: { tool: 'Codex', live: false, wait: { seat: 'build', resetAt } },
          },
          liveStatus: live,
        }),
      ),
    ).toEqual(liveLead);
  });

  it('an interrupted run wins over a live seat wait', () => {
    expect(
      deriveBylineLead(
        input({
          lifecycle: { ...running(), status: 'interrupted' },
          runView: {
            ...building,
            seatWait: { tool: 'Codex', live: true, wait: { seat: 'build', resetAt } },
          },
        }),
      ),
    ).toEqual({
      lead: [
        { text: `${glyph('statusPending')} Interrupted`, tone: 'warning' },
        { text: ' — finishing current step…', tone: 'textDim' },
      ],
      hintText: null,
    });
  });

  it('a run the user stopped leads with the cancelled glyph and its stage, over a live seat wait', () => {
    expect(
      deriveBylineLead(
        input({
          lifecycle: cancelled('user_cancelled'),
          runView: {
            ...building,
            seatWait: { tool: 'Codex', live: true, wait: { seat: 'build', resetAt } },
          },
        }),
      ),
    ).toEqual({
      lead: [{ text: `${glyph('statusCancelled')} Stopped by you`, tone: 'warning' }, ...stageTail],
      hintText: null,
    });
  });

  it('a run that stopped for any other reason leads with the failed glyph and word', () => {
    expect(deriveBylineLead(input({ lifecycle: cancelled('engine_error') }))).toEqual({
      lead: [
        { text: `${glyph('statusFailed')} `, tone: 'error' },
        { text: 'Build', tone: 'implementer' },
        { text: ' failed', tone: 'error' },
        ...stageTail,
      ],
      hintText: null,
    });
  });

  it('a question or an approval that waits on the user wins over a stopped run', () => {
    expect(
      deriveBylineLead(input({ lifecycle: cancelled('user_cancelled'), waiting: true })),
    ).toEqual({
      lead: [
        { text: `${glyph('statusPending')} Waiting for your answer`, tone: 'warning' },
        ...stageTail,
      ],
      hintText: null,
    });
  });

  it('an open recovery panel wins over a wait on the user', () => {
    expect(deriveBylineLead(input({ recoveryOpen: true, waiting: true }))).toEqual({
      lead: [{ text: `${glyph('statusFailed')} Run stopped`, tone: 'warning' }],
      hintText: null,
    });
  });

  it('a stop under way wins over an open recovery panel and keeps its clock apart', () => {
    expect(
      deriveBylineLead(
        input({
          recoveryOpen: true,
          stopped: {
            tone: 'warning',
            parts: [{ text: 'Stopping T003', tone: 'text' }],
            clock: '0:42',
            hint: '',
          },
        }),
      ),
    ).toEqual({
      lead: [
        { text: `${glyph('statusPending')} `, tone: 'warning' },
        { text: 'Stopping T003', tone: 'text' },
      ],
      leadClock: '0:42',
      hintText: null,
    });
  });

  describe('a halt of the run', () => {
    const halted: RunView = {
      ...building,
      halt: {
        issue: makeRecoveryIssue(),
        at: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
      },
    };

    it('asks how to continue once its question is open, over a stop under way', () => {
      expect(
        deriveBylineLead(
          input({
            runView: halted,
            inputMode: 'question',
            recoveryOpen: true,
            stopped: {
              tone: 'warning',
              parts: [{ text: 'Stopping T003', tone: 'text' }],
              hint: '',
            },
          }),
        ),
      ).toEqual({
        lead: [{ text: `${glyph('statusPending')} Choose how to continue`, tone: 'warning' }],
        hintText: null,
      });
    });

    it('reads as a run still going to it while the panel has not opened on it', () => {
      expect(deriveBylineLead(input({ runView: halted, liveStatus: live }))).toEqual(liveLead);
    });

    it('reads as a stopped run while the panel is open with no question', () => {
      expect(
        deriveBylineLead(input({ runView: halted, recoveryOpen: true, liveStatus: live })),
      ).toEqual({
        lead: [{ text: `${glyph('statusFailed')} Run stopped`, tone: 'warning' }],
        hintText: null,
      });
    });
  });
});
