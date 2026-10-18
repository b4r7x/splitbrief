import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import { detectedSeatReady } from '../../core/crew/default.js';
import type { Config } from '../../core/schemas/config.js';
import { createProductionDetectionDeps } from './deps.js';
import { checkCrewAvailability, crewDetectionForSeat, selectDetectedDefaultCrew } from './crew.js';
import { probeRunnerAvailability } from '../runners/probe-availability.js';

afterEach(() => vi.unstubAllGlobals());

/** OpenCode with a provider set up only in its config: `opencode auth list` prints []. */
function noCredentialOpencode(ids: readonly string[] | undefined) {
  return {
    cliTools: [
      cliDetectionFor('ready', 'claude-code'),
      cliDetectionFor('unauthenticated', 'opencode', { providerAuth: { kind: 'empty' } }),
    ],
    providers: [],
    cliCatalog: (tool: string) =>
      tool === 'opencode' && ids !== undefined ? { models: ids.map((id) => ({ id })) } : undefined,
  };
}

function detectionFor(config: Config) {
  const { sourceContexts } = createProductionDetectionDeps({ config, projectDir: '/project' });
  return {
    cliTools: [cliDetectionFor('ready', 'claude-code')],
    providers: [],
    providerOutcomes: sourceContexts.configuredProviders?.map((connection) => ({
      connection,
      state: 'fresh' as const,
      catalog: 'populated' as const,
      models: [{ id: 'installed-coder' }],
      fetchedAt: 1,
      validatedAt: 1,
    })),
  };
}

describe('detected default crew connections', () => {
  it('uses the planner connection when the review seat returns to the planner', async () => {
    const configured = makeConfig({
      planner: {
        kind: 'api',
        provider: 'lm-studio',
        apiBase: 'http://localhost:1234/v1',
        apiKey: 'inline-test-key',
        model: 'installed-coder',
      },
      reviewer: { kind: 'cli', tool: 'codex' },
      implementer: { kind: 'cli', tool: 'claude-code' },
    });
    const detection = detectionFor(configured);
    const { reviewer: _reviewer, ...inherited } = configured;
    const fetch = vi.fn(async () => {
      throw new Error('An exact planner catalog is already available');
    });
    vi.stubGlobal('fetch', fetch);
    expect(await checkCrewAvailability({ config: inherited, detection })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'checks the selected build profile instead of the first API profile, default ready=%s',
    async (defaultReady) => {
      const runner = {
        kind: 'api' as const,
        provider: 'custom-api',
        apiBase: 'https://custom.example.test/v1',
        apiKey: 'inline-test-key',
      };
      const config = makeConfig({
        implementerProfiles: {
          default: 'z-default',
          profiles: {
            'a-alternate': {
              ...runner,
              model: defaultReady ? 'missing-model' : 'listed-model',
            },
            'z-default': {
              ...runner,
              model: defaultReady ? 'listed-model' : 'missing-model',
            },
          },
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ data: [{ id: 'listed-model' }] })),
      );
      const unavailable = await checkCrewAvailability({
        config,
        detection: { cliTools: [cliDetectionFor('ready', 'claude-code')], providers: [] },
      });
      expect(unavailable.map((seat) => seat.id)).toEqual(defaultReady ? [] : ['build']);
    },
  );
  it.each(['planner', 'implementer', 'reviewer'] as const)(
    'uses the existing API probe for a custom %s connection and checks model membership',
    async (role) => {
      const runner = {
        kind: 'api' as const,
        provider: 'custom-api',
        apiBase: 'https://custom.example.test/v1',
        apiKey: 'inline-test-key',
        model: 'custom-coder',
      };
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code' },
        [role]: runner,
      });
      const detection = { cliTools: [cliDetectionFor('ready', 'claude-code')], providers: [] };
      for (const listed of [true, false]) {
        const fetch = vi.fn(async () =>
          Response.json({ data: [{ id: listed ? 'custom-coder' : 'another-model' }] }),
        );
        vi.stubGlobal('fetch', fetch);
        const availability = await probeRunnerAvailability({ config });
        expect(availability.every((fact) => fact.verdict.state === 'available')).toBe(listed);
        const unavailable = await checkCrewAvailability({ config, detection });
        expect(unavailable.length === 0).toBe(listed);
        expect(fetch).toHaveBeenCalledWith(
          expect.stringContaining('/v1/models'),
          expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer inline-test-key' }),
          }),
        );
      }
    },
  );
  it('keeps an inline credential connection ready when the selected model changes', () => {
    const keyed = makeConfig({
      implementer: {
        provider: 'lm-studio',
        apiBase: 'http://localhost:1234/v1',
        apiKey: 'local-key',
      },
    });
    if (keyed.implementer.kind !== 'api') throw new Error('Expected an API seat');
    const detection = detectionFor(keyed);
    const selected = {
      ...keyed,
      implementer: { ...keyed.implementer, model: 'installed-coder' },
    };
    expect(
      detectedSeatReady(
        selected.implementer,
        crewDetectionForSeat({ config: selected, role: 'implementer', detection }),
      ),
    ).toBe(true);
    const changedKey = {
      ...selected,
      implementer: { ...selected.implementer, apiKey: 'replacement-key' },
    };
    expect(
      detectedSeatReady(
        changedKey.implementer,
        crewDetectionForSeat({ config: changedKey, role: 'implementer', detection }),
      ),
    ).toBe(false);
  });

  it('uses a default endpoint catalog after selecting a different model', () => {
    const detection = detectionFor(createDefaultConfig());
    const selected = selectDetectedDefaultCrew(detection);
    if (selected === null) throw new Error('Expected a ready crew');
    expect(selected.implementer).toMatchObject({ kind: 'api', model: 'installed-coder' });
    expect(
      detectedSeatReady(
        selected.implementer,
        crewDetectionForSeat({ config: selected, role: 'implementer', detection }),
      ),
    ).toBe(true);
  });

  it.each([
    { apiBase: 'http://127.0.0.1:12434/v1' },
    { apiBase: 'http://localhost:11434/other/v1' },
  ])('keeps a different connection out of the persisted proposal: %s', (connection) => {
    const config = createDefaultConfig();
    if (config.implementer.kind !== 'api') throw new Error('Expected the default API seat');
    const detection = detectionFor({
      ...config,
      implementer: { ...config.implementer, ...connection, model: 'custom-coder' },
    });
    expect(selectDetectedDefaultCrew(detection)?.implementer).toEqual({
      kind: 'cli',
      tool: 'claude-code',
    });
    expect(
      detectedSeatReady(
        { ...config.implementer, model: 'installed-coder' },
        crewDetectionForSeat({ config, role: 'implementer', detection }),
      ),
    ).toBe(false);
  });

  it.each([
    ['a model its model list serves', 'ollama/llama3', ['ollama/llama3'], []],
    ['a model its model list does not serve', 'ollama-cloud/glm-5', ['ollama/llama3'], ['build']],
    ['a model list that was not read', 'ollama/llama3', undefined, ['build']],
  ])(
    'reads an OpenCode build seat that stores no credential on %s as start does',
    async (_case, model, ids, unavailable) => {
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'opencode', model },
      });

      const seats = await checkCrewAvailability({ config, detection: noCredentialOpencode(ids) });

      expect(seats.map((seat) => seat.id)).toEqual(unavailable);
    },
  );

  it.each([
    ['on auto', { model: 'auto' }],
    ['with no model', {}],
  ])(
    "reads an OpenCode build seat %s by the model the tool's own config selects",
    async (_case, model) => {
      const detection = noCredentialOpencode(['ollama/llama3']);
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'opencode', ...model },
      });

      expect(
        await checkCrewAvailability({
          config,
          detection: {
            ...detection,
            cliTools: detection.cliTools.map((tool) =>
              tool.tool === 'opencode' ? { ...tool, selectedModel: 'ollama/llama3' } : tool,
            ),
          },
        }),
      ).toEqual([]);
    },
  );

  it('uses ambient detection only for the default connection', () => {
    const config = createDefaultConfig();
    if (config.implementer.kind !== 'api') throw new Error('Expected the default API seat');
    const detection = {
      cliTools: [cliDetectionFor('ready', 'claude-code')],
      providers: [
        {
          provider: 'ollama' as const,
          available: true,
          isLocal: true,
          models: [{ id: 'installed-coder' }],
        },
      ],
    };
    expect(selectDetectedDefaultCrew(detection)?.implementer).toMatchObject({
      kind: 'api',
      model: 'installed-coder',
      apiBase: 'http://localhost:11434/v1',
    });
    const custom = {
      ...config,
      implementer: { ...config.implementer, apiBase: 'http://127.0.0.1:12434/v1' },
    };
    expect(
      crewDetectionForSeat({ config: custom, role: 'implementer', detection }).providers,
    ).toEqual([]);
  });
});
