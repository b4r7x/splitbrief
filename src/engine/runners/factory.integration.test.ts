import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import { matches } from '../../utils/error.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { installClaudeRecordingShim } from '#testing/helpers/claude-cli-shim.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  createImplementer as createPreparedImplementer,
  createPlanner as createPreparedPlanner,
  createReviewer as createPreparedReviewer,
} from './factory.js';
import { customRunnerFactoryError, type RunnerFactoryAuthority } from './factory-gates.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import type { CliStartGate } from './start-gate.js';
import type { CustomRunnerRuntimePort } from './types.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import type { RunnerSlot } from './prepared-execution.js';
import { resolveConfiguredCustomRunner } from './configured-custom.js';
import { customRunnerSecurityPosture } from './custom-trust.js';
import type { AdmittedCustomRunnerInvocation } from './custom-launchability.js';
import type { PlannerFactoryOptions } from '../planners/types.js';
import type { ImplementerFactoryOptions } from '../implementers/types.js';
import { resolveCliExecutableAliases } from './resolve-cli-executable.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { CUSTOM_ONLY_CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
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
  options: Partial<PlannerCreationOptions> & PlannerFactoryOptions = {},
) {
  return createPreparedPlanner(config, {
    ...options,
    initialSessionId,
    ...authorityFor(config, 'planner', options.trustedCli),
  });
}

function reviewerAuthority(config: Config): RunnerFactoryAuthority {
  const preparationId = 'factory-reviewer';
  const slot: RunnerSlot = { role: 'reviewer' };
  return {
    preparedConfig: config,
    preparationId,
    slot,
    gates: [makeRunnerGate(resolveReviewerRunner(config).runner, slot, preparationId)],
  };
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
        const authority = {
          preparedConfig: config,
          preparationId,
          slot,
          gates: [
            {
              ...gate,
              executable: CliExecutableReceiptSchema.parse(executable),
              installedVersion: '2.1.296',
            },
          ],
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
    expect(written).toContain('The planner effort setting');
  });

  it('writes a variant warning to stderr when the backend has no named effort preset', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withPlanner({
      kind: 'shell',
      command: 'cat',
      outputFormat: 'text',
      variant: 'xhigh',
    });

    await createPlanner(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('The planner variant setting');
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
    expect(written).toContain('The planner temperature setting');
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
    const trustedCli: CliStartGate = { tool: 'claude-code', executable: resolved.executable };
    const claude = { kind: 'cli', tool: 'claude-code', model: 'test' } as const;
    const skillRoots = ['/home/me/.claude/skills/auth'];
    const readRoots = (): unknown => {
      const argv = readFileSync(argvFile, 'utf8').split('\n');
      return JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '').permissions
        .additionalDirectories;
    };

    const planner = await createPlanner(withPlanner(claude), undefined, {
      trustedCli,
      skillRoots,
    });
    await planner.review('prompt', shimDir, { onOutput: () => {} });
    expect(readRoots()).toEqual(skillRoots);

    const config = makeConfig({ reviewer: claude });
    const slot: RunnerSlot = { role: 'reviewer' };
    const gate = makeRunnerGate(claude, slot, 'factory-reviewer');
    if (gate.kind !== 'cli') throw new Error('expected a CLI gate');
    const reviewer = await createPreparedReviewer(config, {
      preparedConfig: config,
      preparationId: 'factory-reviewer',
      slot,
      gates: [
        {
          ...gate,
          executable:
            'executableIdentity' in trustedCli.executable
              ? trustedCli.executable
              : executableReceipt(trustedCli.executable.path),
        },
      ],
      skillRoots,
    });
    await reviewer.review('prompt', shimDir, { onOutput: () => {} });
    expect(readRoots()).toEqual(skillRoots);
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

  it('writes a variant warning to stderr when the backend has no named effort preset', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withImplementer({
      kind: 'shell',
      command: 'cat',
      outputFormat: 'text',
      model: 'test',
      variant: 'xhigh',
    });

    await createImplementer(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('The implementer variant setting');
  });

  it('keeps the variant when the implementer backend takes it as a named effort preset', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = withImplementer({ kind: 'cli', tool: 'opencode', variant: 'xhigh' });

    await createImplementer(config);

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('The implementer variant setting');
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
    expect(written).toContain('The implementer temperature setting');
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
        authChannel: 'session',
        model: 'test',
      });

      await expect(createPlanner(config)).rejects.toThrow(/planner configuration/);
    },
  );

  it('rejects custom-only CLI tools before implementer construction', async () => {
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

    await expect(
      createPreparedImplementer(configA, {
        preparedConfig: configB,
        preparationId,
        slot,
        gates: [makeRunnerGate(runnerB, slot, preparationId)],
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

    await expect(
      createPreparedPlanner(config, {
        preparedConfig: config,
        preparationId,
        slot,
        gates: [makeRunnerGate(config.planner, slot, preparationId)],
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

    const plannerGated: RunnerFactoryAuthority = {
      preparedConfig: config,
      preparationId: 'factory-reviewer',
      slot: { role: 'reviewer' },
      gates: [makeRunnerGate(config.planner, { role: 'reviewer' }, 'factory-reviewer')],
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

  it('writes a variant warning to stderr when the reviewer backend has no named effort preset', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = makeConfig({
      reviewer: {
        kind: 'api',
        provider: 'reviewer-endpoint',
        apiBase: 'https://reviewer.example.test/v1',
        apiKey: 'sk-reviewer',
        model: 'reviewer-model',
        variant: 'xhigh',
      },
    });

    await createPreparedReviewer(config, reviewerAuthority(config));

    const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('The reviewer variant setting');
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
      const trustedCli: CliStartGate = {
        tool: 'opencode',
        executable: resolved.executable,
      };

      const planner = await createPlanner(config, undefined, { trustedCli });
      const result = await planner.review('review the fixture', projectDir, {
        onOutput: () => {},
      });

      expect(result.text).toContain('slow response');
      const invocations = readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatch(/^run --model test --format json --agent plan /);
    } finally {
      restorePath();
      cleanupTempDir(projectDir);
      cleanupTempDir(shimDir);
      cleanupTempDir(observationDir);
    }
  });
});
