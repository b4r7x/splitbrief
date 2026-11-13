import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import { matches } from '../../utils/error.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { defaultContext, makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { versionedCli } from '#testing/helpers/versioned-cli.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { installClaudeRecordingShim } from '#testing/helpers/claude-cli-shim.js';
import { makeRunnerGate, testCliSeats } from '#testing/helpers/runner-gate.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  createImplementer as createPreparedImplementer,
  createPlanner as createPreparedPlanner,
  createReviewer as createPreparedReviewer,
} from './factory.js';
import { customRunnerFactoryError, type RunnerFactoryAuthority } from './factory-gates.js';
import { requireReviewSeat } from '../../core/config/accessors/reviewer-runner.js';
import {
  createCliSeatGates,
  type CliStartGate,
  type CliToolCheckFailure,
  type RecheckCliTool,
} from './start-gate.js';
import type { CustomRunnerRuntimePort } from './types.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import type { RunnerGate, RunnerSlot } from './prepared-execution.js';
import { resolveConfiguredCustomRunner } from './configured-custom.js';
import { customRunnerSecurityPosture } from './custom-trust.js';
import type { AdmittedCustomRunnerInvocation } from './custom-launchability.js';
import type { PlannerFactoryOptions } from '../planners/types.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import { resolveCliExecutableAliases } from './resolve-cli-executable.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { CUSTOM_ONLY_CLI_TOOL_IDS, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { PlannerCreationOptions } from './factory.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import { installClaudeSteeringShim } from '#testing/helpers/claude-steering-shim.js';
import { createSteeringPort, deliverToRunningCall, type SteerOutcome } from '../calls/steering.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';

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
  slot: Extract<RunnerSlot, { role: 'implementer' }>;
};

function authorityFor(
  config: Config,
  role: 'planner',
  cliGate?: CliStartGate | undefined,
): PlannerAuthority;
function authorityFor(
  config: Config,
  role: 'implementer',
  cliGate?: CliStartGate | undefined,
): ImplementerAuthority;
function authorityFor(
  config: Config,
  role: CustomRunnerRole,
  cliGate?: CliStartGate | undefined,
): RunnerFactoryAuthority {
  const preparationId = `factory-${role}`;
  const slot: RunnerSlot =
    role === 'planner'
      ? { role: 'planner' }
      : { role: 'implementer', profile: resolveImplementerProfiles(config).defaultProfile.name };
  const configured = customInvocation(config, role);
  if (configured !== null) {
    const gates: RunnerGate[] = [
      {
        kind: configured.runner.command.contract === 'output' ? 'shell' : 'agent',
        slot,
        preparationId,
        command: { kind: 'configured-custom', invocation: configured },
      },
    ];
    return { preparedConfig: config, preparationId, slot, gates, cliSeats: testCliSeats(gates) };
  }
  const runner = config[role];
  const gate = makeRunnerGate(runner, slot, preparationId);
  if (gate.kind === 'cli' && cliGate !== undefined) {
    const executable =
      'executableIdentity' in cliGate.executable
        ? cliGate.executable
        : executableReceipt(cliGate.executable.path);
    const gates = [{ ...gate, executable }];
    return { preparedConfig: config, preparationId, slot, gates, cliSeats: testCliSeats(gates) };
  }
  return {
    preparedConfig: config,
    preparationId,
    slot,
    gates: [gate],
    cliSeats: testCliSeats([gate]),
  };
}

function createPlanner(
  config: Config,
  initialSessionId?: string | null,
  {
    cliGate,
    ...options
  }: Partial<PlannerCreationOptions> & PlannerFactoryOptions & { cliGate?: CliStartGate } = {},
) {
  return createPreparedPlanner(config, {
    ...options,
    initialSessionId,
    ...authorityFor(config, 'planner', cliGate),
  });
}

function reviewerAuthority(config: Config): RunnerFactoryAuthority {
  const preparationId = 'factory-reviewer';
  const slot: RunnerSlot = { role: 'reviewer' };
  const gates = [makeRunnerGate(requireReviewSeat(config).runner, slot, preparationId)];
  return { preparedConfig: config, preparationId, slot, gates, cliSeats: testCliSeats(gates) };
}

function createImplementer(
  config: Config,
  { cliGate, ...options }: ImplementerFactoryOptions & { cliGate?: CliStartGate } = {},
) {
  return createPreparedImplementer(config, {
    ...options,
    ...authorityFor(config, 'implementer', cliGate),
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

describe('factory Claude mid-call steering', () => {
  it.each(['planner', 'reviewer'] as const)(
    'delivers a message to the running %s call',
    async (seat) => {
      const dir = createTempDir('factory-claude-steering');
      const projectDir = createTempDir('factory-claude-steering-project');
      const restorePath = activateSafeCliShimPath(dir);
      const port = createSteeringPort();
      const sends: Promise<SteerOutcome>[] = [];
      try {
        const { stdinFile, argvFile } = installClaudeSteeringShim(dir);
        const { executable } = await resolveCliExecutableAliases({
          commands: ['claude'],
          projectDir,
        });
        const claude = {
          kind: 'cli',
          tool: 'claude-code',
          model: 'sonnet',
          effort: 'high',
        } as const;
        const config = makeConfig({ planner: claude, reviewer: claude });
        const preparationId = 'factory-claude-steering';
        const slot: RunnerSlot = { role: seat };
        const gate = makeRunnerGate(claude, slot, preparationId);
        if (gate.kind !== 'cli') throw new Error('expected a CLI gate');
        const gates = [
          {
            ...gate,
            executable: CliExecutableReceiptSchema.parse(executable),
            installedVersion: '2.1.296',
          },
        ];
        const authority = {
          preparedConfig: config,
          preparationId,
          slot,
          gates,
          cliSeats: testCliSeats(gates),
          initialSessionId: seat === 'planner' ? 'steering-session' : null,
          skillRoots: ['/tmp/factory-steering-skills'],
        };
        let sent = false;
        const callbacks = {
          onOutput: () => {},
          steering: port,
          onCallEvent: (event: RunnerCallEvent) => {
            if (event.type !== 'call_tool_use_delta' || sent) return;
            sent = true;
            sends.push(deliverToRunningCall(port.current(), { id: seat, text: `STEER_${seat}` }));
          },
        };
        if (seat === 'planner') {
          const planner = await createPreparedPlanner(config, authority);
          const result = await planner.typedCall({ projectDir, seat, callbacks }).invoke({
            prompt: 'Plan the change',
            schema: { json: { type: 'object' }, name: 'plan' },
          });
          expect(result).toMatchObject({ status: 'completed', structured: { answer: 'last' } });
        } else {
          const reviewer = await createPreparedReviewer(config, authority);
          const result = await reviewer.typedCall({ projectDir, seat, callbacks }).invoke({
            prompt: 'Final Implementation Review',
            schema: { json: { type: 'object' }, name: 'verdict' },
          });
          expect(result).toMatchObject({ status: 'completed', structured: { answer: 'last' } });
        }
        expect(await Promise.all(sends)).toEqual(['delivered']);
        expect(port.current()).toBeNull();
        const turns = readFileSync(stdinFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(turns).toHaveLength(2);
        expect(turns[1]).toMatchObject({ type: 'user', message: { content: `STEER_${seat}` } });
        const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
        expect(argv).toEqual(
          expect.arrayContaining([
            '--input-format',
            'stream-json',
            '--replay-user-messages',
            '--effort',
            'high',
            '--settings',
          ]),
        );
        expect(argv.includes('--resume')).toBe(seat === 'planner');
      } finally {
        restorePath();
        cleanupTempDir(dir);
        cleanupTempDir(projectDir);
      }
    },
  );
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
      supportsSessionResume: expect.any(Boolean),
      supportsEffort: expect.any(Boolean),
      supportsImages: expect.any(Boolean),
      supportsSelfSummarisation: expect.any(Boolean),
    });
  });

  it('keeps the variant when the planner backend takes it as a named effort preset', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({ kind: 'cli', tool: 'opencode', variant: 'xhigh' });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('The planner variant setting');
  });

  it('does not warn about variant when no variant is configured', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({ kind: 'shell', command: 'cat', outputFormat: 'text' });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('The planner variant setting');
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
    expect(written).not.toContain('The planner temperature setting');
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
        model: 'test',
        idleWarnMs: 30,
      });
      const resolved = await resolveCliExecutableAliases({
        commands: ['claude'],
        projectDir: process.cwd(),
      });
      const cliGate: CliStartGate = {
        tool: 'claude-code',
        executable: resolved.executable,
      };
      const planner = await createPlanner(config, undefined, { cliGate });

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

describe("claude-code seats and the run's global skills", () => {
  let shimDir: string;
  let restorePath: () => void;

  beforeEach(() => {
    shimDir = createTempDir('factory-claude-code-skills');
    restorePath = prependPath(shimDir);
  });

  afterEach(() => {
    restorePath();
    cleanupTempDir(shimDir);
  });

  it('hands the planner and the reviewer the attached global skills to read', async () => {
    const { argvFile } = installClaudeRecordingShim(shimDir);
    const resolved = await resolveCliExecutableAliases({
      commands: ['claude'],
      projectDir: process.cwd(),
    });
    const cliGate: CliStartGate = { tool: 'claude-code', executable: resolved.executable };
    const claude = { kind: 'cli', tool: 'claude-code', model: 'test' } as const;
    const skillRoots = ['/home/me/.claude/skills/auth'];
    const readRoots = (): unknown => {
      const argv = readFileSync(argvFile, 'utf8').split('\n');
      return JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '').permissions
        .additionalDirectories;
    };

    const planner = await createPlanner(withPlanner(claude), undefined, {
      cliGate,
      skillRoots,
    });
    await planner.review('prompt', shimDir, { onOutput: () => {} });
    expect(readRoots()).toEqual(skillRoots);

    const config = makeConfig({ reviewer: claude });
    const slot: RunnerSlot = { role: 'reviewer' };
    const gate = makeRunnerGate(claude, slot, 'factory-reviewer');
    if (gate.kind !== 'cli') throw new Error('expected a CLI gate');
    const gates = [
      {
        ...gate,
        executable:
          'executableIdentity' in cliGate.executable
            ? cliGate.executable
            : executableReceipt(cliGate.executable.path),
      },
    ];
    const reviewer = await createPreparedReviewer(config, {
      preparedConfig: config,
      preparationId: 'factory-reviewer',
      slot,
      gates,
      cliSeats: testCliSeats(gates),
      skillRoots,
    });
    await reviewer.review('prompt', shimDir, { onOutput: () => {} });
    expect(readRoots()).toEqual(skillRoots);
  });
});

describe('createImplementer', () => {
  it.each([
    ['CLI implementer', withImplementer({ kind: 'cli', tool: 'codex', model: 'test' })],
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

  it('keeps the variant when the implementer backend takes it as a named effort preset', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withImplementer({ kind: 'cli', tool: 'opencode', variant: 'xhigh' });

    await createImplementer(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('The implementer variant setting');
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
    expect(written).not.toContain('The implementer temperature setting');
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

  it.each(configuredRoutes)(
    'rejects a configured %s %s runner without a runtime before legacy construction',
    async (role, contract) => {
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
    },
  );

  it.each(configuredRoutes)(
    'constructs a configured %s %s runner through its runtime adapter',
    async (role, contract) => {
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
    },
  );

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
  it.each(CUSTOM_ONLY_CLI_TOOL_IDS)(
    'rejects custom-only CLI tool %s before planner construction',
    async (tool) => {
      const config = withPlanner({
        kind: 'cli',
        tool: tool as Config['planner'] extends { kind: 'cli'; tool: infer T } ? T : never,
        model: 'test',
      });

      await expect(createPlanner(config)).rejects.toThrow(/planner configuration/);
    },
  );

  it('rejects custom-only CLI tools before implementer construction', async () => {
    const config = withImplementer({
      kind: 'cli',
      tool: 'kiro' as Config['implementer'] extends { kind: 'cli'; tool: infer T } ? T : never,
      model: 'test',
    });

    await expect(createImplementer(config)).rejects.toThrow(/implementer/);
  });
});

describe('prepared generic gate enforcement', () => {
  it('requires matching generic gates for planner and implementer construction across every runner kind', async () => {
    const plannerConfigs = [
      withPlanner({ kind: 'cli', tool: 'claude-code', model: 'test' }),
      withPlanner({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      }),
      withPlanner({ kind: 'shell', command: 'cat', outputFormat: 'text' }),
      withPlanner({ kind: 'agent', command: 'cat', outputFormat: 'text' }),
    ];
    const implementerConfigs = [
      withImplementer({ kind: 'cli', tool: 'codex', model: 'test' }),
      withImplementer({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      }),
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
      withPlanner({ kind: 'cli', tool: 'codex', model: 'model-a' }),
      withPlanner({ kind: 'cli', tool: 'codex', model: 'model-b' }),
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
  ] as const)(
    'rejects %s config A paired with same-safe-identity authority B',
    async (_kind, configA, configB) => {
      await expect(
        createPreparedPlanner(configA, authorityFor(configB, 'planner')),
      ).rejects.toMatchObject({ kind: 'runner-gate-mismatch' });
    },
  );

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
    const gates = [makeRunnerGate(runnerB, slot, preparationId)];

    await expect(
      createPreparedImplementer(configA, {
        preparedConfig: configB,
        preparationId,
        slot,
        gates,
        cliSeats: testCliSeats(gates),
      }),
    ).rejects.toMatchObject({ kind: 'runner-gate-mismatch' });
  });

  it('refuses a prepared reviewer seat through the planner factory', async () => {
    const config = withPlanner({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'reviewer',
    });
    const slot = { role: 'reviewer' as const };
    const preparationId = 'reviewer-seat';
    const gates = [makeRunnerGate(config.planner, slot, preparationId)];

    await expect(
      createPreparedPlanner(config, {
        preparedConfig: config,
        preparationId,
        slot,
        gates,
        cliSeats: testCliSeats(gates),
      }),
    ).rejects.toMatchObject({ kind: 'runner-gate-mismatch' });
  });
});

describe('createReviewer', () => {
  function withReviewer(): Config {
    return makeConfig({
      planner: {
        kind: 'api',
        provider: 'planner-endpoint',
        apiBase: 'https://planner.example.test/v1',
        apiKey: 'sk-planner',
        model: 'planner-model',
      },
      reviewer: {
        kind: 'api',
        provider: 'reviewer-endpoint',
        apiBase: 'https://reviewer.example.test/v1',
        apiKey: 'sk-reviewer',
        model: 'reviewer-model',
      },
    });
  }

  it('builds the reviewer from the reviewer block, not from the planner', async () => {
    const config = withReviewer();

    await expect(createPreparedReviewer(config, reviewerAuthority(config))).resolves.toBeDefined();

    const gates = [makeRunnerGate(config.planner, { role: 'reviewer' }, 'factory-reviewer')];
    const plannerGated: RunnerFactoryAuthority = {
      preparedConfig: config,
      preparationId: 'factory-reviewer',
      slot: { role: 'reviewer' },
      gates,
      cliSeats: testCliSeats(gates),
    };
    await expect(createPreparedReviewer(config, plannerGated)).rejects.toMatchObject({
      kind: 'runner-gate-mismatch',
    });
  });

  it('refuses a reviewer whose configured arguments override authority SPLITBRIEF owns', async () => {
    const config = makeConfig({
      reviewer: { kind: 'cli', tool: 'claude-code', args: ['--permission-mode', 'acceptEdits'] },
    });

    await expect(createPreparedReviewer(config, reviewerAuthority(config))).rejects.toMatchObject({
      kind: 'planner-configured-args-rejected',
    });
  });

  it('keeps the variant when the reviewer backend takes it as a named effort preset', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = makeConfig({ reviewer: { kind: 'cli', tool: 'opencode', variant: 'xhigh' } });

    await createPreparedReviewer(config, reviewerAuthority(config));

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('The reviewer variant setting');
  });
});

describe('planner admission path', () => {
  it('refuses a cli planner whose configured args override adapter-owned authority before any spawn', async () => {
    const shimDir = createTempDir('factory-arg-override');
    const invocationMarker = join(shimDir, 'invoked');
    const restorePath = prependPath(shimDir);
    try {
      writeFileSync(
        join(shimDir, 'opencode'),
        ['#!/bin/sh', `touch ${JSON.stringify(invocationMarker)}`, 'exit 0', ''].join('\n'),
        'utf8',
      );
      chmodSync(join(shimDir, 'opencode'), 0o755);
      const config = withPlanner({
        kind: 'cli',
        tool: 'opencode',
        model: 'test',
        args: ['--config', 'custom.json'],
      });

      await expect(createPlanner(config)).rejects.toMatchObject({
        kind: 'planner-configured-args-rejected',
      });
      expect(existsSync(invocationMarker)).toBe(false);
    } finally {
      restorePath();
      cleanupTempDir(shimDir);
    }
  });

  it('constructs an OpenCode planner through the admitted descriptor and start gate, spawning exactly once', async () => {
    const projectDir = createTempDir('factory-opencode-admitted-project');
    createTestGitRepo(projectDir);
    const shimDir = createTempDir('factory-opencode-admitted-shim');
    const observationDir = createTempDir('factory-opencode-admitted-observation');
    const argvLog = join(observationDir, 'argv.lines');
    const restorePath = prependPath(shimDir);
    try {
      writeFileSync(
        join(shimDir, 'opencode'),
        [
          '#!/bin/sh',
          'if [ "$1" = "--version" ] || [ "$1" = "-v" ] || [ "$1" = "version" ]; then',
          "  printf '%s\\n' '1.18.15'",
          '  exit 0',
          'fi',
          `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
          `printf '%s\\n' '{"type":"text","sessionID":"ses-open","part":{"type":"text","text":"slow response"}}'`,
          'exit 0',
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(join(shimDir, 'opencode'), 0o755);
      const config = withPlanner({ kind: 'cli', tool: 'opencode', model: 'test' });
      const resolved = await resolveCliExecutableAliases({
        commands: ['opencode'],
        projectDir,
      });
      const cliGate: CliStartGate = {
        tool: 'opencode',
        executable: resolved.executable,
      };

      const planner = await createPlanner(config, undefined, { cliGate });
      const result = await planner.review('review the fixture', projectDir, {
        onOutput: () => {},
      });

      expect(result.text).toContain('slow response');
      const invocations = readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toBe('run --model test --format json --agent plan');
    } finally {
      restorePath();
      cleanupTempDir(projectDir);
      cleanupTempDir(shimDir);
      cleanupTempDir(observationDir);
    }
  });
});

describe('a CLI tool that updates itself during a run', () => {
  let projectDir: string;
  let toolRoot: string;
  let restorePath: () => void = () => {};

  beforeEach(() => {
    projectDir = createTempDir('factory-update-project');
    createTestGitRepo(projectDir);
    toolRoot = createTempDir('factory-update-tool');
  });

  afterEach(() => {
    restorePath();
    restorePath = () => {};
    cleanupTempDir(projectDir);
    cleanupTempDir(toolRoot);
  });

  function ranCount(release: string): number {
    const log = join(toolRoot, `${release}.ran`);
    return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
  }

  function ranLine(release: string): string {
    return `printf '%s\\n' "$*" >> ${JSON.stringify(join(toolRoot, `${release}.ran`))}`;
  }

  /** A Claude Code build release: it logs its run, appends to the brief's file and reports done. */
  function claudeBuildRelease(release: string): string {
    return [
      '#!/bin/sh',
      'cat >/dev/null',
      ranLine(release),
      `mkdir -p ${JSON.stringify(join(projectDir, 'src'))}`,
      `printf '%s\\n' ${JSON.stringify(release)} >> ${JSON.stringify(join(projectDir, 'src', 'hello.ts'))}`,
      `printf '%s\\n' '{"type":"result","result":"done"}'`,
      '',
    ].join('\n');
  }

  function claudePlanRelease(release: string): string {
    return [
      '#!/bin/sh',
      'cat >/dev/null',
      ranLine(release),
      `printf '%s\\n' '${JSON.stringify({ type: 'result', result: `answer from ${release}` })}'`,
      '',
    ].join('\n');
  }

  function opencodePlanRelease(release: string): string {
    return [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' '1.18.15'",
      '  exit 0',
      'fi',
      ranLine(release),
      `printf '%s\\n' '{"type":"text","sessionID":"ses-open","part":{"type":"text","text":"answer from ${release}"}}'`,
      'exit 0',
      '',
    ].join('\n');
  }

  /** Installs releases a and b, points PATH at a, and admits it the way preparation does. */
  async function admitReleaseA(
    command: string,
    tool: CliToolId,
    release: (name: string) => string,
  ) {
    const cli = versionedCli({ root: toolRoot, command });
    cli.write('a', release('a'));
    cli.write('b', release('b'));
    cli.pointTo('a');
    restorePath = prependPath(cli.binDir);
    const resolved = await resolveCliExecutableAliases({ commands: [command], projectDir });
    const gate: CliStartGate = { tool, executable: resolved.executable };
    return { cli, gate };
  }

  function implementOnce(implementer: Implementer, config: Config) {
    return implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });
  }

  const claudeBuild = () => withImplementer({ kind: 'cli', tool: 'claude-code', model: 'test' });

  it('BUILD runs the admitted release after the PATH symlink moves to a new release', async () => {
    const config = claudeBuild();
    const { cli, gate } = await admitReleaseA('claude', 'claude-code', claudeBuildRelease);
    const implementer = await createImplementer(config, { cliGate: gate });

    cli.pointTo('b');
    const result = await implementOnce(implementer, config);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(ranCount('a')).toBe(1);
    expect(ranCount('b')).toBe(0);
  });

  it('PLAN runs the admitted OpenCode release after the PATH symlink moves to a new release', async () => {
    const config = withPlanner({ kind: 'cli', tool: 'opencode', model: 'test' });
    const { cli, gate } = await admitReleaseA('opencode', 'opencode', opencodePlanRelease);
    const planner = await createPlanner(config, undefined, { cliGate: gate });

    cli.pointTo('b');

    await expect(
      planner.review('review the fixture', projectDir, { onOutput: () => {} }),
    ).resolves.toMatchObject({ text: expect.stringContaining('answer from a') });
    expect(ranCount('a')).toBe(1);
    expect(ranCount('b')).toBe(0);
  });

  it('BUILD does not run a same-named tool that appears earlier on PATH after admission', async () => {
    const config = claudeBuild();
    const { gate } = await admitReleaseA('claude', 'claude-code', claudeBuildRelease);
    const implementer = await createImplementer(config, { cliGate: gate });
    const shadowDir = join(toolRoot, 'shadow');
    mkdirSync(shadowDir);
    writeFileSync(join(shadowDir, 'claude'), claudeBuildRelease('shadow'), 'utf8');
    chmodSync(join(shadowDir, 'claude'), 0o755);
    const restoreAdmittedPath = restorePath;
    const restoreShadowPath = prependPath(shadowDir);
    restorePath = () => {
      restoreShadowPath();
      restoreAdmittedPath();
    };

    const result = await implementOnce(implementer, config);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(ranCount('a')).toBe(1);
    expect(ranCount('shadow')).toBe(0);
  });

  describe('when the admitted file itself changed', () => {
    function cliGates(gates: readonly RunnerGate[]): Extract<RunnerGate, { kind: 'cli' }>[] {
      return gates.flatMap((gate) => (gate.kind === 'cli' ? [gate] : []));
    }

    /**
     * The re-check port a fresh preparation answers through: it records each call and admits
     * the tool's current PATH answer. `afterAdmit` runs between that admission and the reply.
     */
    function admittingRecheck(
      config: Config,
      role: 'planner' | 'implementer',
      command: string,
      afterAdmit: () => void = () => {},
    ) {
      const calls: CliToolId[] = [];
      const recheck: RecheckCliTool = async (tool) => {
        calls.push(tool);
        const resolved = await resolveCliExecutableAliases({ commands: [command], projectDir });
        afterAdmit();
        const gate: CliStartGate = { tool, executable: resolved.executable };
        const authority =
          role === 'planner'
            ? authorityFor(config, 'planner', gate)
            : authorityFor(config, 'implementer', gate);
        return { kind: 'admitted', gates: cliGates(authority.gates) };
      };
      return { calls, recheck };
    }

    function blockingRecheck(failure: CliToolCheckFailure) {
      const calls: CliToolId[] = [];
      const recheck: RecheckCliTool = async (tool) => {
        calls.push(tool);
        return { kind: 'blocked', failure };
      };
      return { calls, recheck };
    }

    async function seatedImplementer(config: Config, gate: CliStartGate, recheck: RecheckCliTool) {
      const authority = authorityFor(config, 'implementer', gate);
      const cliSeats = createCliSeatGates({ gates: authority.gates, recheck });
      const implementer = await createPreparedImplementer(config, { ...authority, cliSeats });
      return { implementer, seat: cliSeats.seat(authority.slot) };
    }

    async function seatedPlanner(config: Config, gate: CliStartGate, recheck: RecheckCliTool) {
      const authority = authorityFor(config, 'planner', gate);
      const cliSeats = createCliSeatGates({ gates: authority.gates, recheck });
      const planner = await createPreparedPlanner(config, {
        initialSessionId: undefined,
        ...authority,
        cliSeats,
      });
      return { planner, seat: cliSeats.seat(authority.slot) };
    }

    function onDisk(path: string) {
      const real = realpathSync(path);
      const info = statSync(real);
      return { path: real, fingerprint: { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs } };
    }

    it('runs no re-check when only the PATH symlink moved', async () => {
      const config = claudeBuild();
      const { cli, gate } = await admitReleaseA('claude', 'claude-code', claudeBuildRelease);
      const port = admittingRecheck(config, 'implementer', 'claude');
      const { implementer, seat } = await seatedImplementer(config, gate, port.recheck);

      cli.pointTo('b');
      const result = await implementOnce(implementer, config);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(port.calls).toEqual([]);
      expect(ranCount('a')).toBe(1);
      expect(ranCount('b')).toBe(0);
      expect(seat.current().executable).toMatchObject(onDisk(cli.executable('a')));
    });

    it('BUILD adopts a release rewritten in place after one re-check, and the next call re-checks nothing', async () => {
      const config = claudeBuild();
      const { cli, gate } = await admitReleaseA('claude', 'claude-code', claudeBuildRelease);
      const port = admittingRecheck(config, 'implementer', 'claude');
      const { implementer, seat } = await seatedImplementer(config, gate, port.recheck);

      cli.write('a', claudeBuildRelease('a-updated'));
      const first = await implementOnce(implementer, config);

      expect(first.error).toBeUndefined();
      expect(first.success).toBe(true);
      expect(port.calls).toEqual(['claude-code']);
      expect(ranCount('a-updated')).toBe(1);
      expect(seat.current().executable).toMatchObject(onDisk(cli.executable('a')));

      const second = await implementOnce(implementer, config);

      expect(second.error).toBeUndefined();
      expect(second.success).toBe(true);
      expect(port.calls).toEqual(['claude-code']);
      expect(ranCount('a-updated')).toBe(2);
    });

    it('BUILD adopts the PATH answer after one re-check when the admitted release was pruned', async () => {
      const config = claudeBuild();
      const { cli, gate } = await admitReleaseA('claude', 'claude-code', claudeBuildRelease);
      const port = admittingRecheck(config, 'implementer', 'claude');
      const { implementer, seat } = await seatedImplementer(config, gate, port.recheck);

      cli.pointTo('b');
      cli.prune('a');
      const result = await implementOnce(implementer, config);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(port.calls).toEqual(['claude-code']);
      expect(ranCount('b')).toBe(1);
      expect(seat.current().executable).toMatchObject(onDisk(cli.executable('b')));
    });

    it.each([
      [
        'incompatible-version',
        'runner-check-failed',
        'Claude Code CLI version is not compatible.',
        'Install the tested Claude Code CLI version, then run `splitbrief doctor` again.',
      ],
      [
        'unauthenticated',
        'unauthenticated',
        'Claude Code CLI is not signed in.',
        'Sign in to Claude Code CLI, then run `splitbrief doctor` again.',
      ],
    ] as const)(
      'BUILD stops with outcome %s → %s when the changed file fails its re-check, and never runs it',
      async (cause, outcome, message, fix) => {
        const config = claudeBuild();
        const { cli, gate } = await admitReleaseA('claude', 'claude-code', claudeBuildRelease);
        const port = blockingRecheck({ message, fix, cause });
        const { implementer } = await seatedImplementer(config, gate, port.recheck);

        cli.write('a', claudeBuildRelease('a-updated'));
        const result = await implementOnce(implementer, config);

        expect(result).toMatchObject({
          success: false,
          outcome,
          error: expect.stringContaining(message),
        });
        expect(port.calls).toEqual(['claude-code']);
        expect(ranCount('a-updated')).toBe(0);
      },
    );

    it('BUILD fails closed when the file changes again after its re-check passed', async () => {
      const config = claudeBuild();
      const { cli, gate } = await admitReleaseA('claude', 'claude-code', claudeBuildRelease);
      const port = admittingRecheck(config, 'implementer', 'claude', () =>
        cli.write('a', claudeBuildRelease('a-updated-twice')),
      );
      const { implementer } = await seatedImplementer(config, gate, port.recheck);

      cli.write('a', claudeBuildRelease('a-updated'));
      const result = await implementOnce(implementer, config);

      expect(result).toMatchObject({
        success: false,
        outcome: 'runner-check-failed',
        error: expect.stringContaining('Claude Code CLI changed after SPLITBRIEF checked it'),
      });
      expect(port.calls).toEqual(['claude-code']);
      expect(ranCount('a-updated')).toBe(0);
      expect(ranCount('a-updated-twice')).toBe(0);
    });

    it('PLAN on OpenCode adopts a release rewritten in place after one re-check', async () => {
      const config = withPlanner({ kind: 'cli', tool: 'opencode', model: 'test' });
      const { cli, gate } = await admitReleaseA('opencode', 'opencode', opencodePlanRelease);
      const port = admittingRecheck(config, 'planner', 'opencode');
      const { planner } = await seatedPlanner(config, gate, port.recheck);

      cli.write('a', opencodePlanRelease('a-updated'));

      await expect(
        planner.review('review the fixture', projectDir, { onOutput: () => {} }),
      ).resolves.toMatchObject({ text: expect.stringContaining('answer from a-updated') });
      expect(port.calls).toEqual(['opencode']);
      expect(ranCount('a-updated')).toBe(1);
    });

    it('PLAN on Claude Code adopts a release rewritten in place after one re-check', async () => {
      const config = withPlanner({ kind: 'cli', tool: 'claude-code', model: 'test' });
      const { cli, gate } = await admitReleaseA('claude', 'claude-code', claudePlanRelease);
      const port = admittingRecheck(config, 'planner', 'claude');
      const { planner } = await seatedPlanner(config, gate, port.recheck);

      cli.write('a', claudePlanRelease('a-updated'));

      await expect(
        planner.review('review the fixture', projectDir, { onOutput: () => {} }),
      ).resolves.toMatchObject({ text: 'answer from a-updated' });
      expect(port.calls).toEqual(['claude-code']);
      expect(ranCount('a-updated')).toBe(1);
    });
  });
});
