import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PROVIDER_CATALOG,
  IMPLEMENTER_API_PROVIDER_IDS,
  KNOWN_API_PROVIDER_IDS,
  LOCAL_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
  REMOTE_API_PROVIDER_IDS,
} from './api-provider-catalog.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API provider catalog', () => {
  it('contains exactly the existing API provider IDs with their current roles', () => {
    expect(Object.keys(API_PROVIDER_CATALOG)).toEqual(KNOWN_API_PROVIDER_IDS);
    expect(PLANNER_API_PROVIDER_IDS).toEqual(
      KNOWN_API_PROVIDER_IDS.filter((id) =>
        API_PROVIDER_CATALOG[id].roles.some((role) => role === 'planner'),
      ),
    );
    expect(IMPLEMENTER_API_PROVIDER_IDS).toEqual(
      KNOWN_API_PROVIDER_IDS.filter((id) => API_PROVIDER_CATALOG[id].roles.includes('implementer')),
    );
    expect(LOCAL_API_PROVIDER_IDS).toEqual(['ollama', 'lm-studio']);
    expect(REMOTE_API_PROVIDER_IDS).toEqual([
      'anthropic',
      'openrouter',
      'deepseek',
      'openai',
      'groq',
      'together',
    ]);

    for (const id of KNOWN_API_PROVIDER_IDS) {
      const descriptor = API_PROVIDER_CATALOG[id];
      expect(descriptor.id).toBe(id);
      expect(descriptor.roles).toEqual(
        descriptor.offering === 'local' ? ['implementer'] : ['planner', 'implementer'],
      );
    }
  });

  it('keeps service, offering, billing, and data-use posture independent', () => {
    expect(API_PROVIDER_CATALOG.openrouter).toMatchObject({
      service: 'openrouter',
      offering: 'payg',
      billing: 'provider-dependent',
      dataUse: 'provider-routed',
    });
    expect(API_PROVIDER_CATALOG.groq).toMatchObject({
      service: 'groq',
      offering: 'payg',
      billing: 'provider-dependent',
      dataUse: 'non-retention',
    });
    expect(API_PROVIDER_CATALOG.ollama).toMatchObject({
      service: 'ollama',
      offering: 'local',
      billing: 'local',
      dataUse: 'local',
    });

    for (const descriptor of Object.values(API_PROVIDER_CATALOG)) {
      expect(descriptor.privacyURL).toMatch(/^https:\/\//);
      expect(descriptor.termsURL).toMatch(/^https:\/\//);
      expect(descriptor.asOf).toBe('2026-07-31');
    }
  });

  it('discloses DeepSeek training use under the reviewed terms', () => {
    expect(API_PROVIDER_CATALOG.deepseek).toMatchObject({
      offering: 'payg',
      dataUse: 'allowed-training',
      privacyURL: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
      termsURL:
        'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html',
    });
  });

  it('never selects an offering from credential presence or prefix', () => {
    const offerings = Object.values(API_PROVIDER_CATALOG).map(({ id, offering }) => ({
      id,
      offering,
    }));

    vi.stubEnv('OPENROUTER_API_KEY', 'tp-present');
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-cp-present');
    vi.stubEnv('OLLAMA_API_KEY', 'present');

    expect(
      Object.values(API_PROVIDER_CATALOG).map(({ id, offering }) => ({ id, offering })),
    ).toEqual(offerings);
  });

  it('cannot be mutated through exported nested references', () => {
    const descriptor = API_PROVIDER_CATALOG.openrouter;

    expect(Object.isFrozen(API_PROVIDER_CATALOG)).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.roles)).toBe(true);
    expect(Object.isFrozen(descriptor.endpointPolicy)).toBe(true);
    expect(Reflect.set(descriptor, 'offering', 'coding-subscription')).toBe(false);
    expect(Reflect.set(descriptor.roles, '0', 'implementer')).toBe(false);
    expect(API_PROVIDER_CATALOG.openrouter.offering).toBe('payg');
    expect(API_PROVIDER_CATALOG.openrouter.roles).toEqual(['planner', 'implementer']);
  });
});
