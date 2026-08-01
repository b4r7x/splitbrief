import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { CLI_READINESS_STATES, type ProviderDetection } from '../../../core/discovery/detection.js';
import {
  IMPLEMENTER_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
} from '../../../core/providers/api-provider-catalog.js';
import {
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../core/runners/cli-tool-catalog.js';
import { META_PROVIDER_IDS } from '../../../core/schemas/enums.js';
import { isCurrentConfig } from './catalog.js';
import { assemblePickerDescriptors, buildPickerOptions } from './options.js';
import { deriveModelCatalogCapability } from './posture.js';

function makeImplementerDetection(
  provider: ProviderDetection['provider'],
  extra: Partial<ProviderDetection> = {},
): ProviderDetection {
  return {
    provider,
    available: false,
    isLocal: false,
    ...extra,
  };
}

describe('role membership', () => {
  it('projects planner and implementer catalogs independently from canonical descriptors', () => {
    const descriptors = assemblePickerDescriptors();
    const detections = {
      cliTools: [cliDetectionFor('ready', 'claude-code')],
      providers: [
        makeImplementerDetection('anthropic', { available: true }),
        makeImplementerDetection('ollama', { available: true, isLocal: true }),
      ],
      hasApiKeyOverride: (provider: string) => provider === 'agent-sdk',
    };

    const plannerItems = buildPickerOptions('planner', descriptors, detections, undefined);
    const implementerItems = buildPickerOptions('implementer', descriptors, detections, undefined);

    const plannerIds = plannerItems.map((item) => item.id);
    const implementerIds = implementerItems.map((item) => item.id);

    expect(plannerIds).not.toEqual(implementerIds);
    expect(plannerIds).toEqual(
      expect.arrayContaining([
        ...META_PROVIDER_IDS,
        ...PLANNER_CLI_TOOL_IDS,
        ...PLANNER_API_PROVIDER_IDS,
      ]),
    );
    expect(implementerIds).toEqual(
      expect.arrayContaining([
        ...META_PROVIDER_IDS,
        ...IMPLEMENTER_CLI_TOOL_IDS,
        ...IMPLEMENTER_API_PROVIDER_IDS,
      ]),
    );
    expect(plannerIds).not.toContain('ollama');
    expect(plannerIds).not.toContain('lm-studio');
    expect(implementerIds).toContain('ollama');
    expect(implementerIds).toContain('lm-studio');
    expect(plannerItems.every((item) => item.roles.includes('planner'))).toBe(true);
    expect(implementerItems.every((item) => item.roles.includes('implementer'))).toBe(true);
  });

  it('includes the custom agent runner in both picker catalogs', () => {
    const descriptors = assemblePickerDescriptors();
    const detections = { cliTools: [], providers: [] };
    const plannerItems = buildPickerOptions('planner', descriptors, detections, undefined);
    const implementerItems = buildPickerOptions('implementer', descriptors, detections, undefined);

    expect(plannerItems.some((item) => item.id === 'agent' && item.kind === 'agent')).toBe(true);
    expect(implementerItems.some((item) => item.id === 'agent' && item.kind === 'agent')).toBe(
      true,
    );
  });
});

describe('status projection', () => {
  for (const state of CLI_READINESS_STATES) {
    it(`maps CLI ${state} readiness to one picker status and remediation`, () => {
      const detection = cliDetectionFor(state, 'codex');
      const descriptors = assemblePickerDescriptors();
      const options = buildPickerOptions(
        'implementer',
        descriptors,
        { cliTools: [detection], providers: [] },
        undefined,
      );
      const codex = options.find((item) => item.id === 'codex');
      expect(codex).toBeDefined();
      if (!codex) return;

      expect(codex.status.state).toBe(state);
      // The picker forwards the producer's own remediation; it never authors one.
      expect(codex.status.remediation).toBe(detection.diagnostic.remediation);
      expect(codex.available).toBe(state === 'ready');
    });
  }

  it('maps remote API missing credentials to unauthenticated', () => {
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [makeImplementerDetection('openrouter', { available: false, hasKey: false })],
      },
      undefined,
    );
    const openrouter = options.find((item) => item.id === 'openrouter');
    expect(openrouter?.status).toEqual({
      state: 'unauthenticated',
      remediation: 'Set OPENROUTER_API_KEY or configure an inline apiKey, then refresh detection.',
    });
    expect(openrouter?.available).toBe(false);
  });

  it('keeps an unverified provider unselectable even when reachable with a credential', () => {
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [makeImplementerDetection('deepseek', { available: true, hasKey: true })],
      },
      undefined,
    );
    const deepseek = options.find((item) => item.id === 'deepseek');
    expect(deepseek?.status).toEqual({
      state: 'unverified',
      remediation:
        'deepseek has no passing provider conformance evidence as of 2026-07-31. Select a verified provider, or re-run `scripts/provider-conformance.ts` with a credential to qualify it.',
    });
    expect(deepseek?.available).toBe(false);
  });

  it('maps local API offline state to unavailable', () => {
    const options = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [
          makeImplementerDetection('ollama', {
            available: false,
            isLocal: true,
            error: 'Ollama is not running',
          }),
        ],
      },
      undefined,
    );
    const ollama = options.find((item) => item.id === 'ollama');
    expect(ollama?.status).toEqual({
      state: 'unavailable',
      remediation: 'Ollama is not running',
    });
  });

  it('maps ready API detection to ready status', () => {
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [makeImplementerDetection('anthropic', { available: true, hasKey: true })],
      },
      undefined,
    );
    const anthropic = options.find((item) => item.id === 'anthropic');
    expect(anthropic?.status).toEqual({ state: 'ready', remediation: null });
    expect(anthropic?.available).toBe(true);
  });

  it('maps agent-sdk without credentials to unauthenticated', () => {
    const options = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      { cliTools: [], providers: [], hasApiKeyOverride: () => false },
      undefined,
    );
    const agentSdk = options.find((item) => item.id === 'agent-sdk');
    expect(agentSdk?.status.state).toBe('unauthenticated');
    expect(agentSdk?.available).toBe(false);
  });

  it('keeps shell and agent command runners always ready', () => {
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      { cliTools: [], providers: [] },
      undefined,
    );
    expect(options.find((item) => item.id === 'shell')?.status.state).toBe('ready');
    expect(options.find((item) => item.id === 'agent')?.status.state).toBe('ready');
    expect(options.find((item) => item.id === 'shell')?.available).toBe(true);
  });

  it('projects descriptor model policy onto picker options', () => {
    const codex = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      { cliTools: [cliDetectionFor('ready', 'codex')], providers: [] },
      undefined,
    ).find((item) => item.id === 'codex');

    expect(codex?.modelPolicy).toBe('optional');
    expect(codex?.modelCapability).toEqual(deriveModelCatalogCapability('optional', true));
  });
});

describe('current config visibility', () => {
  it('marks the resolved default implementer profile as current', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'deepseek',
        apiBase: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
      },
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
          },
        },
      },
    });

    const options = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [
          makeImplementerDetection('ollama', {
            available: false,
            isLocal: true,
            error: 'Ollama is not running',
          }),
        ],
      },
      config.implementerProfiles!.profiles['local-qwen'],
    );

    const ollama = options.find((item) => item.id === 'ollama');
    expect(ollama?.isCurrent).toBe(true);
    expect(ollama?.status.state).toBe('unavailable');
    expect(ollama?.status.remediation).toBe('Ollama is not running');

    expect(
      isCurrentConfig(
        {
          id: 'ollama',
          displayName: 'Ollama',
          kind: 'api',
          available: false,
        } as never,
        config,
        'implementer',
      ),
    ).toBe(true);
    expect(
      isCurrentConfig(
        {
          id: 'deepseek',
          displayName: 'DeepSeek',
          kind: 'api',
          available: true,
        } as never,
        config,
        'implementer',
      ),
    ).toBe(false);
  });

  it('keeps an incompatible current CLI visible with remediation', () => {
    const currentConfig = makeConfig().planner;
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      {
        cliTools: [cliDetectionFor('incompatible', 'claude-code')],
        providers: [],
      },
      currentConfig,
    );
    const claude = options.find((item) => item.id === 'claude-code');
    expect(claude?.isCurrent).toBe(true);
    expect(claude?.status.state).toBe('incompatible');
    expect(claude?.available).toBe(false);
  });
});
