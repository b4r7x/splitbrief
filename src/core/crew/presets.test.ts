import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type { CliToolId } from '../runners/cli-tool-catalog.js';
import { computeCrewPresets } from './presets.js';

function readyDetection(readyTools: readonly CliToolId[]) {
  return { cliTools: readyTools.map((tool) => cliDetectionFor('ready', tool)), providers: [] };
}

function notReadyOf(readyTools: readonly CliToolId[]) {
  return Object.fromEntries(
    computeCrewPresets({ config: makeConfig(), detection: readyDetection(readyTools) }).map(
      (preset) => [preset.id, preset.notReady],
    ),
  );
}

describe('computeCrewPresets', () => {
  it('marks a preset whose every seat is installed and authenticated as ready', () => {
    expect(notReadyOf(['claude-code', 'codex'])['claude-crew-codex-review']).toEqual([]);
  });

  it('keeps a preset whose tool is not ready and names that tool once', () => {
    expect(notReadyOf(['claude-code'])).toEqual({
      'claude-crew-codex-review': ['codex'],
      'codex-crew-claude-review': ['codex'],
      'claude-plan-opencode-build': ['opencode'],
    });
  });

  it('keeps every preset when no tool is ready', () => {
    expect(notReadyOf([])).toEqual({
      'claude-crew-codex-review': ['claude-code', 'codex'],
      'codex-crew-claude-review': ['codex', 'claude-code'],
      'claude-plan-opencode-build': ['claude-code', 'opencode'],
    });
  });

  it('carries the concrete seat assignments a preset would write', () => {
    const [preset] = computeCrewPresets({
      config: makeConfig({ planner: { kind: 'shell', command: 'my-planner' } }),
      detection: readyDetection(['claude-code', 'codex']),
    });

    expect(preset?.seats).toEqual({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code' },
      reviewer: { kind: 'cli', tool: 'codex' },
    });
    expect(preset?.description.length).toBeGreaterThan(0);
  });

  it('keeps a seat runner intact when the preset names the tool it already uses', () => {
    const [preset] = computeCrewPresets({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', authChannel: 'api-key', model: 'opus' },
        reviewer: { kind: 'cli', tool: 'codex', effort: 'high' },
      }),
      detection: readyDetection(['claude-code', 'codex']),
    });

    expect(preset?.seats.planner).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      authChannel: 'api-key',
      model: 'opus',
    });
    expect(preset?.seats.reviewer).toEqual({ kind: 'cli', tool: 'codex', effort: 'high' });
  });

  it('keeps the default implementer profile intact when the preset names its tool', () => {
    const [preset] = computeCrewPresets({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code' },
        implementerProfiles: {
          default: 'cheap',
          profiles: {
            cheap: {
              kind: 'cli',
              tool: 'opencode',
              model: 'qwen3-coder',
              label: 'Cheap build',
            },
          },
        },
      }),
      detection: readyDetection(['claude-code', 'opencode']),
    }).filter((entry) => entry.id === 'claude-plan-opencode-build');

    expect(preset?.seats.implementer).toEqual({
      kind: 'cli',
      tool: 'opencode',
      model: 'qwen3-coder',
    });
  });

  it('leaves the review seat inherited when the preset plans and reviews with one tool', () => {
    const planner = {
      kind: 'cli',
      tool: 'claude-code',
      model: 'opus',
      effort: 'high',
    } as const;
    const [preset] = computeCrewPresets({
      config: makeConfig({ planner, reviewer: { kind: 'cli', tool: 'codex' } }),
      detection: readyDetection(['claude-code', 'opencode']),
    }).filter((entry) => entry.id === 'claude-plan-opencode-build');

    expect(preset?.seats.reviewer).toBeUndefined();
    expect(preset?.seats.planner).toEqual(planner);
  });

  it.each([
    ['a kept seat on a route its model list serves', 'ollama-cloud/glm-5.3', []],
    ['a seat with no model, so no route', undefined, ['opencode']],
  ])(
    'reads an OpenCode that stores no credential by the seat rule: %s',
    (_case, model, notReady) => {
      const [preset] = computeCrewPresets({
        config: makeConfig({
          planner: { kind: 'cli', tool: 'claude-code' },
          implementer: { kind: 'cli', tool: 'opencode', ...(model === undefined ? {} : { model }) },
        }),
        detection: {
          cliTools: [
            cliDetectionFor('ready', 'claude-code'),
            cliDetectionFor('unauthenticated', 'opencode', { providerAuth: { kind: 'empty' } }),
          ],
          providers: [],
          cliCatalog: () => ({ models: [{ id: 'ollama-cloud/glm-5.3' }] }),
        },
      }).filter((entry) => entry.id === 'claude-plan-opencode-build');

      expect(preset?.notReady).toEqual(notReady);
    },
  );

  /** OpenCode stores no credential, selects `ollama/llama3` in its own config, and its list serves it. */
  function configOnlyOpencode() {
    return {
      cliTools: [
        cliDetectionFor('ready', 'claude-code'),
        {
          ...cliDetectionFor('unauthenticated', 'opencode', { providerAuth: { kind: 'empty' } }),
          selectedModel: 'ollama/llama3',
        },
      ],
      providers: [],
      cliCatalog: () => ({ models: [{ id: 'ollama/llama3' }] }),
    };
  }

  it.each([
    ['on auto', { model: 'auto' }],
    ['with no model', {}],
  ])("reads a kept OpenCode seat %s by the model the tool's own config selects", (_case, model) => {
    const [preset] = computeCrewPresets({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'opencode', ...model },
      }),
      detection: configOnlyOpencode(),
    }).filter((entry) => entry.id === 'claude-plan-opencode-build');

    expect(preset?.notReady).toEqual([]);
  });

  it('keeps a seat the preset makes for an OpenCode that stores no credential not ready', () => {
    const [preset] = computeCrewPresets({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'codex' },
      }),
      detection: configOnlyOpencode(),
    }).filter((entry) => entry.id === 'claude-plan-opencode-build');

    expect(preset?.notReady).toEqual(['opencode']);
  });

  it('replaces a seat runner whose tool the preset changes', () => {
    const [preset] = computeCrewPresets({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key', model: 'gpt-5' },
      }),
      detection: readyDetection(['claude-code', 'codex']),
    });

    expect(preset?.seats.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
  });
});
