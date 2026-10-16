import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { computeCrewPresets } from './presets.js';

function notReadyOf(readyTools: Parameters<typeof computeCrewPresets>[0]['readyTools']) {
  return Object.fromEntries(
    computeCrewPresets({ config: makeConfig(), readyTools }).map((preset) => [
      preset.id,
      preset.notReady,
    ]),
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
      readyTools: ['claude-code', 'codex'],
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
      readyTools: ['claude-code', 'codex'],
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
      readyTools: ['claude-code', 'opencode'],
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
      readyTools: ['claude-code', 'opencode'],
    }).filter((entry) => entry.id === 'claude-plan-opencode-build');

    expect(preset?.seats.reviewer).toBeUndefined();
    expect(preset?.seats.planner).toEqual(planner);
  });

  it('replaces a seat runner whose tool the preset changes', () => {
    const [preset] = computeCrewPresets({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key', model: 'gpt-5' },
      }),
      readyTools: ['claude-code', 'codex'],
    });

    expect(preset?.seats.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
  });
});
