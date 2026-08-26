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
import { isCurrentConfig } from './catalog.js';
import { assemblePickerDescriptors, buildPickerOptions, type PickerOption } from './options.js';
import { deriveModelCatalogCapability } from './posture.js';
import type { ConfiguredProviderRuntime } from '../../../engine/detection/provider-outcomes.js';

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

function scopedRuntime(input: {
  role: 'planner' | 'implementer';
  provider: 'openrouter' | 'anthropic';
  state: 'fresh' | 'stale' | 'failed';
  failure?: ConfiguredProviderRuntime['failure'];
}): ConfiguredProviderRuntime {
  return {
    connection: { role: input.role, provider: input.provider, contextKey: `${input.role}-context` },
    state: input.state,
    catalog: input.state === 'fresh' ? 'empty' : null,
    models: input.state === 'fresh' ? [] : null,
    fetchedAt: input.state === 'fresh' ? 1 : null,
    validatedAt: 2,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
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
        'custom-command',
        'agent-sdk',
        ...PLANNER_CLI_TOOL_IDS,
        ...PLANNER_API_PROVIDER_IDS,
      ]),
    );
    expect(implementerIds).toEqual(
      expect.arrayContaining([
        'custom-command',
        'agent-sdk',
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

  it('includes exactly one custom-command launcher in both picker catalogs', () => {
    const descriptors = assemblePickerDescriptors();
    const detections = { cliTools: [], providers: [] };
    const plannerItems = buildPickerOptions('planner', descriptors, detections, undefined);
    const implementerItems = buildPickerOptions('implementer', descriptors, detections, undefined);

    expect(plannerItems.filter((item) => item.kind === 'custom-command')).toHaveLength(1);
    expect(implementerItems.filter((item) => item.kind === 'custom-command')).toHaveLength(1);
    expect(plannerItems.some((item) => item.id === 'shell' || item.id === 'agent')).toBe(false);
    expect(implementerItems.some((item) => item.id === 'shell' || item.id === 'agent')).toBe(false);
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

  it('maps a rejected env credential to unauthenticated with key-replacement remediation', () => {
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [
          makeImplementerDetection('openai', {
            available: false,
            hasKey: true,
            failure: 'invalid-credential',
          }),
        ],
      },
      undefined,
    );
    const openai = options.find((item) => item.id === 'openai');
    expect(openai?.status).toEqual({
      state: 'unauthenticated',
      remediation: 'Key found in OPENAI_API_KEY but openai rejected it.',
    });
    expect(openai?.available).toBe(false);
  });

  it.each(['offline', 'timeout', 'request-failed'] as const)(
    'keeps a present-key %s detection unavailable rather than unauthenticated',
    (failure) => {
      const options = buildPickerOptions(
        'planner',
        assemblePickerDescriptors(),
        {
          cliTools: [],
          providers: [
            makeImplementerDetection('openai', {
              available: false,
              hasKey: true,
              failure,
              error: 'openai is not currently reachable.',
            }),
          ],
        },
        undefined,
      );
      expect(options.find((item) => item.id === 'openai')?.status).toEqual({
        state: 'unavailable',
        remediation: 'openai is not currently reachable.',
      });
    },
  );

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

  it('keeps same-provider picker status role-scoped and surfaces typed guardrail remediation', () => {
    const detections = {
      cliTools: [],
      providers: [makeImplementerDetection('openrouter', { available: true, hasKey: true })],
      providerOutcomes: [
        scopedRuntime({ role: 'planner', provider: 'openrouter', state: 'fresh' }),
        scopedRuntime({
          role: 'implementer',
          provider: 'openrouter',
          state: 'failed',
          failure: 'guardrail-filtered',
        }),
      ],
    };

    const planner = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      detections,
      undefined,
    );
    const implementer = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      detections,
      undefined,
    );

    expect(planner.find((item) => item.id === 'openrouter')?.status).toEqual({
      state: 'ready',
      remediation: null,
    });
    expect(implementer.find((item) => item.id === 'openrouter')?.status).toEqual({
      state: 'unavailable',
      remediation:
        'openrouter guardrails filtered catalog access. Review provider policy and refresh detection.',
    });
  });

  it('does not borrow a generic ready provider detection when scoped outcomes are authoritative', () => {
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [makeImplementerDetection('openrouter', { available: true, hasKey: true })],
        providerOutcomes: [
          scopedRuntime({ role: 'planner', provider: 'anthropic', state: 'fresh' }),
        ],
        hasApiKeyOverride: () => false,
      },
      undefined,
    );

    expect(options.find((item) => item.id === 'openrouter')?.status.state).toBe('unauthenticated');
  });

  it('marks a role-scoped stale Agent SDK catalog unavailable instead of using ambient credential state', () => {
    const currentConfig = makeConfig({
      planner: {
        kind: 'agent-sdk',
        apiKey: 'sk-ant-picker-status',
        model: 'claude-sonnet-4-6',
      },
    }).planner;
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [],
        providerOutcomes: [
          scopedRuntime({ role: 'planner', provider: 'anthropic', state: 'stale' }),
        ],
        hasApiKeyOverride: () => true,
      },
      currentConfig,
    );

    expect(options.find((item) => item.id === 'agent-sdk')?.status).toEqual({
      state: 'unavailable',
      remediation: 'Last confirmed Agent SDK catalog is stale. Refresh detection.',
    });
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

  it('keeps the custom-command launcher always ready and selectable', () => {
    const options = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      { cliTools: [], providers: [] },
      undefined,
    );
    const launcher = options.find((item) => item.kind === 'custom-command');
    expect(launcher?.status.state).toBe('ready');
    expect(launcher?.available).toBe(true);
  });

  it('renders a non-active tool whose diagnostic is ready as selectable', () => {
    const options = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      { cliTools: [cliDetectionFor('ready', 'opencode')], providers: [] },
      undefined,
    );
    const opencode = options.find((item) => item.id === 'opencode');

    expect(opencode?.isCurrent).toBeUndefined();
    expect(opencode?.status).toEqual({ state: 'ready', remediation: null });
    expect(opencode?.available).toBe(true);
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
    if (ollama === undefined) throw new Error('no implementer picker row for ollama');
    const deepseek = options.find((item) => item.id === 'deepseek');
    if (deepseek === undefined) throw new Error('no implementer picker row for deepseek');
    expect(ollama.isCurrent).toBe(true);
    expect(ollama.status.state).toBe('unavailable');
    expect(ollama.status.remediation).toBe('Ollama is not running');

    expect(isCurrentConfig(ollama, config, 'implementer')).toBe(true);
    expect(isCurrentConfig(deepseek, config, 'implementer')).toBe(false);
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

describe('reviewer seat', () => {
  const descriptors = assemblePickerDescriptors();
  const detections = { cliTools: [], providers: [] };

  function reviewerRow(id: string): PickerOption {
    const row = buildPickerOptions('reviewer', descriptors, detections, undefined).find(
      (item) => item.id === id,
    );
    if (row === undefined) throw new Error(`no reviewer picker row for ${id}`);
    return row;
  }

  it('offers the reviewer the same catalog as the planner', () => {
    expect(
      buildPickerOptions('reviewer', descriptors, detections, undefined).map((item) => item.id),
    ).toEqual(
      buildPickerOptions('planner', descriptors, detections, undefined).map((item) => item.id),
    );
  });

  it('marks the current reviewer row from the reviewer config, not the planner config', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      reviewer: { kind: 'cli', tool: 'codex' },
    });

    expect(isCurrentConfig(reviewerRow('codex'), config, 'reviewer')).toBe(true);
    expect(isCurrentConfig(reviewerRow('claude-code'), config, 'reviewer')).toBe(false);
  });

  it('does not report the planner probe verdict on the review seat', () => {
    const scoped = {
      cliTools: [],
      providers: [makeImplementerDetection('openrouter', { available: true, hasKey: true })],
      providerOutcomes: [
        scopedRuntime({
          role: 'planner',
          provider: 'openrouter',
          state: 'failed',
          failure: 'guardrail-filtered',
        }),
      ],
    };
    const rowFor = (role: 'planner' | 'reviewer') =>
      buildPickerOptions(role, descriptors, scoped, undefined).find(
        (item) => item.id === 'openrouter',
      );

    expect(rowFor('planner')?.status.state).toBe('unavailable');
    expect(rowFor('reviewer')?.status).not.toEqual(rowFor('planner')?.status);
    expect(rowFor('reviewer')?.status).toEqual({ state: 'ready', remediation: null });
  });

  it('marks the planner row current when no reviewer is configured', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    expect(isCurrentConfig(reviewerRow('claude-code'), config, 'reviewer')).toBe(true);
  });
});
