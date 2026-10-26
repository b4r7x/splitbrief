import { describe, it, expect, beforeEach } from 'vitest';
import type { EngineEvent } from '../../engine/events/types.js';
import { lifecycleStore, updatePhase } from './lifecycle.js';
import { resetWorkflow } from './actions/reset.js';

describe('lifecycleStore seatWait', () => {
  beforeEach(() => {
    resetWorkflow();
  });

  it('sets { tool, resetAt } on seat_wait_started for Plan, Build, and Review', () => {
    const base = lifecycleStore.get();

    const plan = updatePhase(base, {
      type: 'seat_wait_started',
      ts: 1_000,
      phase: 'planning',
      seat: 'plan',
      resetAt: '2026-10-27T12:00:00.000Z',
      tool: 'claude',
    });
    expect(plan.seatWait).toEqual({ tool: 'claude', resetAt: '2026-10-27T12:00:00.000Z' });
    expect(plan.phase).toBe(base.phase);
    expect(plan.status).toBe(base.status);

    const build = updatePhase(base, {
      type: 'seat_wait_started',
      ts: 1_000,
      phase: 'implementing',
      seat: 'build',
      resetAt: '2026-10-27T12:05:00.000Z',
      tool: 'codex',
    });
    expect(build.seatWait).toEqual({ tool: 'codex', resetAt: '2026-10-27T12:05:00.000Z' });
    expect(build.phase).toBe(base.phase);
    expect(build.status).toBe(base.status);

    const review = updatePhase(base, {
      type: 'seat_wait_started',
      ts: 1_000,
      phase: 'final-review',
      seat: 'review',
      resetAt: '2026-10-27T12:10:00.000Z',
      tool: 'gemini',
    });
    expect(review.seatWait).toEqual({ tool: 'gemini', resetAt: '2026-10-27T12:10:00.000Z' });
    expect(review.phase).toBe(base.phase);
    expect(review.status).toBe(base.status);
  });

  it('clears seatWait when seat_wait_ended follows', () => {
    const base = lifecycleStore.get();
    const started = updatePhase(base, {
      type: 'seat_wait_started',
      ts: 1_000,
      phase: 'implementing',
      seat: 'build',
      resetAt: '2026-10-27T12:00:00.000Z',
      tool: 'codex',
    });
    expect(started.seatWait).toEqual({ tool: 'codex', resetAt: '2026-10-27T12:00:00.000Z' });

    const ended = updatePhase(started, {
      type: 'seat_wait_ended',
      ts: 1_100,
      phase: 'implementing',
      seat: 'build',
    });
    expect(ended.seatWait).toBeNull();
    expect(ended.phase).toBe(started.phase);
    expect(ended.status).toBe(started.status);
  });

  it('leaves the field set on replay of a start with no end', () => {
    const events: EngineEvent[] = [
      { type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' },
      {
        type: 'seat_wait_started',
        ts: 1_100,
        phase: 'implementing',
        seat: 'build',
        resetAt: '2026-10-27T12:00:00.000Z',
        tool: 'codex',
      },
    ];

    const state = events.reduce((s, event) => updatePhase(s, event), lifecycleStore.get());
    expect(state.seatWait).toEqual({ tool: 'codex', resetAt: '2026-10-27T12:00:00.000Z' });
  });

  it('leaves seatWait null for a start an older log wrote without a tool', () => {
    const base = lifecycleStore.get();

    const noTool = updatePhase(base, {
      type: 'seat_wait_started',
      ts: 1_000,
      phase: 'planning',
      seat: 'plan',
      resetAt: '2026-10-27T12:00:00.000Z',
    });
    expect(noTool.seatWait).toBeNull();
  });

  it('leaves existing seatWait unchanged when start has no tool', () => {
    const base = lifecycleStore.get();
    const started = updatePhase(base, {
      type: 'seat_wait_started',
      ts: 1_000,
      phase: 'planning',
      seat: 'plan',
      resetAt: '2026-10-27T12:00:00.000Z',
      tool: 'claude',
    });

    const withoutTool = updatePhase(started, {
      type: 'seat_wait_started',
      ts: 1_100,
      phase: 'planning',
      seat: 'plan',
      resetAt: '2026-10-27T12:05:00.000Z',
    });
    expect(withoutTool.seatWait).toEqual({
      tool: 'claude',
      resetAt: '2026-10-27T12:00:00.000Z',
    });
  });

  it('keeps seatWait on workflow_resumed', () => {
    const base = lifecycleStore.get();
    const started = updatePhase(base, {
      type: 'seat_wait_started',
      ts: 1_000,
      phase: 'implementing',
      seat: 'build',
      resetAt: '2026-10-27T12:00:00.000Z',
      tool: 'codex',
    });

    const resumed = updatePhase(started, {
      type: 'workflow_resumed',
      ts: 1_500,
      phase: 'implementing',
    });
    expect(resumed.seatWait).toEqual({ tool: 'codex', resetAt: '2026-10-27T12:00:00.000Z' });
  });

  it('copies seatWait or defaults to null in lifecycleStateFromReset', () => {
    lifecycleStore.__testReset({
      seatWait: { tool: 'codex', resetAt: '2026-10-27T12:00:00.000Z' },
    });
    expect(lifecycleStore.get().seatWait).toEqual({
      tool: 'codex',
      resetAt: '2026-10-27T12:00:00.000Z',
    });

    lifecycleStore.__testReset({});
    expect(lifecycleStore.get().seatWait).toBeNull();
  });
});
