import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { CLI_READINESS_STATES, type ProviderDetection } from '../../../core/discovery/detection.js';
import {
  IMPLEMENTER_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
} from '../../../core/providers/api-provider-catalog.js';
import {
  CLI_TOOL_CATALOG,
  IMPLEMENTER_CLI_TOOL_IDS,
  isListedCliTool,
  LISTED_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../core/runners/cli-tool-catalog.js';
import { SEAT_PICKER_ROLES } from '../../../core/runners/seat-roles.js';
import { isCurrentRunner } from './catalog.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
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
  provider: 'ollama' | 'lm-studio';
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
        makeImplementerDetection('lm-studio', { available: true, isLocal: true }),
        makeImplementerDetection('ollama', { available: true, isLocal: true }),
      ],
      hasApiKeyOverride: () => false,
    };

    const plannerItems = buildPickerOptions('planner', descriptors, detections, undefined);
    const implementerItems = buildPickerOptions('implementer', descriptors, detections, undefined);

    const plannerIds = plannerItems.map((item) => item.id);
    const implementerIds = implementerItems.map((item) => item.id);

    expect(plannerIds).toEqual(
      expect.arrayContaining([
        'custom-command',
        ...PLANNER_CLI_TOOL_IDS.filter(isListedCliTool),
        ...PLANNER_API_PROVIDER_IDS,
      ]),
    );
    expect(implementerIds).toEqual(
      expect.arrayContaining([
        'custom-command',
        ...IMPLEMENTER_CLI_TOOL_IDS.filter(isListedCliTool),
        ...IMPLEMENTER_API_PROVIDER_IDS,
      ]),
    );
    expect(plannerIds).toContain('ollama');
    expect(plannerIds).toContain('lm-studio');
    expect(implementerIds).toContain('ollama');
    expect(implementerIds).toContain('lm-studio');
    expect(plannerItems.every((item) => item.roles.includes('planner'))).toBe(true);
    expect(implementerItems.every((item) => item.roles.includes('implementer'))).toBe(true);
  });

  it('offers a Cursor row in all three seat roles', () => {
    const descriptors = assemblePickerDescriptors();
    const detections = { cliTools: [], providers: [] };

    for (const role of SEAT_PICKER_ROLES) {
      const cursor = buildPickerOptions(role, descriptors, detections, undefined).find(
        (item) => item.id === 'cursor',
      );
      if (cursor === undefined) throw new Error(`no ${role} picker row for cursor`);
      expect(cursor.kind).toBe('cli');
      expect(cursor.displayName).toBe(CLI_TOOL_CATALOG.cursor.displayName);
      expect(cursor.modelCapability.showsDiscovered).toBe(true);
    }
  });

  it('offers no Copilot row in any seat role', () => {
    const descriptors = assemblePickerDescriptors();
    const detections = { cliTools: [], providers: [] };

    for (const role of SEAT_PICKER_ROLES) {
      const ids = buildPickerOptions(role, descriptors, detections, undefined).map(
        (item) => item.id,
      );
      expect(ids, role).not.toContain('copilot');
    }
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

describe('effort channel projection', () => {
  const descriptors = assemblePickerDescriptors();
  const detections = { cliTools: [], providers: [] };

  function seatRow(role: 'planner' | 'implementer', id: string): PickerOption {
    const row = buildPickerOptions(role, descriptors, detections, undefined).find(
      (item) => item.id === id,
    );
    if (row === undefined) throw new Error(`no ${role} picker row for ${id}`);
    return row;
  }

  it("names the opencode option's variant channel", () => {
    expect(seatRow('planner', 'opencode').effortChannel).toBe('variant');
  });

  it("names the cursor option's model-id channel", () => {
    expect(seatRow('planner', 'cursor').effortChannel).toBe('model-id');
  });

  it("names the codex option's effort-flag channel", () => {
    expect(seatRow('planner', 'codex').effortChannel).toBe('effort-flag');
  });

  it('gives an api provider no channel', () => {
    expect(seatRow('implementer', 'ollama').effortChannel).toBeUndefined();
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

  it.each(['missing-credential', 'invalid-credential'] as const)(
    'maps a %s provider outcome to unauthenticated',
    (failure) => {
      const options = buildPickerOptions(
        'implementer',
        assemblePickerDescriptors(),
        {
          cliTools: [],
          providers: [makeImplementerDetection('lm-studio', { available: false })],
          providerOutcomes: [
            scopedRuntime({
              role: 'implementer',
              provider: 'lm-studio',
              state: 'failed',
              failure,
            }),
          ],
        },
        undefined,
      );
      const lmStudio = options.find((item) => item.id === 'lm-studio');
      expect(lmStudio?.status).toEqual({
        state: 'unauthenticated',
        remediation:
          failure === 'missing-credential'
            ? 'Configure credentials and refresh detection.'
            : 'lm-studio rejected the configured key.',
      });
      expect(lmStudio?.available).toBe(false);
    },
  );

  it.each(['offline', 'timeout', 'request-failed'] as const)(
    'keeps a present-key %s outcome unavailable rather than unauthenticated',
    (failure) => {
      const options = buildPickerOptions(
        'implementer',
        assemblePickerDescriptors(),
        {
          cliTools: [],
          providers: [],
          providerOutcomes: [
            scopedRuntime({
              role: 'implementer',
              provider: 'lm-studio',
              state: 'failed',
              failure,
            }),
          ],
          hasApiKeyOverride: () => true,
        },
        undefined,
      );
      expect(options.find((item) => item.id === 'lm-studio')?.status).toEqual({
        state: 'unavailable',
        remediation: 'lm-studio is not currently reachable.',
      });
    },
  );

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
      'implementer',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [makeImplementerDetection('ollama', { available: true })],
      },
      undefined,
    );
    const ollama = options.find((item) => item.id === 'ollama');
    expect(ollama?.status).toEqual({ state: 'ready', remediation: null });
    expect(ollama?.available).toBe(true);
  });

  it('scopes a provider outcome to the seat that produced it and surfaces typed guardrail remediation', () => {
    const detections = {
      cliTools: [],
      providers: [makeImplementerDetection('ollama', { available: true, hasKey: true })],
      providerOutcomes: [
        scopedRuntime({ role: 'planner', provider: 'ollama', state: 'fresh' }),
        scopedRuntime({
          role: 'implementer',
          provider: 'ollama',
          state: 'failed',
          failure: 'guardrail-filtered',
        }),
      ],
    };

    const implementer = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      detections,
      undefined,
    );

    expect(implementer.find((item) => item.id === 'ollama')?.status).toEqual({
      state: 'unavailable',
      remediation:
        'ollama guardrails filtered catalog access. Review provider policy and refresh detection.',
    });
  });

  it('does not borrow a generic ready provider detection when scoped outcomes are authoritative', () => {
    const options = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      {
        cliTools: [],
        providers: [makeImplementerDetection('ollama', { available: true, hasKey: true })],
        providerOutcomes: [
          scopedRuntime({ role: 'implementer', provider: 'lm-studio', state: 'fresh' }),
        ],
        hasApiKeyOverride: () => false,
      },
      undefined,
    );

    expect(options.find((item) => item.id === 'ollama')?.status).toEqual({
      state: 'unavailable',
      remediation: 'Start ollama and refresh detection.',
    });
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
        provider: 'custom-endpoint',
        apiBase: 'https://api.example.com/v1',
        model: 'custom-endpoint-model',
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
    const lmStudio = options.find((item) => item.id === 'lm-studio');
    if (lmStudio === undefined) throw new Error('no implementer picker row for lm-studio');
    expect(ollama.isCurrent).toBe(true);
    expect(ollama.status.state).toBe('unavailable');
    expect(ollama.status.remediation).toBe('Ollama is not running');

    expect(isCurrentRunner(ollama, readActiveRunner({ config, role: 'implementer' }))).toBe(true);
    expect(isCurrentRunner(lmStudio, readActiveRunner({ config, role: 'implementer' }))).toBe(
      false,
    );
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

  it('never marks a CLI row current for an API seat that reuses its id', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'opencode',
        service: 'opencode',
        offering: 'payg',
        apiBase: 'https://my-endpoint.example/v1',
        apiKey: 'sk-inline',
        model: 'gpt-5',
      },
    });
    const options = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      { cliTools: [cliDetectionFor('ready', 'opencode')], providers: [] },
      config.implementer,
    );
    const cliRow = options.find((item) => item.id === 'opencode');
    if (cliRow === undefined) throw new Error('no implementer picker row for opencode');

    expect(cliRow.kind).toBe('cli');
    expect(cliRow.isCurrent).toBeUndefined();
    expect(isCurrentRunner(cliRow, readActiveRunner({ config, role: 'implementer' }))).toBe(false);
  });

  it('keeps a CLI row current for the CLI seat of the same name', () => {
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } });
    const options = buildPickerOptions(
      'implementer',
      assemblePickerDescriptors(),
      { cliTools: [], providers: [] },
      config.implementer,
    );
    const cliRow = options.find((item) => item.id === 'opencode');
    if (cliRow === undefined) throw new Error('no implementer picker row for opencode');

    expect(cliRow.isCurrent).toBe(true);
    expect(isCurrentRunner(cliRow, readActiveRunner({ config, role: 'implementer' }))).toBe(true);
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

  it('offers every planner-tier API provider to the reviewer', () => {
    const apiRows = buildPickerOptions('reviewer', descriptors, detections, undefined)
      .filter((item) => item.kind === 'api')
      .map((item) => item.id);

    expect(PLANNER_API_PROVIDER_IDS.length).toBeGreaterThan(0);
    expect(apiRows.toSorted()).toEqual([...PLANNER_API_PROVIDER_IDS].toSorted());
  });

  it('marks the current reviewer row from the reviewer config, not the planner config', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      reviewer: { kind: 'cli', tool: 'codex' },
    });

    expect(
      isCurrentRunner(reviewerRow('codex'), readActiveRunner({ config, role: 'reviewer' })),
    ).toBe(true);
    expect(
      isCurrentRunner(reviewerRow('claude-code'), readActiveRunner({ config, role: 'reviewer' })),
    ).toBe(false);
  });

  it('marks the planner row current when no reviewer is configured', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    expect(
      isCurrentRunner(reviewerRow('claude-code'), readActiveRunner({ config, role: 'reviewer' })),
    ).toBe(true);
  });
});

describe('tool order', () => {
  const descriptors = assemblePickerDescriptors();
  const detections = {
    cliTools: LISTED_CLI_TOOL_IDS.map((id) => {
      if (id === 'codex') return cliDetectionFor('ready', id);
      if (id === 'claude-code') return cliDetectionFor('unauthenticated', id);
      if (id === 'kilo-code') return cliDetectionFor('unverified', id);
      return cliDetectionFor('unavailable', id);
    }),
    providers: [
      makeImplementerDetection('ollama', { available: true, isLocal: true }),
      makeImplementerDetection('lm-studio', { available: false, isLocal: true }),
      makeImplementerDetection('llama-cpp', { available: false, isLocal: true }),
    ],
  };
  const emptyDetections = { cliTools: [], providers: [] };

  function toolOrderIds(options: readonly PickerOption[], filterActive: boolean): string[] {
    const name = new Map(options.map((item) => [item.id, item.displayName]));
    const local = ['llama-cpp', 'lm-studio'].toSorted((left, right) =>
      (name.get(left) ?? left).localeCompare(name.get(right) ?? right),
    );
    const body = [
      'codex',
      'claude-code',
      'kilo-code',
      'command-code',
      'cursor',
      'antigravity',
      'opencode',
      'ollama',
      ...local,
    ];
    return filterActive ? [...body, 'custom-command'] : ['custom-command', ...body];
  }

  it('orders an idle tool list by group and readiness', () => {
    for (const role of SEAT_PICKER_ROLES) {
      const options = buildPickerOptions(role, descriptors, detections, undefined);
      expect(options.find((item) => item.id === 'codex')?.status.state).toBe('ready');
      expect(options.find((item) => item.id === 'claude-code')?.status.state).toBe(
        'unauthenticated',
      );
      expect(options.find((item) => item.id === 'kilo-code')?.status.state).toBe('unverified');
      expect(options.find((item) => item.id === 'cursor')?.status.state).toBe('unavailable');
      expect(options.find((item) => item.id === 'ollama')?.status.state).toBe('ready');
      expect(options.find((item) => item.id === 'lm-studio')?.status.state).toBe('unavailable');
      expect(options.map((item) => item.id)).toEqual(toolOrderIds(options, false));
    }
  });

  it('orders a filtered tool list by the same groups with the launcher last', () => {
    for (const role of SEAT_PICKER_ROLES) {
      const options = buildPickerOptions(role, descriptors, detections, undefined, {
        filterActive: true,
      });
      expect(options.map((item) => item.id)).toEqual(toolOrderIds(options, true));
    }
  });

  it('leaves a not-ready current row in its tier while filtering', () => {
    const options = buildPickerOptions('planner', descriptors, detections, makeConfig().planner, {
      filterActive: true,
    });
    const ids = options.map((item) => item.id);
    const claude = options.find((item) => item.id === 'claude-code');
    expect(claude?.isCurrent).toBe(true);
    expect(claude?.status.state).toBe('unauthenticated');
    expect(ids).toEqual(toolOrderIds(options, true));
    expect(ids.indexOf('codex')).toBeLessThan(ids.indexOf('claude-code'));
    expect(ids.indexOf('claude-code')).toBeLessThan(ids.indexOf('cursor'));
  });

  it('launcher first when filter is empty', () => {
    for (const role of SEAT_PICKER_ROLES) {
      const options = buildPickerOptions(role, descriptors, emptyDetections, undefined);
      expect(options[0]?.kind).toBe('custom-command');
    }
  });

  it('launcher last while filtering', () => {
    for (const role of SEAT_PICKER_ROLES) {
      const options = buildPickerOptions(role, descriptors, emptyDetections, undefined, {
        filterActive: true,
      });
      expect(options.at(-1)?.kind).toBe('custom-command');
    }
  });
});
