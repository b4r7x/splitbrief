import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from './load/io.js';
import { ConfigSchema } from '../schemas/config.js';
import {
  CustomCommandDefinitionSchema,
  CustomCommandsConfigSchema,
  NormalizedCustomCommandSchema,
  customCommandTuple,
  customCommandTupleForRunner,
  findConfiguredCustomCommand,
  isCustomCommandRunner,
  matchesCustomCommandRunner,
  normalizeCustomCommand,
  readCustomCommandCatalog,
} from './custom-commands.js';

const safeDefinition = {
  label: 'Review changes',
  contract: 'output' as const,
  executable: './tools/review changes',
  argv: ['--format', 'jsonl'],
  outputFormat: 'jsonl' as const,
  idleWarnMs: 4_000,
  idleKillMs: 8_000,
  env: ['REVIEW_TOKEN'],
};

describe('custom command catalog schema', () => {
  it('keeps the map key as the stable ID and preserves every explicit execution field', () => {
    const parsed = CustomCommandsConfigSchema.parse({ review: safeDefinition });
    const normalized = normalizeCustomCommand('review', safeDefinition);

    expect(parsed).toEqual({ review: safeDefinition });
    expect(NormalizedCustomCommandSchema.parse(normalized)).toEqual(normalized);
    expect(
      customCommandTuple({
        id: 'review',
        contract: 'output',
        executable: './tools/review changes',
        argv: ['--format', 'jsonl'],
        outputFormat: 'jsonl',
        idleWarnMs: 4_000,
        idleKillMs: 8_000,
        env: ['REVIEW_TOKEN'],
      }),
    ).toEqual({
      contract: 'output',
      executable: './tools/review changes',
      argv: ['--format', 'jsonl'],
      outputFormat: 'jsonl',
      idleWarnMs: 4_000,
      idleKillMs: 8_000,
      env: ['REVIEW_TOKEN'],
    });
  });

  it('rejects malformed environment declarations and security-critical unknown fields', () => {
    for (const env of [['review_token'], ['REVIEW_TOKEN', 'REVIEW_TOKEN']]) {
      expect(CustomCommandDefinitionSchema.safeParse({ ...safeDefinition, env }).success).toBe(
        false,
      );
    }

    expect(
      CustomCommandDefinitionSchema.safeParse({ ...safeDefinition, shell: true }).success,
    ).toBe(false);
    expect(
      CustomCommandDefinitionSchema.safeParse({ ...safeDefinition, command: 'tool --format jsonl' })
        .success,
    ).toBe(false);
    expect(
      NormalizedCustomCommandSchema.safeParse({
        ...normalizeCustomCommand('review', safeDefinition),
        shell: true,
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate normalized execution tuples even when labels differ', () => {
    const result = CustomCommandsConfigSchema.safeParse({
      review: safeDefinition,
      reviewAgain: { ...safeDefinition, label: 'Review again' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join('.') === 'reviewAgain')).toBe(true);
  });

  it('normalizes omitted runtime defaults before tuple comparison', () => {
    const normalized = normalizeCustomCommand('first', {
      label: 'Review',
      contract: 'output',
      executable: 'review',
      env: ['Z_TOKEN', 'A_TOKEN'],
    });

    expect(
      NormalizedCustomCommandSchema.safeParse({
        id: 'first',
        label: 'Review',
        contract: 'output',
        executable: 'review',
      }).success,
    ).toBe(false);
    expect(
      NormalizedCustomCommandSchema.safeParse({ ...normalized, env: ['Z_TOKEN', 'A_TOKEN'] })
        .success,
    ).toBe(false);
    expect(
      customCommandTuple({
        id: 'first',
        contract: 'output',
        executable: 'review',
      }),
    ).toEqual(
      customCommandTuple({
        id: 'second',
        contract: 'output',
        executable: 'review',
        argv: [],
        outputFormat: 'text',
        idleWarnMs: 300_000,
        idleKillMs: 1_800_000,
        env: [],
      }),
    );
  });

  it('projects command runners through one canonical normalized matcher', () => {
    const directDefinition = {
      label: 'Apply changes',
      contract: 'direct' as const,
      executable: './tools/apply',
      argv: ['--stdin'],
      outputFormat: 'text' as const,
      idleWarnMs: 4_000,
      idleKillMs: 8_000,
      env: ['APPLY_TOKEN'],
    };
    const config = ConfigSchema.parse({
      ...createDefaultConfig(),
      planner: {
        kind: 'shell',
        command: safeDefinition.executable,
        args: safeDefinition.argv,
        outputFormat: safeDefinition.outputFormat,
        idleWarnMs: safeDefinition.idleWarnMs,
        idleKillMs: safeDefinition.idleKillMs,
        env: [...safeDefinition.env].reverse(),
      },
      implementer: {
        kind: 'agent',
        command: directDefinition.executable,
        args: directDefinition.argv,
        outputFormat: directDefinition.outputFormat,
        idleWarnMs: directDefinition.idleWarnMs,
        idleKillMs: directDefinition.idleKillMs,
        env: [...directDefinition.env].reverse(),
        model: 'apply-model',
      },
      customCommands: {
        review: safeDefinition,
        apply: directDefinition,
      },
    });

    expect(isCustomCommandRunner(config.planner)).toBe(true);
    expect(isCustomCommandRunner(config.implementer)).toBe(true);
    if (!isCustomCommandRunner(config.planner) || !isCustomCommandRunner(config.implementer)) {
      throw new Error('Expected command runners');
    }

    expect(customCommandTupleForRunner(config.planner)).toEqual(customCommandTuple(safeDefinition));
    expect(findConfiguredCustomCommand(config, config.planner)?.id).toBe('review');
    expect(findConfiguredCustomCommand(config, config.implementer)?.id).toBe('apply');
    expect(matchesCustomCommandRunner(config.planner, directDefinition)).toBe(false);
  });

  it('redacts credential-like literals and rejects shell interpolation rather than storing them', () => {
    const credential = 'sk-live-this-must-never-appear-in-an-error';
    for (const input of [
      { ...safeDefinition, executable: '{prompt}' },
      { ...safeDefinition, executable: '$(which review)' },
      { ...safeDefinition, argv: [`--token=${credential}`] },
    ]) {
      const result = CustomCommandDefinitionSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain(credential);
      expect(JSON.stringify(result.error?.issues)).toContain('environment reference');
      expect(
        NormalizedCustomCommandSchema.safeParse({
          ...normalizeCustomCommand('review', safeDefinition),
          ...input,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects direct and env-wrapped interpreter command strings without rejecting literal argv punctuation', () => {
    const commandStrings = [
      {
        executable: '/bin/sh',
        argv: ['-c', 'printf "$TOKEN" | tee result.txt'],
      },
      {
        executable: '/usr/bin/bash',
        argv: ['-ec', 'printf "$TOKEN" > result.txt'],
      },
      {
        executable: 'env',
        argv: ['sh', '-c', 'printf "$TOKEN" && touch result.txt'],
      },
      {
        executable: '/usr/bin/env',
        argv: ['-i', 'bash', '--command', 'printf "$TOKEN" | tee result.txt'],
      },
      {
        executable: '/usr/bin/env',
        argv: ['--chdir=/tmp', 'sh', '-c', 'printf "$TOKEN"'],
      },
      {
        executable: 'env',
        argv: ['-C', '/tmp', 'sh', '-c', 'printf "$TOKEN"'],
      },
      {
        executable: 'env',
        argv: ['--chdir', '/tmp', 'bash', '-c', 'printf "$TOKEN"'],
      },
      {
        executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        argv: ['-Command', 'Write-Output $env:TOKEN'],
      },
      {
        executable: 'C:\\Windows\\System32\\cmd.exe',
        argv: ['/c', 'echo %TOKEN%'],
      },
    ];

    for (const command of commandStrings) {
      const result = CustomCommandDefinitionSchema.safeParse({ ...safeDefinition, ...command });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain(command.argv.at(-1));
      expect(JSON.stringify(result.error?.issues)).toContain('environment reference');
    }

    expect(
      CustomCommandDefinitionSchema.safeParse({
        ...safeDefinition,
        executable: './tools/review',
        argv: ['--pattern=a|b', 'literal;punctuation', 'file(name).json'],
      }).success,
    ).toBe(true);
  });
});

describe('legacy custom command projection', () => {
  it('deduplicates safe planner, top-level, default, and dormant rows without changing config', () => {
    const config = {
      ...createDefaultConfig(),
      planner: { kind: 'shell' as const, command: './review', args: ['--json'] },
      implementer: {
        kind: 'shell' as const,
        command: './review',
        args: ['--json'],
        model: 'local',
      },
      implementerProfiles: {
        default: 'default-shell',
        profiles: {
          'default-shell': {
            kind: 'shell' as const,
            command: './review',
            args: ['--json'],
            model: 'local',
          },
          'dormant-direct': {
            kind: 'agent' as const,
            command: './review',
            args: ['--json'],
            model: 'local',
          },
        },
      },
    };
    const before = JSON.stringify(config);

    const catalog = readCustomCommandCatalog(config);

    expect(catalog.configured).toEqual([]);
    expect(catalog.legacy).toHaveLength(2);
    expect(catalog.legacy.filter((entry) => entry.kind === 'safe')).toHaveLength(2);
    const safe = catalog.legacy.filter(
      (entry): entry is Extract<(typeof catalog.legacy)[number], { kind: 'safe' }> =>
        entry.kind === 'safe',
    );
    expect(safe.map((entry) => entry.command.contract)).toEqual(['direct', 'output']);
    expect(safe.find((entry) => entry.command.contract === 'output')?.sources).toEqual([
      'planner',
      'implementer',
      'implementerProfiles.default-shell',
    ]);
    expect(safe.find((entry) => entry.command.contract === 'direct')?.sources).toEqual([
      'implementerProfiles.dormant-direct',
    ]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('projects a shell reviewer as a legacy source of its own', () => {
    const config = {
      ...createDefaultConfig(),
      reviewer: { kind: 'shell' as const, command: './review-seat', args: ['--json'] },
    };

    const catalog = readCustomCommandCatalog(config);
    const safe = catalog.legacy.filter(
      (entry): entry is Extract<(typeof catalog.legacy)[number], { kind: 'safe' }> =>
        entry.kind === 'safe',
    );

    expect(safe.map((entry) => entry.sources)).toEqual([['reviewer']]);
  });

  it('retains unsafe legacy command material only behind a process-local opaque ID', () => {
    const credential = 'ghp_this_must_not_escape_the_legacy_projection';
    const config = {
      ...createDefaultConfig(),
      planner: {
        kind: 'shell' as const,
        command: './review',
        args: [`--token=${credential}`],
      },
    };

    const first = readCustomCommandCatalog(config);
    const second = readCustomCommandCatalog(config);
    const unsafe = first.legacy.find((entry) => entry.kind === 'unsafe');
    const secondUnsafe = second.legacy.find((entry) => entry.kind === 'unsafe');

    expect(unsafe).toMatchObject({
      kind: 'unsafe',
      contract: 'output',
      remediation: expect.stringContaining('environment reference'),
      opaqueId: expect.stringMatching(/^legacy-unsafe-/),
    });
    expect(secondUnsafe).toMatchObject({ opaqueId: unsafe?.opaqueId });
    expect(JSON.stringify(first)).not.toContain(credential);
    expect(JSON.stringify(first)).not.toContain('digest');
  });
});
