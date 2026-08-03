import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import { matches } from '../../utils/error.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { prependPath, writeCommandShim } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { customRunnerFactoryError, createImplementer, createPlanner } from './factory.js';
import type { CliStartGate } from './start-gate.js';
import type { CustomRunnerRuntimePort } from './types.js';

function withPlanner(planner: Config['planner']): Config {
  return { ...makeConfig(), planner };
}

function withImplementer(implementer: Config['implementer']): Config {
  return { ...makeConfig(), implementer };
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
      const path = realpathSync(join(shimDir, 'claude'));
      const info = statSync(path);
      const trustedCli: CliStartGate = {
        tool: 'claude-code',
        executable: {
          path,
          fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
        },
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
