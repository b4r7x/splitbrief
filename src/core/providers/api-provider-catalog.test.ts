import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMITTED_API_PROVIDER_IDS,
  API_PROVIDER_CATALOG,
  API_PROVIDER_DECLARATIONS,
  IMPLEMENTER_API_PROVIDER_IDS,
  KNOWN_API_PROVIDER_IDS,
  LOCAL_API_PROVIDER_IDS,
  OLLAMA_CLOUD_API_PROVIDER_CANDIDATE,
  PENDING_API_PROVIDER_CANDIDATE_IDS,
  PLANNER_API_PROVIDER_IDS,
  REMOTE_API_PROVIDER_IDS,
  getApiProviderDescriptor,
  isApiProviderId,
} from './api-provider-catalog.js';
import {
  API_PROVIDER_VERDICT_CANDIDATE_PATHS,
  FORBIDDEN_API_PROVIDER_IDS,
  PASS_API_PROVIDER_IDS,
} from './api-provider-verdicts.js';
import {
  getKnownProviderBaseURL,
  KNOWN_PROVIDER_BASE_URLS,
  PROVIDER_CATALOG,
  resolveDefaultApiBase,
} from './catalog.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';

const projectRoot = join(import.meta.dirname, '../../..');

function projectPath(relativePath: string): string {
  return join(projectRoot, relativePath);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API provider catalog', () => {
  it('projects every admitted CLI into the combined provider catalog while keeping Cursor unadmitted', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(PROVIDER_CATALOG[id]).toMatchObject({
        id,
        displayName: CLI_TOOL_CATALOG[id].displayName,
        category: 'cli',
      });
    }
    expect(PROVIDER_CATALOG).not.toHaveProperty('cursor');
    expect(API_PROVIDER_CATALOG).not.toHaveProperty('cursor');
  });

  it('derives every admitted ID from active canonical declarations', () => {
    const activeDeclarations = Object.values(API_PROVIDER_DECLARATIONS).filter(
      (descriptor) => descriptor.admission.state === 'active',
    );

    expect([...ADMITTED_API_PROVIDER_IDS]).toEqual(activeDeclarations.map(({ id }) => id));
    expect(Object.keys(API_PROVIDER_CATALOG).toSorted()).toEqual(
      [...ADMITTED_API_PROVIDER_IDS].toSorted(),
    );
    expect(KNOWN_API_PROVIDER_IDS).toEqual(ADMITTED_API_PROVIDER_IDS);
  });

  it('derives active provider views from the canonical declarations', () => {
    const activeDeclarations = Object.values(API_PROVIDER_DECLARATIONS).filter(
      (descriptor) => descriptor.admission.state === 'active',
    );

    expect(Object.keys(KNOWN_PROVIDER_BASE_URLS).toSorted()).toEqual(
      activeDeclarations.map(({ id }) => id).toSorted(),
    );

    for (const declaration of activeDeclarations) {
      const activeDescriptor = Object.values(API_PROVIDER_CATALOG).find(
        ({ id }) => id === declaration.id,
      );
      const providerInfo = Object.values(PROVIDER_CATALOG).find(({ id }) => id === declaration.id);

      expect(activeDescriptor).toBe(declaration);
      expect(providerInfo).toMatchObject({
        id: declaration.id,
        displayName: declaration.displayName,
        category: declaration.category,
        locality: declaration.locality,
      });

      if (declaration.endpointPolicy.kind === 'fixed-origin') {
        expect(KNOWN_PROVIDER_BASE_URLS[declaration.id]).toBe(declaration.endpointPolicy.baseURL);
        expect(getKnownProviderBaseURL(declaration.id)).toBe(declaration.endpointPolicy.baseURL);
        expect(resolveDefaultApiBase(declaration.id)).toBe(declaration.endpointPolicy.baseURL);
        expect(providerInfo?.baseURL).toBe(declaration.endpointPolicy.baseURL);
      }
      if (declaration.endpointPolicy.kind === 'loopback') {
        expect(KNOWN_PROVIDER_BASE_URLS[declaration.id]).toBe(
          declaration.endpointPolicy.defaultBaseURL,
        );
        expect(getKnownProviderBaseURL(declaration.id)).toBe(
          declaration.endpointPolicy.defaultBaseURL,
        );
        expect(resolveDefaultApiBase(declaration.id)).toBe(
          declaration.endpointPolicy.defaultBaseURL,
        );
        expect(providerInfo?.baseURL).toBe(declaration.endpointPolicy.defaultBaseURL);
      }
      expect(providerInfo?.apiKeyEnv).toBe(declaration.credentialEnv ?? undefined);
      expect(providerInfo?.isLocal).toBe(declaration.locality === 'local' || undefined);
    }
  });

  it('activates direct Ollama Cloud only through its declared adapter admission', () => {
    expect(PENDING_API_PROVIDER_CANDIDATE_IDS).toEqual([]);
    expect(API_PROVIDER_DECLARATIONS['ollama-cloud']).toBe(OLLAMA_CLOUD_API_PROVIDER_CANDIDATE);
    expect(OLLAMA_CLOUD_API_PROVIDER_CANDIDATE).toMatchObject({
      id: 'ollama-cloud',
      displayName: 'Ollama Cloud',
      category: 'remote-api',
      locality: 'remote',
      endpointPolicy: { kind: 'fixed-origin', baseURL: 'https://ollama.com' },
      credentialEnv: 'OLLAMA_API_KEY',
      billing: 'provider-dependent',
      dataUse: 'provider-routed',
      authDiscoveryMode: 'api-key-unverified',
      modelDiscoveryMode: 'account-model-list',
      admission: { state: 'active' },
    });
    expect(API_PROVIDER_DECLARATIONS.ollama).toMatchObject({
      id: 'ollama',
      category: 'local-service',
      locality: 'local',
      credentialEnv: null,
      authDiscoveryMode: 'not-required',
    });
    expect(OLLAMA_CLOUD_API_PROVIDER_CANDIDATE).not.toBe(API_PROVIDER_DECLARATIONS.ollama);
    expect(API_PROVIDER_CATALOG['ollama-cloud']).toBe(OLLAMA_CLOUD_API_PROVIDER_CANDIDATE);
    expect(KNOWN_PROVIDER_BASE_URLS['ollama-cloud']).toBe('https://ollama.com');
    expect(PROVIDER_CATALOG['ollama-cloud']).toMatchObject({
      id: 'ollama-cloud',
      category: 'remote-api',
      locality: 'remote',
      apiKeyEnv: 'OLLAMA_API_KEY',
    });

    vi.stubEnv('OLLAMA_API_KEY', 'present');
    expect(OLLAMA_CLOUD_API_PROVIDER_CANDIDATE.authDiscoveryMode).toBe('api-key-unverified');
    expect(API_PROVIDER_DECLARATIONS.ollama.credentialEnv).toBeNull();
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
      'ollama-cloud',
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
    const declared = {
      ollama: 'local',
      'ollama-cloud': 'payg',
      'lm-studio': 'local',
      anthropic: 'payg',
      openrouter: 'payg',
      deepseek: 'payg',
      openai: 'payg',
      groq: 'payg',
      together: 'payg',
    };

    vi.stubEnv('OPENROUTER_API_KEY', 'tp-present');
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-cp-present');
    vi.stubEnv('OLLAMA_API_KEY', 'present');

    expect(
      Object.fromEntries(
        Object.values(API_PROVIDER_CATALOG).map(({ id, offering }) => [id, offering]),
      ),
    ).toEqual(declared);
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
