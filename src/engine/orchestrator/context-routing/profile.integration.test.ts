import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { makeRunnerGate, testCliSeats } from '#testing/helpers/runner-gate.js';
import { ConfigSchema, type Config } from '../../../core/schemas/config.js';
import type { ImplementerConfig } from '../../../core/schemas/runner/implementer.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveConfiguredCustomRunner } from '../../runners/configured-custom.js';
import { customRunnerSecurityPosture } from '../../runners/custom-trust.js';
import { createImplementer } from '../../runners/factory.js';
import type { RunnerSlot } from '../../runners/prepared-execution.js';
import { runnerGateFor } from '../../runners/start-gate.js';
import type { ImplementerFactoryOptions } from '../../implementers/types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { configForProfile, createTaskImplementer, routingBlockMessage } from './profile.js';
import { runTaskLoop } from '../task/loop.js';
import type { RoutingDecision } from './types.js';

type CustomContract = 'output' | 'direct';

type CommandOptions = Readonly<{
  argvById?: Partial<Record<'default-id' | 'selected-id', string[]>>;
  outputFormat?: 'jsonl' | 'text';
}>;

function configWithProfileContracts(
  defaultContract: CustomContract,
  selectedContract: CustomContract,
  options: CommandOptions = {},
): Config {
  const command = (contract: CustomContract, id: string) => ({
    label: id,
    contract,
    executable: process.execPath,
    argv: options.argvById?.[id as 'default-id' | 'selected-id'] ?? [`--${id}`],
    outputFormat: options.outputFormat ?? ('jsonl' as const),
    idleWarnMs: 4_000,
    idleKillMs: 8_000,
    env: [],
  });
  const profile = (contract: CustomContract, id: string) => {
    const definition = command(contract, id);
    return {
      kind: contract === 'output' ? ('shell' as const) : ('agent' as const),
      command: definition.executable,
      args: definition.argv,
      outputFormat: definition.outputFormat,
      idleWarnMs: definition.idleWarnMs,
      idleKillMs: definition.idleKillMs,
      env: definition.env,
      model: `${id}-model`,
      label: `${id} label`,
      capabilities: {
        writesFiles: contract === 'output' ? ('extracted-code' as const) : ('direct' as const),
      },
    };
  };

  return ConfigSchema.parse({
    ...makeNoValidationConfig(),
    implementerProfiles: {
      default: 'default-profile',
      profiles: {
        'default-profile': profile(defaultContract, 'default-id'),
        'selected-profile': profile(selectedContract, 'selected-id'),
      },
    },
    customCommands: {
      'default-id': command(defaultContract, 'default-id'),
      'selected-id': command(selectedContract, 'selected-id'),
    },
  });
}

describe('configForProfile', () => {
  it.each([
    ['output', 'direct', 'direct', 'reviewed-diff-only'],
    ['direct', 'output', 'extracted-code', 'parsed-output-only'],
  ] as const)(
    'makes the selected %s-to-%s profile the exact active configured identity',
    (defaultContract, selectedContract, writesFiles, resultPosture) => {
      const config = configWithProfileContracts(defaultContract, selectedContract);
      const sourceProfiles = config.implementerProfiles;
      const sourceImplementer = config.implementer;
      const selected = resolveImplementerProfiles(config).profiles.find(
        (candidate) => candidate.name === 'selected-profile',
      );
      if (selected === undefined) throw new Error('Expected selected profile fixture');

      const routed = configForProfile(config, selected);

      expect(config.implementer).toBe(sourceImplementer);
      expect(config.implementerProfiles).toBe(sourceProfiles);
      expect(config.implementerProfiles?.default).toBe('default-profile');
      expect(routed.implementer).toEqual(selected.config);
      expect(routed.implementerProfiles).not.toBe(sourceProfiles);
      expect(routed.implementerProfiles?.profiles).toBe(sourceProfiles?.profiles);
      expect(routed.implementerProfiles?.default).toBe('selected-profile');

      const active = resolveImplementerProfiles(routed).defaultProfile;
      expect(active).toMatchObject({
        name: 'selected-profile',
        label: 'selected-id label',
        capabilities: { writesFiles },
        isDefault: true,
      });
      const configured = resolveConfiguredCustomRunner(routed, 'implementer');
      expect(configured).toMatchObject({
        source: 'configured',
        command: {
          id: 'selected-id',
          contract: selectedContract,
          executable: process.execPath,
          argv: ['--selected-id'],
        },
      });
      expect(
        customRunnerSecurityPosture('implementer', configured?.command.contract ?? 'output').result,
      ).toBe(resultPosture);
    },
  );

  it('leaves the selected implementer config as the profile declared it', () => {
    const config = configWithProfileContracts('output', 'direct');
    const selected = resolveImplementerProfiles(config).profiles.find(
      (candidate) => candidate.name === 'selected-profile',
    );
    if (selected === undefined) throw new Error('Expected selected profile fixture');

    const routed = configForProfile(config, selected);

    expect(routed.implementer).toBe(selected.config);
    expect(routed.implementer.contextLength).toBeUndefined();
  });
});

describe('createTaskImplementer configured profile admission', () => {
  it('routes every current runner kind and named profile with its matching prepared gate', async () => {
    const runners: ImplementerConfig[] = [
      { kind: 'cli', tool: 'codex' },
      makeNoValidationConfig().implementer,
      { kind: 'shell', command: process.execPath, model: 'shell-model' },
      { kind: 'agent', command: process.execPath, model: 'agent-model' },
    ];
    const wctxIdentity = { projectDir: defaultContext.dir, sessionId: 'routing-test-session' };
    const existingImplementer = makeWctx(wctxIdentity).implementer;

    for (const runner of runners) {
      const profileName = `${runner.kind}-profile`;
      const profile = {
        name: profileName,
        capabilities: {
          writesFiles: runner.kind === 'agent' ? ('direct' as const) : ('extracted-code' as const),
        },
        config: runner,
        isDefault: false,
      };
      const config = makeNoValidationConfig({ implementer: runner });
      const slot: RunnerSlot = { role: 'implementer', profile: profileName };
      const preparationId = `routing-${runner.kind}`;
      const gates = [makeRunnerGate(runner, slot, preparationId)];
      const preparedFactory = vi.fn((options: ImplementerFactoryOptions = {}) => {
        expect(options).toMatchObject({ slot });
        runnerGateFor(gates, {
          slot,
          preparationId,
          ...(runner.kind === 'cli'
            ? { kind: 'cli' as const, tool: runner.tool }
            : runner.kind === 'api'
              ? {
                  kind: 'api' as const,
                  provider: runner.provider,
                  endpointOrigin: new URL(runner.apiBase).origin,
                }
              : { kind: runner.kind, command: { kind: 'validated-config' as const } }),
        });
        return existingImplementer;
      });

      await expect(
        createTaskImplementer({
          wctx: makeWctx({ ...wctxIdentity, config, createImplementer: preparedFactory }),
          profile,
          singleImplementerMode: false,
        }),
      ).resolves.toBe(existingImplementer);
      expect(preparedFactory).toHaveBeenCalledOnce();
    }
  });

  it('rejects a selected profile when its prepared gate is absent', async () => {
    const config = configWithProfileContracts('direct', 'output');
    const selected = resolveImplementerProfiles(config).profiles.find(
      (profile) => profile.name === 'selected-profile',
    );
    if (selected === undefined) throw new Error('Expected selected profile fixture');

    await expect(
      createTaskImplementer({
        wctx: makeWctx({
          projectDir: defaultContext.dir,
          sessionId: 'routing-test-session',
          config,
          createImplementer: (factoryOptions: ImplementerFactoryOptions = {}) =>
            createImplementer(config, {
              ...factoryOptions,
              preparedConfig: config,
              preparationId: 'routing-missing-gate',
              gates: [],
              cliSeats: testCliSeats([]),
              slot: { role: 'implementer', profile: selected.name },
            }),
        }),
        profile: selected,
        singleImplementerMode: false,
      }),
    ).rejects.toMatchObject({ kind: 'runner-gate-mismatch' });
  });
});

function routingDecision(overrides: Partial<RoutingDecision>): RoutingDecision {
  return {
    taskId: taskId('T001'),
    requiredWriteMode: 'extracted-code',
    fit: 'overflow',
    estimatedTokens: 5000,
    untruncatedEstimatedTokens: 5000,
    contextLength: undefined,
    usedConservativeContextLength: false,
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    reason: 'too large',
    rejected: [],
    ...overrides,
  };
}

describe('routingBlockMessage', () => {
  it('formats message with estimated tokens', () => {
    const message = routingBlockMessage(routingDecision({}));
    expect(message).toContain('T001');
    expect(message).toContain('5000 estimated tokens');
  });

  it('formats message with context length ratio', () => {
    const message = routingBlockMessage(
      routingDecision({ contextLength: 4000, reason: 'overflow' }),
    );
    expect(message).toContain('5000/4000 estimated tokens');
  });
});

describe('runTaskLoop prompt budget', { timeout: 90_000 }, () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  function setupProject(files?: Record<string, string>): { projectDir: string; sessionId: string } {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'task-loop-test',
      sessionId: 'sess-routed-window',
      ...(files !== undefined && { files }),
    });
    dirs.push(projectDir);
    return { projectDir, sessionId };
  }

  it('gives a shell implementer with no Prompt budget the whole 120 KB file', async () => {
    const big = 'export const value = compute(input);\n'.repeat(Math.floor((120 * 1024) / 37));
    const { projectDir, sessionId } = setupProject({ 'src/big.ts': big });
    const promptDir = createTempDir('routing-prompt');
    dirs.push(promptDir);
    const promptPath = join(promptDir, 'prompt.txt');
    const answerPath = join(promptDir, 'answer.txt');
    writeFileSync(answerPath, `\`\`\`ts\n${big}export const done = true;\n\`\`\``);
    const config = makeNoValidationConfig({
      workflow: {},
      implementer: {
        kind: 'shell',
        command: '/bin/sh',
        args: ['-c', 'cat > "$1"; cat "$2"', 'sh', promptPath, answerPath],
        model: 'shell-model',
        outputFormat: 'text',
      },
    });
    const slot: RunnerSlot = { role: 'implementer', profile: 'default' };
    const preparationId = 'routing-shell-budget';
    const gates = [makeRunnerGate(config.implementer, slot, preparationId)];
    const implementer = await createImplementer(config, {
      preparedConfig: config,
      preparationId,
      gates,
      cliSeats: testCliSeats(gates),
      slot,
    });
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/big.ts'],
      currentCode: big,
    });

    const result = await runTaskLoop({
      wctx: makeWctx({ projectDir, sessionId, config, implementer }),
      initialState: makeImplState([task]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    const prompt = readFileSync(promptPath, 'utf8');
    expect(prompt).toContain(big);
    expect(prompt).not.toContain('truncated to fit context window');
  });
});
