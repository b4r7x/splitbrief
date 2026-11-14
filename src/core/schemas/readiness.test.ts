import { describe, expect, it } from 'vitest';
import { readyFacts } from '#testing/helpers/factories/cli-readiness.js';
import { deriveCliReadiness } from '../readiness/cli-remediation.js';
import {
  CliInstallationStateSchema,
  CliReadinessResultSchema,
  type CliInstallationState,
} from './readiness.js';

describe('CLI runner readiness', () => {
  it('keeps installation state explicit and closed', () => {
    const states: readonly CliInstallationState[] = CliInstallationStateSchema.options;
    expect(states).toEqual(['installed', 'unavailable']);
  });

  it('rejects a result whose status or stable ID contradicts its facts', () => {
    const result = deriveCliReadiness(readyFacts());

    expect(CliReadinessResultSchema.safeParse({ ...result, status: 'unavailable' }).success).toBe(
      false,
    );
    expect(CliReadinessResultSchema.safeParse({ ...result, status: 'bogus' }).success).toBe(false);
    expect(CliReadinessResultSchema.safeParse({ ...result, checkId: 'random-id' }).success).toBe(
      false,
    );
  });
});
