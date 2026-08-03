import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ConfigSchema, type Config } from '../../../core/schemas/config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveConfiguredCustomRunner } from '../../runners/configured-custom.js';
import { customRunnerSecurityPosture } from '../../runners/custom-trust.js';
import { createImplementer } from '../../runners/factory.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import { configForProfile, createTaskImplementer, routingBlockMessage } from './routing.js';
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
  ] as const)('makes the selected %s-to-%s profile the exact active configured identity', (defaultContract, selectedContract, writesFiles, resultPosture) => {
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
  });
});

describe('createTaskImplementer configured profile admission', () => {
  it('denies the selected profile before its child, a stage, or the default child can run', async () => {
    const projectDir = createTempDir('routing-denied-profile-project');
    const stateDir = createTempDir('routing-denied-profile-state');
    const selectedMarker = join(projectDir, 'selected-child-started');
    const defaultMarker = join(projectDir, 'default-child-started');
    try {
      const config = configWithProfileContracts('direct', 'output', {
        outputFormat: 'text',
        argvById: {
          'default-id': [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(defaultMarker)}, 'started');`,
          ],
          'selected-id': [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(selectedMarker)}, 'started');`,
          ],
        },
      });
      const selected = resolveImplementerProfiles(config).profiles.find(
        (profile) => profile.name === 'selected-profile',
      );
      if (selected === undefined) throw new Error('Expected selected profile fixture');
      let stages = 0;
      const runtime: CustomRunnerRuntimePort = {
        sessionId: 'routing-denied-session',
        authorizationProjectDir: projectDir,
        sourceEnv: {},
        authorizationPathEnv: process.env.PATH ?? '',
        ...(process.env.PATHEXT === undefined ? {} : { authorizationPathExt: process.env.PATHEXT }),
        createStage: async () => {
          stages++;
          throw new Error('Denied runner must not create a stage');
        },
        admission: { interaction: 'headless', allowRepoRunners: false, stateDir },
        cleanupStaleArtifactReviews: async () => {},
        beginDeclaredArtifactReview: async () => {
          throw new Error('Configured implementer must not begin planner artifact review.');
        },
      };
      const taskConfig = configForProfile(config, selected);
      const taskImplementer = await createTaskImplementer({
        wctx: makeWctx({
          projectDir,
          sessionId: runtime.sessionId,
          config,
          createImplementer: (runnerConfig, factoryOptions) =>
            createImplementer(runnerConfig, { ...factoryOptions, customRuntime: runtime }),
        }),
        profile: selected,
        taskConfig,
        singleImplementerMode: false,
      });

      const result = await taskImplementer.implement({
        task: makeTask({ id: 'T001', file: 'src/denied-profile.ts' }),
        projectDir,
        config: taskConfig,
        context: { name: 'routing denied profile', dir: projectDir },
        onOutput: () => {},
      });

      expect(result).toMatchObject({
        success: false,
        error: 'Configured custom runner admission was denied.',
      });
      expect(stages).toBe(0);
      expect(existsSync(selectedMarker)).toBe(false);
      expect(existsSync(defaultMarker)).toBe(false);
    } finally {
      cleanupTempDir(projectDir);
      cleanupTempDir(stateDir);
    }
  });
});

describe('routingBlockMessage', () => {
  it('formats message with estimated tokens', () => {
    const decision = {
      taskId: 'T001',
      estimatedTokens: 5000,
      contextLength: undefined,
      reason: 'too large',
    } as RoutingDecision;
    const message = routingBlockMessage(decision);
    expect(message).toContain('T001');
    expect(message).toContain('5000 estimated tokens');
  });

  it('formats message with context length ratio', () => {
    const decision = {
      taskId: 'T001',
      estimatedTokens: 5000,
      contextLength: 4000,
      reason: 'overflow',
    } as RoutingDecision;
    const message = routingBlockMessage(decision);
    expect(message).toContain('5000/4000 estimated tokens');
  });
});
