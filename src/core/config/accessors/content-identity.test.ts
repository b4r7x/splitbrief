import { describe, expect, it } from 'vitest';
import { contentIdentityId } from './content-identity.js';
import { projectRunnerDiscoveryContext } from './runner-discovery-context.js';
import { createDefaultConfig } from '../load/io.js';
import type { Config } from '../../schemas/config.js';

function apiConfig(apiKey: string): Config {
  return {
    ...createDefaultConfig(),
    planner: {
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      apiBase: 'https://api.anthropic.com/v1/',
      apiKey,
      model: 'claude-opus-4-6',
    },
  };
}

describe('contentIdentityId', () => {
  it('gives equal-content configs the same id across distinct objects', () => {
    const a = createDefaultConfig();
    const b = createDefaultConfig();
    expect(a).not.toBe(b);
    expect(contentIdentityId('config', a)).toBe(contentIdentityId('config', b));
  });

  it('changes when the content changes', () => {
    const base = createDefaultConfig();
    const changed = { ...base, planner: { ...base.planner, model: 'other-model' } };
    expect(contentIdentityId('config', base)).not.toBe(contentIdentityId('config', changed));
  });

  it('never embeds inline credential material in the id input', () => {
    const secret = 'sk-inline-secret-value';
    const a = contentIdentityId('config', apiConfig(secret));
    const b = contentIdentityId('config', apiConfig('sk-other-secret'));
    // A rotated inline key is a different config identity, and neither id
    // carries the key it was derived from.
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(b).not.toContain('sk-other-secret');
  });

  it('distinguishes env-referenced credentials by name', () => {
    const a = contentIdentityId('config', apiConfig('env:KEY_ONE'));
    const b = contentIdentityId('config', apiConfig('env:KEY_TWO'));
    expect(a).not.toBe(b);
  });
});

describe('runner discovery context generation', () => {
  it('is reproducible across processes: equal content yields an equal context', () => {
    const left = projectRunnerDiscoveryContext({ config: createDefaultConfig(), role: 'planner' });
    const right = projectRunnerDiscoveryContext({ config: createDefaultConfig(), role: 'planner' });
    expect(left.configGeneration).toBe(right.configGeneration);
    expect(left).toEqual(right);
  });
});
