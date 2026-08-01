import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMITTED_API_PROVIDER_IDS,
  API_PROVIDER_CATALOG,
  API_PROVIDER_VERDICT_CANDIDATE_PATHS,
  EXISTING_API_PROVIDER_IDS,
  FORBIDDEN_API_PROVIDER_IDS,
  IMPLEMENTER_API_PROVIDER_IDS,
  KNOWN_API_PROVIDER_IDS,
  LOCAL_API_PROVIDER_IDS,
  PASS_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
  REMOTE_API_PROVIDER_IDS,
  getApiProviderDescriptor,
  isApiProviderId,
} from './api-provider-catalog.js';

const projectRoot = join(import.meta.dirname, '../../..');

function projectPath(relativePath: string): string {
  return join(projectRoot, relativePath);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API provider catalog', () => {
  it('assembles exactly existing IDs plus PASS verdict IDs', () => {
    expect([...ADMITTED_API_PROVIDER_IDS]).toEqual([
      ...EXISTING_API_PROVIDER_IDS,
      ...PASS_API_PROVIDER_IDS,
    ]);
    expect(Object.keys(API_PROVIDER_CATALOG).toSorted()).toEqual(
      [...ADMITTED_API_PROVIDER_IDS].toSorted(),
    );
    expect(KNOWN_API_PROVIDER_IDS).toEqual(ADMITTED_API_PROVIDER_IDS);
  });

  it('returns zero forbidden descriptor IDs from the exclusion list', () => {
    const catalogKeys = Object.keys(API_PROVIDER_CATALOG);
    const forbiddenPresent = FORBIDDEN_API_PROVIDER_IDS.filter((id) => catalogKeys.includes(id));
    expect(forbiddenPresent).toEqual([]);
  });

  it('keeps OMIT verdict candidate source and tests absent with no catalog IDs', () => {
    for (const candidate of API_PROVIDER_VERDICT_CANDIDATE_PATHS) {
      expect(existsSync(projectPath(candidate.source))).toBe(false);
      expect(existsSync(projectPath(candidate.test))).toBe(false);
      expect(API_PROVIDER_CATALOG).not.toHaveProperty(candidate.id);
    }
  });

  it('requires retained candidate source for every PASS verdict ID', () => {
    for (const id of PASS_API_PROVIDER_IDS) {
      const candidate = API_PROVIDER_VERDICT_CANDIDATE_PATHS.find((entry) => entry.id === id);
      expect(candidate).toBeDefined();
      if (candidate === undefined) continue;
      expect(existsSync(projectPath(candidate.source))).toBe(true);
      expect(existsSync(projectPath(candidate.test))).toBe(true);
    }
  });

  it('contains exactly the existing API provider IDs with their current roles', () => {
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

  it('resolves descriptors by id without matching inherited or service-alias keys', () => {
    for (const id of KNOWN_API_PROVIDER_IDS) {
      expect(isApiProviderId(id)).toBe(true);
      expect(getApiProviderDescriptor(id)).toBe(API_PROVIDER_CATALOG[id]);
    }

    for (const id of ['toString', 'constructor', '__proto__', 'unknown-provider']) {
      expect(isApiProviderId(id)).toBe(false);
      expect(getApiProviderDescriptor(id)).toBeUndefined();
    }
  });

  it('discloses DeepSeek training use under the reviewed terms', () => {
    expect(API_PROVIDER_CATALOG.deepseek).toMatchObject({
      offering: 'payg',
      compatibility: 'unverified',
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
