import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { ConfigSchema, type Config } from '../../../core/schemas/config.js';
import type { ImplementerConfig } from '../../../core/schemas/implementer-config.js';
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
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { configForProfile, createTaskImplementer, routingBlockMessage } from './routing.js';
import { runTaskLoop } from './loop.js';
import type { RoutingDecision } from '../context-routing/types.js';

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
      costTier: id === 'selected-id' ? ('frontier' as const) : ('cheap' as const),
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
        costTier: 'frontier',
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

  it('carries the routed window into the selected implementer config when the profile declares none', () => {
    const config = configWithProfileContracts('output', 'direct');
    const sourceProfiles = config.implementerProfiles;
    const sourceImplementer = config.implementer;
    const selected = resolveImplementerProfiles(config).profiles.find(
      (candidate) => candidate.name === 'selected-profile',
    );
    if (selected === undefined) throw new Error('Expected selected profile fixture');

    const routed = configForProfile(config, selected, 64_000);

    expect(routed.implementer).toEqual({ ...selected.config, contextLength: 64_000 });
    expect(routed.implementerProfiles?.default).toBe('selected-profile');
    expect(config.implementer).toBe(sourceImplementer);
    expect(config.implementerProfiles).toBe(sourceProfiles);
  });

  it('never overrides a context window the profile declared for itself', () => {
    const config = configWithProfileContracts('output', 'direct');
    const selected = resolveImplementerProfiles(config).profiles.find(
      (candidate) => candidate.name === 'selected-profile',
    );
    if (selected === undefined) throw new Error('Expected selected profile fixture');
    const withDeclaredWindow = {
      ...selected,
      config: { ...selected.config, contextLength: 50_000 },
    };

    const routed = configForProfile(config, withDeclaredWindow, 64_000);

    expect(routed.implementer.contextLength).toBe(50_000);
  });

  it('leaves the selected implementer config untouched when no window was decided', () => {
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
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      makeNoValidationConfig().implementer,
      { kind: 'agent-sdk', model: 'claude-sonnet-4-20250514' },
      { kind: 'shell', command: process.execPath, model: 'shell-model' },
      { kind: 'agent', command: process.execPath, model: 'agent-model' },
    ];
    const wctxIdentity = { projectDir: defaultContext.dir, sessionId: 'routing-test-session' };
    const existingImplementer = makeWctx(wctxIdentity).implementer;

    for (const runner of runners) {
      const profileName = `${runner.kind}-profile`;
      const profile = {
        name: profileName,
        costTier: 'unknown' as const,
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
      const preparedFactory = vi.fn(
        (runnerConfig: Config, options: ImplementerFactoryOptions = {}) => {
          expect(runnerConfig.implementer).toEqual(runner);
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
                : runner.kind === 'agent-sdk'
                  ? { kind: 'agent-sdk' as const, provider: 'anthropic' as const }
                  : { kind: runner.kind, command: { kind: 'validated-config' as const } }),
          });
          return existingImplementer;
        },
      );

      await expect(
        createTaskImplementer({
          wctx: makeWctx({ ...wctxIdentity, config, createImplementer: preparedFactory }),
          profile,
          taskConfig: config,
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
    const taskConfig = configForProfile(config, selected);

    await expect(
      createTaskImplementer({
        wctx: makeWctx({
          projectDir: defaultContext.dir,
          sessionId: 'routing-test-session',
          config,
          createImplementer: (_runnerConfig, factoryOptions) =>
            createImplementer(config, {
              ...factoryOptions,
              preparedConfig: config,
              preparationId: 'routing-missing-gate',
              gates: [],
              slot: { role: 'implementer', profile: selected.name },
            }),
        }),
        profile: selected,
        taskConfig,
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
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    costPosture: 'cheapest',
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

describe('runTaskLoop routed context window', { timeout: 90_000 }, () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  function setupProject(): { projectDir: string; sessionId: string } {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'task-loop-test',
      sessionId: 'sess-routed-window',
    });
    dirs.push(projectDir);
    return { projectDir, sessionId };
  }

  it('budgets the implementer prompt against the window the router decided for an automatic CLI profile', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const sourceConfig = makeNoValidationConfig({
      workflow: {},
      implementer: { kind: 'cli', tool: 'codex', model: 'auto' },
    });
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, task.file), 'implementation');
        return { success: true, output: 'code', usage: { inputTokens: 100, outputTokens: 50 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: sourceConfig,
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    const taskStart = events.find((event) => event.type === 'task_started');
    if (taskStart?.type !== 'task_started') throw new Error('Expected task_started event');
    const routedWindow = taskStart.contextLength;
    if (routedWindow === undefined) throw new Error('Expected routed window on task_started');

    expect(implementer.implement).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          implementer: expect.objectContaining({ contextLength: routedWindow }),
        }),
      }),
    );
    expect(sourceConfig.implementer.contextLength).toBeUndefined();
  });
});
