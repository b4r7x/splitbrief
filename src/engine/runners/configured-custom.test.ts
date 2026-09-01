import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import type { CustomCommandDefinition } from '../../core/config/custom-commands.js';
import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import { resolveConfiguredCustomRunner } from './configured-custom.js';

function commandDefinition(contract: 'output' | 'direct', label: string): CustomCommandDefinition {
  return {
    label,
    contract,
    executable: process.execPath,
    argv: [`--${contract}`],
    outputFormat: 'jsonl',
    idleWarnMs: 4_000,
    idleKillMs: 8_000,
    env: ['CUSTOM_ALPHA', 'CUSTOM_BETA'],
  };
}

function configWithConfiguredCommands(): Config {
  const planner = commandDefinition('output', 'Configured planner');
  const implementer = commandDefinition('direct', 'Configured implementer');

  return ConfigSchema.parse({
    ...createDefaultConfig(),
    planner: {
      kind: 'shell',
      command: planner.executable,
      args: planner.argv,
      outputFormat: planner.outputFormat,
      idleWarnMs: planner.idleWarnMs,
      idleKillMs: planner.idleKillMs,
      env: [...(planner.env ?? [])].reverse(),
    },
    implementer: {
      kind: 'agent',
      command: process.execPath,
      args: ['--legacy-top-level'],
      model: 'legacy-model',
    },
    implementerProfiles: {
      default: 'configured-profile',
      profiles: {
        'configured-profile': {
          kind: 'agent',
          command: implementer.executable,
          args: implementer.argv,
          outputFormat: implementer.outputFormat,
          idleWarnMs: implementer.idleWarnMs,
          idleKillMs: implementer.idleKillMs,
          env: [...(implementer.env ?? [])].reverse(),
          model: 'configured-model',
        },
      },
    },
    customCommands: {
      'planner-stable-id': planner,
      'implementer-stable-id': implementer,
    },
  });
}

describe('resolveConfiguredCustomRunner', () => {
  it('recovers configured stable IDs from the active planner and default implementer profile', () => {
    const config = configWithConfiguredCommands();

    expect(resolveConfiguredCustomRunner(config, 'planner')).toMatchObject({
      source: 'configured',
      command: { id: 'planner-stable-id', contract: 'output' },
    });
    expect(resolveConfiguredCustomRunner(config, 'implementer')).toMatchObject({
      source: 'configured',
      command: { id: 'implementer-stable-id', contract: 'direct' },
    });
  });

  it('returns null for every nonmatching execution tuple field', () => {
    const base = configWithConfiguredCommands();
    const mismatches = [
      { kind: 'agent', command: process.execPath, args: ['--output'] },
      { command: '/different/executable' },
      { args: ['--different-argv'] },
      { outputFormat: 'text' },
      { idleWarnMs: 4_001 },
      { idleKillMs: 8_001 },
      { env: ['CUSTOM_ALPHA'] },
    ];

    for (const mismatch of mismatches) {
      const config = ConfigSchema.parse({
        ...base,
        planner: { ...base.planner, ...mismatch },
      });
      expect(resolveConfiguredCustomRunner(config, 'planner')).toBeNull();
    }
  });

  it('does not route configured commands for non-command active runners', () => {
    const base = configWithConfiguredCommands();
    const config = ConfigSchema.parse({
      ...base,
      planner: createDefaultConfig().planner,
    });

    expect(resolveConfiguredCustomRunner(config, 'planner')).toBeNull();
  });

  it('leaves matching legacy shell and agent rows on their legacy paths', () => {
    const base = configWithConfiguredCommands();
    const legacy = ConfigSchema.parse({ ...base, customCommands: undefined });

    expect(resolveConfiguredCustomRunner(legacy, 'planner')).toBeNull();
    expect(resolveConfiguredCustomRunner(legacy, 'implementer')).toBeNull();
  });
});
