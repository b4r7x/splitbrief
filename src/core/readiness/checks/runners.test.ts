import { describe, it, expect } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { buildRunnerChecks } from './runners.js';

function availabilityDetails(config: ReturnType<typeof makeConfig>): string[] {
  const check = buildRunnerChecks(config).find((c) => c.id === 'runners.availability');
  return check?.details ?? [];
}

describe('buildRunnerChecks availability guidance', () => {
  it('points at the API key, endpoint, and model for an api planner', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        model: 'some-model',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    });

    const details = availabilityDetails(config);
    expect(details.some((d) => d.includes('API key, endpoint, and model'))).toBe(true);
    expect(details.some((d) => d.includes('runner CLI'))).toBe(false);
  });

  it('points at the runner CLI for a cli planner', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const details = availabilityDetails(config);
    expect(details.some((d) => d.includes('runner CLI'))).toBe(true);
    expect(details.some((d) => d.includes('API key, endpoint, and model'))).toBe(false);
  });
});
