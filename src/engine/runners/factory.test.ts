import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import { matches } from '../../utils/error.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  customRunnerFactoryError,
  createImplementer as createPreparedImplementer,
  createPlanner as createPreparedPlanner,
  type RunnerFactoryAuthority,
} from './factory.js';
import type { CliStartGate } from './start-gate.js';
import type { CustomRunnerRuntimePort } from './types.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import type { RunnerSlot } from './prepared-execution.js';
import { resolveConfiguredCustomRunner } from './configured-custom.js';
import { customRunnerSecurityPosture } from './custom-trust.js';
import type { AdmittedCustomRunnerInvocation } from './trust.js';
import type { PlannerFactoryOptions } from '../planners/types.js';
import type { ImplementerFactoryOptions } from '../implementers/types.js';
import { resolveCliExecutableAliases } from './resolve-cli-executable.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';

function withPlanner(planner: Config['planner']): Config {
  return { ...makeConfig(), planner };
}

function withImplementer(implementer: Config['implementer']): Config {
  return { ...makeConfig(), implementer };
}

function customInvocation(
  config: Config,
  role: CustomRunnerRole,
): AdmittedCustomRunnerInvocation | null {
  const runner = resolveConfiguredCustomRunner(config, role);
  if (runner === null) return null;
  return {
    kind: 'custom-runner-invocation',
    runner,
    posture: customRunnerSecurityPosture(role, runner.command.contract),
    executable: executableReceipt(runner.command.executable),
    authorization: 'explicit-grant',
    scope: {
      projectIdentity: `sha256:${'a'.repeat(64)}`,
      definitionId: runner.command.id,
      definitionDigest: `sha256:${'b'.repeat(64)}`,
    },
  };
}

type PlannerAuthority = RunnerFactoryAuthority & {
  slot: Extract<RunnerSlot, { role: 'planner' }>;
};
type ImplementerAuthority = RunnerFactoryAuthority & {
  slot: Exclude<RunnerSlot, { role: 'planner' }>;
};

function authorityFor(
  config: Config,
  role: 'planner',
  trustedCli?: CliStartGate | undefined,
): PlannerAuthority;
function authorityFor(
  config: Config,
  role: 'implementer',
  trustedCli?: CliStartGate | undefined,
): ImplementerAuthority;
function authorityFor(
  config: Config,
  role: CustomRunnerRole,
  trustedCli?: CliStartGate | undefined,
): RunnerFactoryAuthority {
  const preparationId = `factory-${role}`;
  const slot: RunnerSlot =
    role === 'planner'
      ? { role: 'planner' }
      : { role: 'implementer', profile: resolveImplementerProfiles(config).defaultProfile.name };
  const configured = customInvocation(config, role);
  if (configured !== null) {
    return {
      preparedConfig: config,
      preparationId,
      slot,
      gates: [
        {
          kind: configured.runner.command.contract === 'output' ? 'shell' : 'agent',
          slot,
          preparationId,
          command: { kind: 'configured-custom', invocation: configured },
        },
      ],
    };
  }
  const runner = config[role];
  const gate = makeRunnerGate(runner, slot, preparationId);
  if (gate.kind === 'cli' && trustedCli !== undefined) {
    const executable =
      'executableIdentity' in trustedCli.executable
        ? trustedCli.executable
        : executableReceipt(trustedCli.executable.path);
    return {
      preparedConfig: config,
      preparationId,
      slot,
      gates: [
        {
          ...gate,
          executable,
        },
      ],
    };
  }
  return { preparedConfig: config, preparationId, slot, gates: [gate] };
}

function createPlanner(
  config: Config,
  initialSessionId?: string | null,
  options: PlannerFactoryOptions = {},
) {
  return createPreparedPlanner(config, {
    ...options,
    initialSessionId,
    ...authorityFor(config, 'planner', options.trustedCli),
  });
}

function createImplementer(config: Config, options: ImplementerFactoryOptions = {}) {
  return createPreparedImplementer(config, {
    ...options,
    ...authorityFor(config, 'implementer', options.trustedCli),
  });
}

type CustomRunnerRole = 'planner' | 'implementer';
type CustomCommandContract = 'output' | 'direct';

const configuredRoutes = [
  ['planner', 'output'],
  ['planner', 'direct'],
  ['implementer', 'output'],
  ['implementer', 'direct'],
] as const;

function configuredRunnerConfig(role: CustomRunnerRole, contract: CustomCommandContract): Config {
  const command = {
    label: `Factory ${role} ${contract}`,
    contract,
    executable: process.execPath,
    argv: [],
    outputFormat: 'text' as const,
    idleWarnMs: 300_000,
    idleKillMs: 1_800_000,
    env: [],
  };
  const runner = {
    kind: contract === 'output' ? 'shell' : 'agent',
    command: command.executable,
    args: command.argv,
    outputFormat: command.outputFormat,
    idleWarnMs: command.idleWarnMs,
    idleKillMs: command.idleKillMs,
    env: command.env,
  };
  const customCommands = { [`factory-${role}-${contract}`]: command };

  if (role === 'planner') {
    return ConfigSchema.parse({ ...makeConfig(), planner: runner, customCommands });
  }

  const legacyImplementer =
    contract === 'output'
      ? { kind: 'agent', command: 'cat', outputFormat: 'text', model: 'legacy' }
      : { kind: 'shell', command: 'cat', outputFormat: 'text', model: 'legacy' };
  return ConfigSchema.parse({
    ...makeConfig(),
    implementer: legacyImplementer,
    implementerProfiles: {
      default: 'configured-custom',
      profiles: {
        'configured-custom': { ...runner, model: 'configured' },
      },
    },
    customCommands,
  });
}

function customRuntime(): CustomRunnerRuntimePort {
  return {
    sessionId: 'factory-custom-runner',
    authorizationProjectDir: process.cwd(),
    sourceEnv: {},
    admission: { interaction: 'headless', allowRepoRunners: false },
    createStage: async () => {
      throw new Error('Factory construction must not create a custom runner stage.');
    },
    cleanupStaleArtifactReviews: async () => {
      throw new Error('Factory construction must not clean planner artifact reviews.');
    },
    beginDeclaredArtifactReview: async () => {
      throw new Error('Factory construction must not begin planner artifact review.');
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPlanner', () => {
  it.each([
    [
      'API planner',
      withPlanner({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      }),
    ],
    ['shell planner', withPlanner({ kind: 'shell', command: 'cat', outputFormat: 'text' })],
    ['agent planner', withPlanner({ kind: 'agent', command: 'cat', outputFormat: 'text' })],
  ] as const)('creates a usable %s', async (_name, config) => {
    const planner = await createPlanner(config);

    expect(planner).toBeDefined();
    expect(planner.capabilities).toMatchObject({
      supportsConversationalPlanning: expect.any(Boolean),
      supportsHintEscalation: expect.any(Boolean),
      supportsSessionResume: expect.any(Boolean),
      supportsEffort: expect.any(Boolean),
      supportsImages: expect.any(Boolean),
      supportsSelfSummarisation: expect.any(Boolean),
    });
  });

  it('writes an effort warning to stderr when the backend does not support it', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'test',
      effort: 'high',
    });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('planner-effort');
  });

  it('writes a temperature warning to stderr when the backend cannot deliver it', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({
      kind: 'shell',
      command: 'cat',
      outputFormat: 'text',
      temperature: 0.7,
    });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('planner-temperature');
  });

  it('does not warn about temperature for the api planner kind', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'test',
      temperature: 0.7,
    });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('planner-temperature');
  });

  describe('claude-code idle wiring', () => {
    let shimDir: string;
    let restorePath: () => void;

    beforeEach(() => {
      shimDir = createTempDir('factory-claude-code-idle');
      restorePath = prependPath(shimDir);
    });

    afterEach(() => {
      restorePath();
      cleanupTempDir(shimDir);
    });

    it('threads a configured idleWarnMs override into the claude-code planner spawn', async () => {
      writeCommandShim({
        dir: shimDir,
        command: 'claude',
        lines: [JSON.stringify({ type: 'result', result: 'slow response' })],
        sleepSeconds: 0.15,
      });

      const config = withPlanner({
        kind: 'cli',
        tool: 'claude-code',
        authChannel: 'session',
        model: 'test',
        idleWarnMs: 30,
      });
      const resolved = await resolveCliExecutableAliases({
        commands: ['claude'],
        projectDir: process.cwd(),
      });
      const trustedCli: CliStartGate = {
        tool: 'claude-code',
        executable: resolved.executable,
      };
      const planner = await createPlanner(config, undefined, { trustedCli });

      const events: RunnerCallEvent[] = [];
      const result = await planner.review('prompt', shimDir, {
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      });

      expect(result.text).toContain('slow response');
      expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
    });
  });
});

describe('createImplementer', () => {
  it.each([
    [
      'CLI implementer',
      withImplementer({ kind: 'cli', tool: 'codex', authChannel: 'session', model: 'test' }),
    ],
    [
      'API implementer',
      withImplementer({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      }),
    ],
    [
      'shell implementer',
      withImplementer({ kind: 'shell', command: 'cat', outputFormat: 'text', model: 'test' }),
    ],
    [
      'agent implementer',
      withImplementer({ kind: 'agent', command: 'cat', outputFormat: 'text', model: 'test' }),
    ],
  ] as const)('creates a usable %s', async (_name, config) => {
    const implementer = await createImplementer(config);

    expect(implementer).toBeDefined();
    expect(implementer.capabilities).toBeDefined();
    expect(implementer.capabilities?.writesFiles).toMatch(/^(direct|extracted-code)$/);
  });

  it('writes a temperature warning to stderr when the backend cannot deliver it', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withImplementer({
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
      model: 'test',
      temperature: 0.3,
    });

    await createImplementer(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('implementer-temperature');
  });

  it('does not warn about temperature for the api implementer kind', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withImplementer({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'test',
      temperature: 0.3,
    });

    await createImplementer(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('implementer-temperature');
  });
});

describe('configured custom runner routing', () => {
  it('preserves the typed missing-runtime error contract for both roles', () => {
    const planner = customRunnerFactoryError.runtimeUnavailable('planner');
    const implementer = customRunnerFactoryError.runtimeUnavailable('implementer');

    expect(matches('custom-runner-runtime-unavailable')(planner)).toBe(true);
    expect(matches('custom-runner-runtime-unavailable')(implementer)).toBe(true);
    expect(planner).toMatchObject({
      kind: 'custom-runner-runtime-unavailable',
      message: 'Configured custom planner requires a custom runner runtime.',
    });
    expect(implementer).toMatchObject({
      kind: 'custom-runner-runtime-unavailable',
      message: 'Configured custom implementer requires a custom runner runtime.',
    });
    expect(planner.data).toBeUndefined();
    expect(implementer.data).toBeUndefined();
  });

  it.each(
    configuredRoutes,
  )('rejects a configured %s %s runner without a runtime before legacy construction', async (role, contract) => {
    const config = configuredRunnerConfig(role, contract);

    if (role === 'planner') {
      await expect(createPlanner(config)).rejects.toMatchObject({
        kind: 'custom-runner-runtime-unavailable',
      });
      return;
    }

    await expect(createImplementer(config)).rejects.toMatchObject({
      kind: 'custom-runner-runtime-unavailable',
    });
  });

  it.each(
    configuredRoutes,
  )('constructs a configured %s %s runner through its runtime adapter', async (role, contract) => {
    const config = configuredRunnerConfig(role, contract);

    if (role === 'planner') {
      const planner = await createPlanner(config, undefined, { customRuntime: customRuntime() });
      expect(planner.capabilities).toMatchObject({
        supportsSelfSummarisation: false,
      });
      return;
    }

    const implementer = await createImplementer(config, { customRuntime: customRuntime() });
    expect(implementer.capabilities).toEqual({
      writesFiles: contract === 'output' ? 'extracted-code' : 'direct',
    });
  });

  it('keeps legacy shell and agent rows independent of a custom runtime', async () => {
    const planner = await createPlanner(
      withPlanner({ kind: 'shell', command: 'cat', outputFormat: 'text' }),
    );
    const implementer = await createImplementer(
      withImplementer({ kind: 'agent', command: 'cat', outputFormat: 'text', model: 'test' }),
    );

    expect(planner).toBeDefined();
    expect(implementer.capabilities).toEqual({ writesFiles: 'direct' });
  });
});

describe('CLI role enforcement', () => {
  it('rejects CLI tools outside the planner tuple before planner construction', async () => {
    const config = withPlanner({
      kind: 'cli',
      tool: 'cursor' as Config['planner'] extends { kind: 'cli'; tool: infer T } ? T : never,
      authChannel: 'session',
      model: 'test',
    });

    await expect(createPlanner(config)).rejects.toThrow(/planner configuration/);
  });

  it('rejects unknown CLI tools before planner construction', async () => {
    const config = withPlanner({
      kind: 'cli',
      tool: 'kiro' as Config['planner'] extends { kind: 'cli'; tool: infer T } ? T : never,
      authChannel: 'session',
      model: 'test',
    });

    await expect(createPlanner(config)).rejects.toThrow(/planner configuration/);
  });

  it('rejects unknown CLI tools before implementer construction', async () => {
    const config = withImplementer({
      kind: 'cli',
      tool: 'kiro' as Config['implementer'] extends { kind: 'cli'; tool: infer T } ? T : never,
      authChannel: 'session',
      model: 'test',
    });

    await expect(createImplementer(config)).rejects.toThrow(/implementer/);
  });
});

describe('prepared generic gate enforcement', () => {
  it('requires matching generic gates for planner and implementer construction across every runner kind', async () => {
    const plannerConfigs = [
      withPlanner({ kind: 'cli', tool: 'claude-code', authChannel: 'session', model: 'test' }),
      withPlanner({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      }),
      withPlanner({ kind: 'agent-sdk', model: 'claude-sonnet-4-5', apiKey: 'test-key' }),
      withPlanner({ kind: 'shell', command: 'cat', outputFormat: 'text' }),
      withPlanner({ kind: 'agent', command: 'cat', outputFormat: 'text' }),
    ];
    const implementerConfigs = [
      withImplementer({ kind: 'cli', tool: 'codex', authChannel: 'session', model: 'test' }),
      withImplementer({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      }),
      withImplementer({ kind: 'agent-sdk', model: 'claude-sonnet-4-5', apiKey: 'test-key' }),
      withImplementer({ kind: 'shell', command: 'cat', outputFormat: 'text', model: 'test' }),
      withImplementer({ kind: 'agent', command: 'cat', outputFormat: 'text', model: 'test' }),
    ];

    for (const config of plannerConfigs) {
      await expect(
        createPreparedPlanner(config, authorityFor(config, 'planner')),
      ).resolves.toBeDefined();
    }
    for (const config of implementerConfigs) {
      await expect(
        createPreparedImplementer(config, authorityFor(config, 'implementer')),
      ).resolves.toBeDefined();
    }

    const config = plannerConfigs[1];
    if (config === undefined) throw new Error('Missing API planner fixture.');
    const authority = authorityFor(config, 'planner');
    await expect(
      createPreparedPlanner(config, {
        ...authority,
        preparationId: 'different-preparation',
      }),
    ).rejects.toMatchObject({ kind: 'runner-gate-mismatch' });
  });

  it('rejects missing authority at runtime while the public signatures require it statically', async () => {
    const plannerConfig = withPlanner({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'planner',
    });
    const implementerConfig = withImplementer({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'implementer',
    });

    // @ts-expect-error Prepared authority is statically required.
    await expect(createPreparedPlanner(plannerConfig)).rejects.toMatchObject({
      kind: 'runner-gate-mismatch',
    });
    // @ts-expect-error Prepared authority is statically required.
    await expect(createPreparedImplementer(implementerConfig)).rejects.toMatchObject({
      kind: 'runner-gate-mismatch',
    });
  });

  it.each([
    [
      'API',
      withPlanner({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'model-a',
      }),
      withPlanner({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'model-b',
      }),
    ],
    [
      'CLI',
      withPlanner({ kind: 'cli', tool: 'codex', authChannel: 'session', model: 'model-a' }),
      withPlanner({ kind: 'cli', tool: 'codex', authChannel: 'session', model: 'model-b' }),
    ],
    [
      'shell',
      withPlanner({ kind: 'shell', command: 'cat', args: ['a'], outputFormat: 'text' }),
      withPlanner({ kind: 'shell', command: 'cat', args: ['b'], outputFormat: 'text' }),
    ],
    [
      'agent',
      withPlanner({ kind: 'agent', command: 'cat', args: ['a'] }),
      withPlanner({ kind: 'agent', command: 'cat', args: ['b'] }),
    ],
  ] as const)('rejects %s config A paired with same-safe-identity authority B', async (_kind, configA, configB) => {
    await expect(
      createPreparedPlanner(configA, authorityFor(configB, 'planner')),
    ).rejects.toMatchObject({ kind: 'runner-gate-mismatch' });
  });

  it('rejects a named profile config paired with authority from another preparation', async () => {
    const withProfileModel = (model: string) =>
      ConfigSchema.parse({
        ...makeConfig(),
        implementerProfiles: {
          default: 'review',
          profiles: {
            review: {
              kind: 'api',
              provider: 'ollama',
              service: 'ollama',
              offering: 'local',
              apiBase: 'http://localhost:11434/v1',
              model,
            },
          },
        },
      });
    const configA = withProfileModel('model-a');
    const configB = withProfileModel('model-b');
    const runnerB = configB.implementerProfiles?.profiles.review;
    if (runnerB === undefined) throw new Error('Missing named profile fixture.');
    const preparationId = 'named-profile-b';
    const slot = { role: 'implementer' as const, profile: 'review' };

    await expect(
      createPreparedImplementer(configA, {
        preparedConfig: configB,
        preparationId,
        slot,
        gates: [makeRunnerGate(runnerB, slot, preparationId)],
      }),
    ).rejects.toMatchObject({ kind: 'runner-gate-mismatch' });
  });
});
