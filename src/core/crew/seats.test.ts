import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { CrewSeatId } from './identity.js';
import { deriveCrewSeats, type CrewSeat } from './seats.js';

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
    expect(review.model).toContain('OpenAI Codex CLI');
    expect(review.model).toContain('GPT-5 Codex');
    expect(review.posture).toBe('subscription-included');
  });

  it('resolves the build seat from the default implementer profile', () => {
    const build = seatOf(deriveCrewSeats({ config: makeConfig() }), 'build');

    expect(build.runner.kind).toBe('api');
    expect(build.model).toContain('Ollama');
    expect(build.model).toContain('Qwen 2.5 Coder 7B');
    expect(build.posture).toBe('local');
  });

  it('keeps the YAML-only escalation config out of the build seat', () => {
    const config = makeConfig({
      escalation: { intermediateProvider: 'ollama', intermediateModel: 'llama3.1' },
    });
    const build = seatOf(deriveCrewSeats({ config }), 'build');

    expect(build).toEqual(seatOf(deriveCrewSeats({ config: makeConfig() }), 'build'));
  });

  it('reports the billing posture of the configured auth channel', () => {
    const config = makeConfig({
      reviewer: { kind: 'cli', tool: 'claude-code', authChannel: 'api-key' },
    });
    const review = seatOf(deriveCrewSeats({ config }), 'review');

    expect(review.posture).toBe('api-metered');
  });

  it('says the automatic word when the runner names no model', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
    const plan = seatOf(deriveCrewSeats({ config }), 'plan');

    expect(plan.model).toContain('auto');
  });

  it('keeps the claude-code effort channel on the effort field', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4', effort: 'high' },
    });
    const plan = seatOf(deriveCrewSeats({ config }), 'plan');

    expect(plan.channel).toBe('effort-flag');
    expect(plan.effortValue).toBe('high');
  });

  it("reports the opencode build seat's variant channel and its saved variant", () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.6-luna',
        variant: 'xhigh',
      },
    });
    const build = seatOf(deriveCrewSeats({ config }), 'build');

    expect(build.channel).toBe('variant');
    expect(build.effortValue).toBe('xhigh');
  });

  it("reads a cursor seat's effort out of its model id", () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'cursor', model: 'gpt-5.6-luna-high-fast' },
    });
    const plan = seatOf(deriveCrewSeats({ config }), 'plan');

    expect(plan.channel).toBe('model-id');
    expect(plan.effortValue).toBe('high');
  });

  it('leaves a cursor seat whose id spells no effort with no value', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'cursor', model: 'composer-2.5' },
    });
    const plan = seatOf(deriveCrewSeats({ config }), 'plan');

    expect(plan.channel).toBe('model-id');
    expect(plan.effortValue).toBeUndefined();
  });

  it('refuses effort on a build seat no implementer adapter can deliver it to', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
    });
    const build = seatOf(deriveCrewSeats({ config }), 'build');

    expect(build.channel).toBe('none');
    expect(build.effortEditable).toBe(false);
  });

  it('offers effort on a Claude Code build seat', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' },
    });
    const build = seatOf(deriveCrewSeats({ config }), 'build');

    expect(build.channel).toBe('effort-flag');
    expect(build.effortEditable).toBe(true);
  });

  it('refuses effort on an api build seat, whatever its model', () => {
    const config = makeConfig({
      implementer: { kind: 'api', provider: 'ollama', model: 'llama3.1' },
    });
    const build = seatOf(deriveCrewSeats({ config }), 'build');

    expect(build.channel).toBe('none');
    expect(build.effortEditable).toBe(false);
  });
});
