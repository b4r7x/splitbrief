import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { computeCrewPresets } from './presets.js';

describe('computeCrewPresets', () => {
  it('offers a preset whose every seat is installed and authenticated', () => {
    const presets = computeCrewPresets({
      config: makeConfig(),
      readyTools: ['claude-code', 'codex'],
    });

    expect(presets.map((preset) => preset.id)).toContain('claude-crew-codex-review');
  });

  it('withholds a preset whose tool is not installed', () => {
    const presets = computeCrewPresets({
      config: makeConfig(),
      readyTools: ['claude-code'],
    });

    expect(presets.map((preset) => preset.id)).not.toContain('claude-crew-codex-review');
  });

  it('returns nothing when no tool is available', () => {
    expect(computeCrewPresets({ config: makeConfig(), readyTools: [] })).toEqual([]);
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
              costTier: 'cheap',
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
