import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { buildRunnerChecks } from '../../readiness/checks/runners.js';
import type { Config } from '../../schemas/config.js';
import { createDefaultConfig } from '../load/defaults.js';
import { resolveEffectiveConfig } from './effective-config.js';

describe('resolveEffectiveConfig', () => {
  it('rejects {prompt} in a command runner argument', () => {
    const base = {
      ...createDefaultConfig(),
      implementer: {
        kind: 'shell' as const,
        command: 'local-implementer',
        args: ['--prompt', '{prompt}'],
        model: 'custom-model',
      },
    };

    expect(() => resolveEffectiveConfig({ base })).toThrow(
      '{prompt} is not supported; SPLITBRIEF sends the prompt on stdin',
    );
  });

  it('returns the loader diagnostics as its warnings after an override', () => {
    const { config, warnings } = resolveEffectiveConfig({
      base: makeConfig(),
      overrides: {
        implementer: {
          tool: 'ollama',
          model: 'qwen2.5-coder:7b',
          apiBase: 'http://localhost:11434/v1',
        },
      },
      loaderDiagnostics: [{ kind: 'config-file-permissions' }],
    });

    expect(config.implementer).toMatchObject({ kind: 'api', provider: 'ollama' });
    expect(warnings).toEqual([{ kind: 'config-file-permissions' }]);
  });

  it('rejects invalid overrides after merge', () => {
    const base = createDefaultConfig();
    expect(() =>
      resolveEffectiveConfig({
        base,
        overrides: { contextLength: -1 },
      }),
    ).toThrow(/contextLength/);
  });

  it('applies implementer model override before validation', () => {
    const base = createDefaultConfig();
    const { config } = resolveEffectiveConfig({
      base,
      overrides: { implementer: { model: 'deepseek-chat' } },
    });

    expect(config.implementer).toMatchObject({ model: 'deepseek-chat' });
  });

  const notApplied = (config: Config) =>
    buildRunnerChecks({ config, seatImageFact: () => undefined }).filter((check) =>
      check.id.endsWith('-not-applied'),
    );

  it('names an effort flag that the seat does not apply as ignored and keeps it out of the config', () => {
    const { config, warnings } = resolveEffectiveConfig({
      base: makeConfig({
        planner: { kind: 'cli', tool: 'opencode' },
        reviewer: { kind: 'shell', command: 'node', model: 'test' },
      }),
      overrides: { plannerEffort: 'high', reviewerEffort: 'low' },
    });

    expect(warnings).toEqual([
      {
        kind: 'ignored-flag',
        notice: '--planner-effort is ignored: the OpenCode CLI variant sets the effort.',
        fix: 'Remove the flag from the command.',
      },
      {
        kind: 'ignored-flag',
        notice: '--reviewer-effort is ignored: Custom Shell has no effort channel.',
        fix: 'Remove the flag from the command.',
      },
    ]);
    expect(config.planner.effort).toBeUndefined();
    expect(config.reviewer).not.toHaveProperty('effort');
    expect(notApplied(config)).toEqual([]);
  });

  it('applies an effort flag to a seat whose tool takes an effort, with no notice', () => {
    const { config, warnings } = resolveEffectiveConfig({
      base: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
      overrides: { plannerEffort: 'high' },
    });

    expect(warnings).toEqual([]);
    expect(config.planner.effort).toBe('high');
    expect(notApplied(config)).toEqual([]);
  });
});
