import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { seatWaitMoved } from './held-seat.js';

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
