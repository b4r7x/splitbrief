import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { deriveCrewSeats, type CrewSeat, type CrewSeatId } from './seats.js';

function seatOf<Id extends CrewSeatId>(
  seats: readonly CrewSeat[],
  id: Id,
): Extract<CrewSeat, { id: Id }> {
  const seat = seats.find((candidate): candidate is Extract<CrewSeat, { id: Id }> => {
    return candidate.id === id;
  });
  if (seat === undefined) throw new Error(`no ${id} seat`);
  return seat;
}

describe('deriveCrewSeats', () => {
  it('orders the seats plan, build, review', () => {
    const seats = deriveCrewSeats({ config: makeConfig() });
    expect(seats.map((seat) => seat.id)).toEqual(['plan', 'build', 'review']);
  });

  it('reports the review seat as the planner when no reviewer is configured', () => {
    const config = makeConfig();
    const review = seatOf(deriveCrewSeats({ config }), 'review');

    expect(review.source).toBe('planner');
    expect(review.runner).toEqual(config.planner);
  });

  it('reports a configured reviewer with its own resolved identity', () => {
    const config = makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } });
    const review = seatOf(deriveCrewSeats({ config }), 'review');

    expect(review.source).toBe('configured');
    expect(review.runner).toEqual(config.reviewer);
    expect(review.model).toBe('gpt-5-codex');
    expect(review.posture).toBe('subscription-included');
  });

  it('resolves the build seat from the default implementer profile', () => {
    const build = seatOf(deriveCrewSeats({ config: makeConfig() }), 'build');

    expect(build.runner.kind).toBe('api');
    expect(build.model).toBe('qwen2.5-coder:7b');
    expect(build.posture).toBe('local');
  });

  it('omits the escalate branch when escalation is not configured', () => {
    const build = seatOf(deriveCrewSeats({ config: makeConfig() }), 'build');

    expect(build.escalate).toBeUndefined();
  });

  it('carries one escalate branch under build when escalation is configured', () => {
    const config = makeConfig({
      escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-chat' },
    });
    const build = seatOf(deriveCrewSeats({ config }), 'build');

    expect(build.escalate?.model).toBe('deepseek-chat');
    expect(build.escalate?.posture).toBe('api-metered');
  });

  it('reports the billing posture of the configured auth channel', () => {
    const config = makeConfig({
      reviewer: { kind: 'cli', tool: 'claude-code', authChannel: 'api-key' },
    });
    const review = seatOf(deriveCrewSeats({ config }), 'review');

    expect(review.posture).toBe('api-metered');
  });

  it('carries the escalate branch when the escalation provider is not a known one', () => {
    const config = makeConfig({
      escalation: { intermediateProvider: 'my-gateway', intermediateModel: 'big-model' },
    });
    const build = seatOf(deriveCrewSeats({ config }), 'build');

    expect(build.escalate?.displayName).toBe('my-gateway');
    expect(build.escalate?.model).toBe('big-model');
    expect(build.escalate?.posture).toBe('unknown');
  });

  it('omits the escalate branch when escalation is disabled', () => {
    const config = makeConfig({
      escalation: {
        enabled: false,
        intermediateProvider: 'deepseek',
        intermediateModel: 'deepseek-chat',
      },
    });
    const build = seatOf(deriveCrewSeats({ config }), 'build');

    expect(build.escalate).toBeUndefined();
  });

  it('leaves the model undefined when the runner names none', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
    const plan = seatOf(deriveCrewSeats({ config }), 'plan');

    expect(plan.model).toBeUndefined();
    expect(plan.displayName.length).toBeGreaterThan(0);
  });
});
