import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { createInitialState } from '../state/machine.js';
import { seatWaitMoved } from './held-seat.js';
import { atRestRunStatus, deriveRunStatus } from './run-status.js';

function state(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return { ...createInitialState('feat'), ...overrides };
}

const resetAt = '2026-09-01T17:00:00.000Z';

describe('seatWaitMoved', () => {
  it('returns false when wait has no holds', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    expect(seatWaitMoved({ seat: 'plan', resetAt, tool: 'claude-code', kind: 'cli' }, config)).toBe(
      false,
    );
  });

  describe('plan seat', () => {
    it('returns false when planner runs the held tool', () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } });
      expect(
        seatWaitMoved(
          {
            seat: 'plan',
            resetAt,
            tool: 'claude-code',
            kind: 'cli',
            holds: { tool: 'claude-code', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns false when planner runs the same tool with another model', () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } });
      expect(
        seatWaitMoved(
          {
            seat: 'plan',
            resetAt,
            tool: 'claude-code',
            kind: 'cli',
            holds: { tool: 'claude-code', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns true when planner runs another tool', () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
      expect(
        seatWaitMoved(
          {
            seat: 'plan',
            resetAt,
            tool: 'claude-code',
            kind: 'cli',
            holds: { tool: 'claude-code', kind: 'cli' },
          },
          config,
        ),
      ).toBe(true);
    });

    it('returns false when Retry at runs the limited tool', () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
      expect(
        seatWaitMoved(
          {
            seat: 'plan',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'claude-code', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns false when Retry at runs the held tool', () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } });
      expect(
        seatWaitMoved(
          {
            seat: 'plan',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'claude-code', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns true when Retry at runs a third tool', () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'deepseek' } });
      expect(
        seatWaitMoved(
          {
            seat: 'plan',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'claude-code', kind: 'cli' },
          },
          config,
        ),
      ).toBe(true);
    });
  });

  describe('build seat', () => {
    it('returns false when implementer runs the held tool', () => {
      const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
      expect(
        seatWaitMoved(
          {
            seat: 'build',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'codex', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns false when implementer runs the same tool with another model', () => {
      const config = makeConfig({
        implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-mini' },
      });
      expect(
        seatWaitMoved(
          {
            seat: 'build',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'codex', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns true when implementer runs another tool', () => {
      const config = makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
      });
      expect(
        seatWaitMoved(
          {
            seat: 'build',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'codex', kind: 'cli' },
          },
          config,
        ),
      ).toBe(true);
    });

    it('returns false when Retry at runs the limited tool', () => {
      const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
      expect(
        seatWaitMoved(
          {
            seat: 'build',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'opencode', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns false when Retry at runs the held tool', () => {
      const config = makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek' },
      });
      expect(
        seatWaitMoved(
          {
            seat: 'build',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'opencode', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns true when Retry at runs a third tool', () => {
      const config = makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
      });
      expect(
        seatWaitMoved(
          {
            seat: 'build',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'opencode', kind: 'cli' },
          },
          config,
        ),
      ).toBe(true);
    });

    it('respects profile-specific held seat', () => {
      const config = makeConfig({
        implementerProfiles: {
          default: 'small',
          profiles: {
            big: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
            small: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
          },
        },
      });
      expect(
        seatWaitMoved(
          {
            seat: 'build',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'codex', kind: 'cli', profile: 'big' },
          },
          config,
        ),
      ).toBe(false);
      expect(
        seatWaitMoved(
          {
            seat: 'build',
            resetAt,
            tool: 'opencode',
            kind: 'cli',
            holds: { tool: 'opencode', kind: 'cli', profile: 'big' },
          },
          config,
        ),
      ).toBe(true);
    });
  });

  describe('review seat', () => {
    it('returns false when reviewer runs the held tool', () => {
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
      expect(
        seatWaitMoved(
          {
            seat: 'review',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'codex', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns false when reviewer runs the same tool with another model', () => {
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-mini' } });
      expect(
        seatWaitMoved(
          {
            seat: 'review',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'codex', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns true when reviewer runs another tool', () => {
      const config = makeConfig({
        reviewer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
      });
      expect(
        seatWaitMoved(
          {
            seat: 'review',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'codex', kind: 'cli' },
          },
          config,
        ),
      ).toBe(true);
    });

    it('returns false when Retry at runs the limited tool', () => {
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
      expect(
        seatWaitMoved(
          {
            seat: 'review',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'opencode', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns false when Retry at runs the held tool', () => {
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'opencode', model: 'deepseek' } });
      expect(
        seatWaitMoved(
          {
            seat: 'review',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'opencode', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
    });

    it('returns true when Retry at runs a third tool', () => {
      const config = makeConfig({
        reviewer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
      });
      expect(
        seatWaitMoved(
          {
            seat: 'review',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'opencode', kind: 'cli' },
          },
          config,
        ),
      ).toBe(true);
    });

    it('falls back to planner when reviewer is unconfigured', () => {
      const config = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
      expect(
        seatWaitMoved(
          {
            seat: 'review',
            resetAt,
            tool: 'codex',
            kind: 'cli',
            holds: { tool: 'codex', kind: 'cli' },
          },
          config,
        ),
      ).toBe(false);
      expect(
        seatWaitMoved(
          {
            seat: 'review',
            resetAt,
            tool: 'claude-code',
            kind: 'cli',
            holds: { tool: 'claude-code', kind: 'cli' },
          },
          config,
        ),
      ).toBe(true);
    });
  });

  it('treats a missing kind as any kind', () => {
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
    expect(
      seatWaitMoved(
        {
          seat: 'build',
          resetAt,
          tool: 'codex',
          holds: { tool: 'codex', kind: 'cli' },
        },
        config,
      ),
    ).toBe(false);
  });
});

describe('deriveRunStatus with moved-seat rule', () => {
  it('omitting config stays seat-wait', () => {
    const s = state({
      seatWait: {
        seat: 'build',
        resetAt,
        tool: 'codex',
        kind: 'cli',
        holds: { tool: 'codex', kind: 'cli' },
      },
    });
    const status = deriveRunStatus({ state: s, liveness: 'not-alive' });
    expect(status).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'build' } },
    });
  });

  it('wait with no holds stays seat-wait even with another tool in config', () => {
    const s = state({
      seatWait: {
        seat: 'build',
        resetAt,
        tool: 'codex',
        kind: 'cli',
      },
    });
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
    expect(status).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'build' } },
    });
  });

  describe('plan seat', () => {
    it('yields a stop that is not seat-wait when seat runs another tool (automatic wait)', () => {
      const s = state({
        seatWait: {
          seat: 'plan',
          resetAt,
          tool: 'claude-code',
          kind: 'cli',
          holds: { tool: 'claude-code', kind: 'cli' },
        },
      });
      const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status.kind).toBe('open');
      if (status.kind === 'open') {
        expect(status.stop.kind).toBe('stopped');
        if (status.stop.kind === 'stopped') {
          expect(status.stop.on.kind).not.toBe('seat-wait');
        }
      }
    });

    it('yields a stop that is not seat-wait when seat runs a third tool (Retry at)', () => {
      const s = state({
        seatWait: {
          seat: 'plan',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'claude-code', kind: 'cli' },
        },
      });
      const config = makeConfig({ planner: { kind: 'cli', tool: 'opencode' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status.kind).toBe('open');
      if (status.kind === 'open' && status.stop.kind === 'stopped') {
        expect(status.stop.on.kind).not.toBe('seat-wait');
      }
    });

    it('stays seat-wait when seat runs the same tool with another model', () => {
      const s = state({
        seatWait: {
          seat: 'plan',
          resetAt,
          tool: 'claude-code',
          kind: 'cli',
          holds: { tool: 'claude-code', kind: 'cli' },
        },
      });
      const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'plan' } },
      });
    });

    it('stays seat-wait when Retry at runs the limited tool', () => {
      const s = state({
        seatWait: {
          seat: 'plan',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'claude-code', kind: 'cli' },
        },
      });
      const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'plan' } },
      });
    });

    it('stays seat-wait when Retry at runs the held tool', () => {
      const s = state({
        seatWait: {
          seat: 'plan',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'claude-code', kind: 'cli' },
        },
      });
      const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'plan' } },
      });
    });
  });

  describe('build seat', () => {
    it('yields a stop that is not seat-wait when seat runs another tool (automatic wait)', () => {
      const s = state({
        seatWait: {
          seat: 'build',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'codex', kind: 'cli' },
        },
      });
      const config = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status.kind).toBe('open');
      if (status.kind === 'open' && status.stop.kind === 'stopped') {
        expect(status.stop.on.kind).not.toBe('seat-wait');
      }
    });

    it('yields a stop that is not seat-wait when seat runs a third tool (Retry at)', () => {
      const s = state({
        seatWait: {
          seat: 'build',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'opencode', kind: 'cli' },
        },
      });
      const config = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status.kind).toBe('open');
      if (status.kind === 'open' && status.stop.kind === 'stopped') {
        expect(status.stop.on.kind).not.toBe('seat-wait');
      }
    });

    it('stays seat-wait when seat runs the same tool with another model', () => {
      const s = state({
        seatWait: {
          seat: 'build',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'codex', kind: 'cli' },
        },
      });
      const config = makeConfig({
        implementer: { kind: 'cli', tool: 'codex', model: 'other-model' },
      });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'build' } },
      });
    });

    it('stays seat-wait when Retry at runs the limited tool', () => {
      const s = state({
        seatWait: {
          seat: 'build',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'opencode', kind: 'cli' },
        },
      });
      const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'build' } },
      });
    });

    it('stays seat-wait when Retry at runs the held tool', () => {
      const s = state({
        seatWait: {
          seat: 'build',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'opencode', kind: 'cli' },
        },
      });
      const config = makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'build' } },
      });
    });
  });

  describe('review seat', () => {
    it('yields a stop that is not seat-wait when seat runs another tool (automatic wait)', () => {
      const s = state({
        seatWait: {
          seat: 'review',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'codex', kind: 'cli' },
        },
      });
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'claude-code' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status.kind).toBe('open');
      if (status.kind === 'open' && status.stop.kind === 'stopped') {
        expect(status.stop.on.kind).not.toBe('seat-wait');
      }
    });

    it('yields a stop that is not seat-wait when seat runs a third tool (Retry at)', () => {
      const s = state({
        seatWait: {
          seat: 'review',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'opencode', kind: 'cli' },
        },
      });
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'claude-code' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status.kind).toBe('open');
      if (status.kind === 'open' && status.stop.kind === 'stopped') {
        expect(status.stop.on.kind).not.toBe('seat-wait');
      }
    });

    it('stays seat-wait when seat runs the same tool with another model', () => {
      const s = state({
        seatWait: {
          seat: 'review',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'codex', kind: 'cli' },
        },
      });
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'other' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'review' } },
      });
    });

    it('stays seat-wait when Retry at runs the limited tool', () => {
      const s = state({
        seatWait: {
          seat: 'review',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'opencode', kind: 'cli' },
        },
      });
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'codex' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'review' } },
      });
    });

    it('stays seat-wait when Retry at runs the held tool', () => {
      const s = state({
        seatWait: {
          seat: 'review',
          resetAt,
          tool: 'codex',
          kind: 'cli',
          holds: { tool: 'opencode', kind: 'cli' },
        },
      });
      const config = makeConfig({ reviewer: { kind: 'cli', tool: 'opencode' } });
      const status = deriveRunStatus({ state: s, liveness: 'not-alive', config });
      expect(status).toMatchObject({
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'review' } },
      });
    });
  });
});

describe('atRestRunStatus', () => {
  it('returns record.status when status is running', () => {
    const s = state({
      seatWait: {
        seat: 'build',
        resetAt,
        tool: 'codex',
        kind: 'cli',
        holds: { tool: 'codex', kind: 'cli' },
      },
    });
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    const record = makeRunRecord({
      status: { kind: 'running' },
      hydration: { kind: 'loaded', state: s },
    });
    expect(atRestRunStatus(record, config)).toEqual({ kind: 'running' });
  });

  it('returns record.status when hydration is not loaded', () => {
    const config = makeConfig();
    const missingRecord = makeRunRecord({
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'failed', message: 'missing' } },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
      hydration: { kind: 'missing' },
    });
    expect(atRestRunStatus(missingRecord, config)).toBe(missingRecord.status);

    const invalidRecord = makeRunRecord({
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'failed', message: 'invalid' } },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
      hydration: { kind: 'invalid', code: 'malformed', message: 'invalid' },
    });
    expect(atRestRunStatus(invalidRecord, config)).toBe(invalidRecord.status);
  });

  it('returns record.status when loaded state has no seatWait', () => {
    const s = state();
    const config = makeConfig();
    const record = makeRunRecord({
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'interrupted' } },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
      hydration: { kind: 'loaded', state: s },
    });
    expect(atRestRunStatus(record, config)).toBe(record.status);
  });

  it('derives status with config when loaded state has seatWait and seat moved', () => {
    const s = state({
      seatWait: {
        seat: 'build',
        resetAt,
        tool: 'codex',
        kind: 'cli',
        holds: { tool: 'codex', kind: 'cli' },
      },
    });
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    const record = makeRunRecord({
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'build', tool: 'codex', resetAt } },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
      hydration: { kind: 'loaded', state: s },
    });
    const status = atRestRunStatus(record, config);
    expect(status.kind).toBe('open');
    if (status.kind === 'open' && status.stop.kind === 'stopped') {
      expect(status.stop.on.kind).not.toBe('seat-wait');
    }
  });

  it('derives seat-wait status when loaded state has seatWait and seat did not move', () => {
    const s = state({
      seatWait: {
        seat: 'build',
        resetAt,
        tool: 'codex',
        kind: 'cli',
        holds: { tool: 'codex', kind: 'cli' },
      },
    });
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });
    const record = makeRunRecord({
      status: {
        kind: 'open',
        stop: {
          kind: 'stopped',
          on: { kind: 'seat-wait', seat: 'build', tool: 'OpenAI Codex CLI', resetAt },
        },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
      hydration: { kind: 'loaded', state: s },
    });
    const status = atRestRunStatus(record, config);
    expect(status).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'seat-wait', seat: 'build' } },
    });
  });
});
