import { describe, expect, it } from 'vitest';
import { clearEscalation, readEscalationRunner, writeEscalationRunner } from './escalation.js';
import { ConfigSchema } from '../../schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

describe('escalation accessors', () => {
  it('round-trips a written escalation runner and clears it again', () => {
    const config = makeConfig();
    expect(readEscalationRunner(config)).toBeUndefined();

    const written = writeEscalationRunner(config, {
      provider: 'lm-studio',
      model: 'deepseek-chat',
    });
    expect(ConfigSchema.parse(written).escalation?.intermediateModel).toBe('deepseek-chat');
    expect(readEscalationRunner(written)).toEqual({
      kind: 'api',
      provider: 'lm-studio',
      model: 'deepseek-chat',
    });
    expect(written.escalation?.enabled).toBe(true);

    const cleared = clearEscalation(written);
    expect(ConfigSchema.parse(cleared).escalation?.intermediateModel).toBeUndefined();
    expect(readEscalationRunner(cleared)).toBeUndefined();
    expect(cleared.escalation?.enabled).toBe(true);
  });

  it('reports no runner when escalation is disabled', () => {
    const config = makeConfig({
      escalation: {
        enabled: false,
        intermediateProvider: 'lm-studio',
        intermediateModel: 'deepseek-chat',
      },
    });
    expect(readEscalationRunner(config)).toBeUndefined();
  });

  it('leaves the original config untouched', () => {
    const config = makeConfig({
      escalation: { intermediateProvider: 'lm-studio', intermediateModel: 'deepseek-chat' },
    });
    const before = structuredClone(config);
    writeEscalationRunner(config, { provider: 'lm-studio', model: 'llama-3.3-70b' });
    clearEscalation(config);
    expect(config).toEqual(before);
  });
});
