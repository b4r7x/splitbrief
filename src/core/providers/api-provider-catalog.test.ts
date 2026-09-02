import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMITTED_API_PROVIDER_IDS,
  API_PROVIDER_CATALOG,
  IMPLEMENTER_API_PROVIDER_IDS,
  KNOWN_API_PROVIDER_IDS,
  LOCAL_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
  REMOTE_API_PROVIDER_IDS,
  getApiProviderDescriptor,
  isApiProviderId,
} from './api-provider-catalog.js';
import { FORBIDDEN_API_PROVIDER_IDS } from './api-provider-verdicts.js';
import {
  getKnownProviderBaseURL,
  KNOWN_PROVIDER_BASE_URLS,
  PROVIDER_CATALOG,
  resolveDefaultApiBase,
} from './catalog.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API provider catalog', () => {
  it('projects every admitted CLI into the combined provider catalog', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(PROVIDER_CATALOG[id]).toMatchObject({
        id,
        displayName: CLI_TOOL_CATALOG[id].displayName,
        category: 'cli',
      });
    }
    expect(API_PROVIDER_CATALOG).not.toHaveProperty('cursor');
  });

  it('admits the two local services and nothing else', () => {
    expect(Object.keys(API_PROVIDER_CATALOG)).toEqual(['ollama', 'lm-studio']);
    expect([...ADMITTED_API_PROVIDER_IDS]).toEqual(['ollama', 'lm-studio']);
    expect(KNOWN_API_PROVIDER_IDS).toEqual(ADMITTED_API_PROVIDER_IDS);
    expect(LOCAL_API_PROVIDER_IDS).toEqual(['ollama', 'lm-studio']);
    expect(REMOTE_API_PROVIDER_IDS).toEqual([]);
  });

  it('derives every provider view from the canonical descriptors', () => {
    const descriptors = Object.values(API_PROVIDER_CATALOG);

    expect(Object.keys(KNOWN_PROVIDER_BASE_URLS).toSorted()).toEqual(
      descriptors.map(({ id }) => id).toSorted(),
    );

    for (const descriptor of descriptors) {
      const providerInfo = Object.values(PROVIDER_CATALOG).find(({ id }) => id === descriptor.id);

      expect(providerInfo).toMatchObject({
        id: descriptor.id,
        displayName: descriptor.displayName,
        category: descriptor.category,
        locality: descriptor.locality,
      });

      if (descriptor.endpointPolicy.kind === 'loopback') {
        expect(KNOWN_PROVIDER_BASE_URLS[descriptor.id]).toBe(
          descriptor.endpointPolicy.defaultBaseURL,
        );
        expect(getKnownProviderBaseURL(descriptor.id)).toBe(
          descriptor.endpointPolicy.defaultBaseURL,
        );
        expect(resolveDefaultApiBase(descriptor.id)).toBe(descriptor.endpointPolicy.defaultBaseURL);
        expect(providerInfo?.baseURL).toBe(descriptor.endpointPolicy.defaultBaseURL);
      }
      expect(providerInfo?.apiKeyEnv).toBe(descriptor.credentialEnv ?? undefined);
      expect(providerInfo?.isLocal).toBe(descriptor.locality === 'local' || undefined);
    }
  });

  it('returns zero forbidden descriptor IDs from the exclusion list', () => {
    const catalogKeys = Object.keys(API_PROVIDER_CATALOG);
    const forbiddenPresent = FORBIDDEN_API_PROVIDER_IDS.filter((id) => catalogKeys.includes(id));
    expect(forbiddenPresent).toEqual([]);
  });

  it('reserves both local services for the implementer seat', () => {
    expect(PLANNER_API_PROVIDER_IDS).toEqual([]);
    expect(IMPLEMENTER_API_PROVIDER_IDS).toEqual(['ollama', 'lm-studio']);

    for (const id of KNOWN_API_PROVIDER_IDS) {
      const descriptor = API_PROVIDER_CATALOG[id];
      expect(descriptor.id).toBe(id);
      expect(descriptor.offering).toBe('local');
      expect(descriptor.roles).toEqual(['implementer']);
    }
  });

  it('keeps service, offering, billing, and data-use posture independent', () => {
    expect(API_PROVIDER_CATALOG.ollama).toMatchObject({
      service: 'ollama',
      offering: 'local',
      billing: 'local',
      dataUse: 'local',
    });
    expect(API_PROVIDER_CATALOG['lm-studio']).toMatchObject({
      service: 'lm-studio',
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

  it('never selects an offering from credential presence or prefix', () => {
    vi.stubEnv('OLLAMA_API_KEY', 'present');
    vi.stubEnv('OPENAI_API_KEY', 'sk-present');

    expect(
      Object.fromEntries(
        Object.values(API_PROVIDER_CATALOG).map(({ id, offering }) => [id, offering]),
      ),
    ).toEqual({ ollama: 'local', 'lm-studio': 'local' });
  });

  it('cannot be mutated through exported nested references', () => {
    const descriptor = API_PROVIDER_CATALOG.ollama;

    expect(Object.isFrozen(API_PROVIDER_CATALOG)).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.roles)).toBe(true);
    expect(Object.isFrozen(descriptor.endpointPolicy)).toBe(true);
    expect(Reflect.set(descriptor, 'offering', 'coding-subscription')).toBe(false);
    expect(Reflect.set(descriptor.roles, '0', 'planner')).toBe(false);
    expect(API_PROVIDER_CATALOG.ollama.offering).toBe('local');
    expect(API_PROVIDER_CATALOG.ollama.roles).toEqual(['implementer']);
  });
});
