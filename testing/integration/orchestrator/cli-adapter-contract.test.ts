import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  CLI_TOOL_CATALOG,
  CURSOR_CLI_ADMISSION_VERDICT,
  IMPLEMENTER_CLI_TOOL_IDS,
} from '../../../src/core/runners/cli-tool-catalog.js';
import type { CliImplementerConfig } from '../../../src/core/schemas/implementer-config.js';
import type { ImplementerCliToolId } from '../../../src/core/schemas/enums.js';
import { RUNNER_OUTCOME_STATES } from '../../../src/engine/runners/errors.js';
import { createCliImplementer } from '../../../src/engine/implementers/cli.js';
import { runnerCallOutcome } from '../../../src/engine/implementers/pipeline/call-result.js';
import type { RunnerCallResult, RunnerCallStatus } from '../../../src/engine/calls/types.js';
import {
  CLI_IMPLEMENTER_ADAPTERS,
  lookupCliPlannerAdapter,
} from '../../../src/engine/runners/cli-tools/registry.js';
import { probeCliReadiness } from '../../../src/engine/runners/cli-tools/readiness-probe.js';
import {
  invokeCliAdapter,
  CLI_PROMPT_PLACEHOLDER,
} from '../../../src/engine/runners/invoke-cli-adapter.js';
import { resolveCliExecutable } from '../../../src/engine/runners/resolve-cli-executable.js';
import type { CliStartGate } from '../../../src/engine/runners/start-gate.js';
import { processError } from '../../../src/lib/process/errors.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo, startConflictingMerge } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  prependPath,
  writeConflictProbeShim,
  writeContractShim,
  type ContractShimMode,
  type ContractShimProfile,
} from '#testing/helpers/command-shim.js';

const ADMITTED_IMPLEMENTER_IDS = [...IMPLEMENTER_CLI_TOOL_IDS] as const;

const PROMPT_HEAD = 'HEAD_SENTINEL ';
const PROMPT_TAIL = ' TAIL_SENTINEL';
const FULL_PROMPT = `${PROMPT_HEAD}implement src/contract.ts${PROMPT_TAIL}`;
const LARGE_ARGV_PROMPT = `${PROMPT_HEAD}${'x'.repeat(100_000)}${PROMPT_TAIL}`;

const SHIM_PROFILES: Record<ImplementerCliToolId, ContractShimProfile> = {
  'claude-code': {
    transport: 'stdin',
    versionLine: 'claude 2.0.0',
    successLines: ['{"type":"result","result":"done"}'],
    authArgv: ['auth'],
  },
  codex: {
    transport: 'argv',
    versionLine: 'codex 0.40.0',
    successLines: ['{"type":"turn.completed"}'],
    authArgv: ['auth'],
  },
  opencode: {
    transport: 'argv',
    versionLine: 'opencode 0.5.0',
    successLines: ['{"type":"text","part":{"type":"text","text":"ok"}}'],
    authArgv: ['auth'],
  },
  aider: {
    transport: 'argv',
    versionLine: 'aider 0.86.0',
    successLines: ['ok'],
    authArgv: ['auth'],
  },
  copilot: {
    transport: 'argv',
    versionLine: 'copilot 0.3.0',
    successLines: ['ok'],
    authArgv: ['auth', 'status'],
  },
  'kilo-code': {
    transport: 'argv',
    versionLine: 'kilo 0.1.0',
    successLines: ['ok'],
    authArgv: ['auth'],
  },
};

const AUTH_CHANNELS: Record<ImplementerCliToolId, CliImplementerConfig['authChannel']> = {
  'claude-code': 'session',
  codex: 'session',
  opencode: 'provider-dependent',
  aider: 'provider-dependent',
  copilot: 'session',
  'kilo-code': 'provider-dependent',
};

const CONFLICTING_ARGS: Record<ImplementerCliToolId, readonly string[]> = {
  'claude-code': ['--output-format', 'text'],
  codex: ['--json'],
  opencode: ['--format', 'json'],
  aider: ['--message', 'blocked'],
  copilot: ['--output-format', 'text'],
  'kilo-code': ['--output-format', 'text'],
};

const CREDENTIAL_ENV: Partial<Record<ImplementerCliToolId, Readonly<Record<string, string>>>> = {
  'claude-code': { ANTHROPIC_API_KEY: 'sk-ant-contract-canary' },
  codex: { OPENAI_API_KEY: 'sk-openai-contract-canary' },
  copilot: { GITHUB_TOKEN: 'ghp-contract-canary' },
};

type Fixture = {
  toolId: ImplementerCliToolId;
  projectDir: string;
  shimDir: string;
  captureDir: string;
  restorePath: () => void;
  trustedGate: CliStartGate;
};

const fixtures: Fixture[] = [];
let originalPath: string | undefined;

function shimEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return { PATH: process.env.PATH ?? '', ...extra };
}

function isStructuredTerminal(toolId: ImplementerCliToolId): boolean {
  return CLI_IMPLEMENTER_ADAPTERS[toolId].outputContract.kind === 'structured-terminal';
}

function trustedGateFor(toolId: ImplementerCliToolId, shimDir: string): CliStartGate {
  const command = CLI_TOOL_CATALOG[toolId].command;
  const commandPath = join(shimDir, command);
  const path = realpathSync(commandPath);
  const info = statSync(path);
  return {
    tool: toolId,
    executable: {
      path,
      fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    },
  };
}

function implementerConfig(
  toolId: ImplementerCliToolId,
  overrides: Partial<CliImplementerConfig> = {},
) {
  return {
    kind: 'cli' as const,
    tool: toolId,
    authChannel: AUTH_CHANNELS[toolId],
    contextLength: 8192,
    temperature: 0.2,
    ...overrides,
  };
}

function resetCapture(fixture: Fixture): void {
  for (const name of ['argv.lines', 'stdin.txt', 'started.marker', 'descendant.pid']) {
    const capturePath = join(fixture.captureDir, name);
    if (existsSync(capturePath)) rmSync(capturePath);
  }
}

function refreshTrustedGate(fixture: Fixture): void {
  fixture.trustedGate = trustedGateFor(fixture.toolId, fixture.shimDir);
}

function installShim(
  fixture: Fixture,
  mode: ContractShimMode,
  opts: {
    targetRelPath?: string;
    outsidePath?: string;
    exitCode?: number;
    versionLine?: string;
    versionExitCode?: number;
    authExitCode?: number;
    sleepMs?: number;
  } = {},
): void {
  const profile = SHIM_PROFILES[fixture.toolId];
  writeContractShim({
    dir: fixture.shimDir,
    command: CLI_TOOL_CATALOG[fixture.toolId].command,
    profile,
    mode,
    projectDir: fixture.projectDir,
    captureDir: fixture.captureDir,
    targetRelPath: opts.targetRelPath ?? 'src/contract.ts',
    ...(opts.outsidePath !== undefined ? { outsidePath: opts.outsidePath } : {}),
    ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    ...(opts.versionLine !== undefined ? { versionLine: opts.versionLine } : {}),
    ...(opts.versionExitCode !== undefined ? { versionExitCode: opts.versionExitCode } : {}),
    ...(opts.authExitCode !== undefined ? { authExitCode: opts.authExitCode } : {}),
    ...(opts.sleepMs !== undefined ? { sleepMs: opts.sleepMs } : {}),
  });
  refreshTrustedGate(fixture);
}

function createFixture(toolId: ImplementerCliToolId): Fixture {
  const projectDir = createTempDir(`cli-contract-${toolId}`);
  createTestGitRepo(projectDir);
  writeFileSync(join(projectDir, '.gitignore'), '.splitbrief/\n');
  const shimDir = createTempDir(`cli-contract-shim-${toolId}`);
  const captureDir = join(shimDir, 'capture');
  mkdirSync(captureDir, { recursive: true });
  const fixture: Fixture = {
    toolId,
    projectDir,
    shimDir,
    captureDir,
    restorePath: prependPath(shimDir),
    trustedGate: {
      tool: toolId,
      executable: { path: '', fingerprint: { dev: 0, ino: 0, size: 0, mtimeMs: 0 } },
    },
  };
  installShim(fixture, 'success-direct');
  fixture.trustedGate = trustedGateFor(toolId, shimDir);
  fixtures.push(fixture);
  return fixture;
}

async function runImplement(
  fixture: Fixture,
  opts: {
    mode?: ContractShimMode;
    config?: Partial<CliImplementerConfig>;
    signal?: AbortSignal;
  } = {},
) {
  if (opts.mode !== undefined) installShim(fixture, opts.mode);
  resetCapture(fixture);
  const config = makeConfig({ implementer: implementerConfig(fixture.toolId, opts.config) });
  const implementer = createCliImplementer(implementerConfig(fixture.toolId, opts.config), {
    trustedCli: fixture.trustedGate,
  });
  return implementer.implement({
    task: contractTask(),
    projectDir: fixture.projectDir,
    config,
    context: { ...defaultContext, dir: fixture.projectDir },
    onOutput: () => {},
    signal: opts.signal,
  });
}

function contractTask() {
  return makeTask({
    file: 'src/contract.ts',
    description: `${PROMPT_HEAD}create the contract module${PROMPT_TAIL}`,
  });
}

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function resolveFixtureExecutable(fixture: Fixture) {
  refreshTrustedGate(fixture);
  return resolveCliExecutable(
    CLI_TOOL_CATALOG[fixture.toolId].command,
    fixture.projectDir,
    fixture.trustedGate.executable,
  );
}

function readCapturedPrompt(fixture: Fixture): string {
  const profile = SHIM_PROFILES[fixture.toolId];
  const parts: string[] = [];
  if (profile.transport === 'stdin' && existsSync(join(fixture.captureDir, 'stdin.txt'))) {
    parts.push(readFileSync(join(fixture.captureDir, 'stdin.txt'), 'utf8'));
  }
  if (existsSync(join(fixture.captureDir, 'argv.lines'))) {
    parts.push(readFileSync(join(fixture.captureDir, 'argv.lines'), 'utf8'));
  }
  return parts.join('\n');
}

function callResult(status: RunnerCallStatus, code = 'provider-error'): RunnerCallResult {
  const common = {
    callId: 'call-1',
    role: 'implementer' as const,
    backendKind: 'cli' as const,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    text: '',
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
  } satisfies Omit<RunnerCallResult, 'status' | 'error' | 'partial'>;

  if (status === 'completed') {
    return { ...common, status, error: null, partial: false };
  }
  return { ...common, status, error: { code, message: 'provider failed' }, partial: true };
}

function outcomeFromResult(result: RunnerCallResult) {
  return runnerCallOutcome(result);
}

beforeEach(() => {
  originalPath = process.env['PATH'];
});

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    fixture.restorePath();
    cleanupTempDir(fixture.shimDir);
    cleanupTempDir(fixture.projectDir);
  }
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
});

describe('conditional OMIT admission', () => {
  it('produces no implementer rows for cursor or antigravity', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('OMIT');
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('OMIT');
    expect('cursor' in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
    expect('antigravity' in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
    expect(() => lookupCliPlannerAdapter('cursor')).toThrow(/planner configuration/);
    expect(() => lookupCliPlannerAdapter('antigravity')).toThrow(/planner configuration/);
  });
});

describe.each(ADMITTED_IMPLEMENTER_IDS)('%s admitted implementer staged contract', (toolId) => {
  it('satisfies the full staged CLI contract', async () => {
    const fixture = createFixture(toolId);
    const targetPath = join(fixture.projectDir, 'src/contract.ts');

    resetCapture(fixture);
    const success = await runImplement(fixture);
    expect(success.success).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('generated\n');
    expect(readCapturedPrompt(fixture)).toContain(PROMPT_HEAD);
    expect(readCapturedPrompt(fixture)).toContain(PROMPT_TAIL);

    if (SHIM_PROFILES[toolId].transport === 'argv') {
      installShim(fixture, 'success-direct');
      resetCapture(fixture);
      const adapter = CLI_IMPLEMENTER_ADAPTERS[toolId];
      await invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_PLACEHOLDER,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: undefined,
        },
        prompt: LARGE_ARGV_PROMPT,
        callContext: {
          callId: `oversized-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
      });
      expect(readCapturedPrompt(fixture)).toContain(PROMPT_HEAD);
      expect(readCapturedPrompt(fixture)).toContain(PROMPT_TAIL);
      expect(readCapturedPrompt(fixture)).toContain('x'.repeat(100_000));
    }

    if (SHIM_PROFILES[toolId].transport === 'stdin') {
      installShim(fixture, 'success-direct');
      resetCapture(fixture);
      const adapter = CLI_IMPLEMENTER_ADAPTERS[toolId];
      await invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_PLACEHOLDER,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: undefined,
        },
        prompt: LARGE_ARGV_PROMPT,
        callContext: {
          callId: `oversized-stdin-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
      });
      expect(readCapturedPrompt(fixture)).toContain('x'.repeat(100_000));
    }

    installShim(fixture, 'no-op');
    const noChange = await runImplement(fixture);
    expect(noChange.success).toBe(false);
    expect(noChange.error).toContain('without changing any files');
    expect(outcomeFromResult(callResult('failed', 'no-staged-change')).state).toBe(
      'no-staged-change',
    );

    installShim(fixture, 'outside-write', {
      outsidePath: join(fixture.shimDir, 'outside-write.txt'),
    });
    const outside = await runImplement(fixture);
    expect(outside.success).toBe(false);
    expect(outside.error).toContain('without changing any files');
    expect(existsSync(join(fixture.shimDir, 'outside-write.txt'))).toBe(true);

    installShim(fixture, 'provider-state-write');
    const providerOnly = await runImplement(fixture);
    expect(providerOnly.success).toBe(false);
    expect(providerOnly.error).toContain('without changing any files');
    expect(existsSync(join(fixture.projectDir, '.splitbrief/provider-state.json'))).toBe(true);

    installShim(fixture, 'non-zero-exit', { exitCode: 17 });
    const nonzero = await runImplement(fixture);
    expect(nonzero.success).toBe(false);

    if (isStructuredTerminal(toolId)) {
      installShim(fixture, 'protocol-failure');
      const protocol = await runImplement(fixture);
      expect(protocol.success).toBe(false);

      installShim(fixture, 'partial-protocol');
      const partial = await runImplement(fixture);
      expect(partial.success).toBe(false);
    }

    const missingExecutable = join(fixture.shimDir, 'missing-executable');
    const missing = await invokeCliAdapter({
      adapter: CLI_IMPLEMENTER_ADAPTERS[toolId],
      invocation: {
        executable: {
          path: missingExecutable,
          fingerprint: { dev: 0, ino: 0, size: 0, mtimeMs: 0 },
        },
        args: CLI_IMPLEMENTER_ADAPTERS[toolId].buildArgs({
          prompt: CLI_PROMPT_PLACEHOLDER,
          model: undefined,
          projectDir: fixture.projectDir,
          configuredArgs: [],
        }),
        promptTransport: CLI_IMPLEMENTER_ADAPTERS[toolId].promptTransport,
        environment: shimEnvironment(),
        cwd: fixture.projectDir,
        timeoutMs: 5_000,
        signal: undefined,
      },
      prompt: FULL_PROMPT,
      callContext: {
        callId: `missing-${toolId}`,
        role: 'implementer',
        backendKind: 'cli',
        runnerName: toolId,
      },
    });
    expect(missing.error?.code).toBe('spawn-not-found');

    installShim(fixture, 'success-direct', {
      versionLine: `${CLI_TOOL_CATALOG[toolId].command} 0.0.1`,
    });
    const incompatibleExecutable = await resolveFixtureExecutable(fixture);
    const incompatible = await probeCliReadiness({
      tool: toolId,
      executable: incompatibleExecutable,
      probe: CLI_IMPLEMENTER_ADAPTERS[toolId].probe,
      authChannel: AUTH_CHANNELS[toolId],
      classifyVersion: () => 'incompatible',
      classifyAuth: () => 'authenticated',
    });
    expect(incompatible.compatibility).toBe('incompatible');

    installShim(fixture, 'success-direct', { authExitCode: 1 });
    const unauthenticatedExecutable = await resolveFixtureExecutable(fixture);
    const unauthenticated = await probeCliReadiness({
      tool: toolId,
      executable: unauthenticatedExecutable,
      probe: CLI_IMPLEMENTER_ADAPTERS[toolId].probe,
      authChannel: AUTH_CHANNELS[toolId],
      classifyAuth: ({ exitCode }) => (exitCode === 0 ? 'authenticated' : 'unauthenticated'),
    });
    expect(unauthenticated.auth).toBe('unauthenticated');

    const untrusted = await createCliImplementer(implementerConfig(toolId), {
      trustedCli: undefined,
    }).implement({
      task: contractTask(),
      projectDir: fixture.projectDir,
      config: makeConfig({ implementer: implementerConfig(toolId) }),
      context: { ...defaultContext, dir: fixture.projectDir },
      onOutput: () => {},
    });
    expect(untrusted.success).toBe(false);
    expect(untrusted.error).toContain('trusted readiness identity');

    const conflictMarker = join(fixture.captureDir, 'conflict-spawned.txt');
    writeConflictProbeShim({
      dir: fixture.shimDir,
      command: CLI_TOOL_CATALOG[toolId].command,
      markerPath: conflictMarker,
    });
    refreshTrustedGate(fixture);
    const conflict = await runImplement(fixture, {
      config: { args: [...CONFLICTING_ARGS[toolId]] },
    });
    expect(conflict.success).toBe(false);
    expect(existsSync(conflictMarker)).toBe(false);

    installShim(fixture, 'timeout', { sleepMs: 5_000 });
    const timeoutImplementer = createCliImplementer(implementerConfig(toolId, { timeout: 50 }), {
      trustedCli: fixture.trustedGate,
    });
    let timeoutThrown: unknown;
    try {
      await timeoutImplementer.implement({
        task: makeTask({ file: 'src/contract.ts' }),
        projectDir: fixture.projectDir,
        config: makeConfig({ implementer: implementerConfig(toolId, { timeout: 50 }) }),
        context: { ...defaultContext, dir: fixture.projectDir },
        onOutput: () => {},
      });
    } catch (err) {
      timeoutThrown = err;
    }
    expect(processError.isTimeout(timeoutThrown)).toBe(true);

    if (existsSync(targetPath)) rmSync(targetPath);
    startConflictingMerge(fixture.projectDir);
    installShim(fixture, 'success-direct');
    const conflictRepo = await runImplement(fixture);
    expect(conflictRepo.success).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('generated\n');

    const adapter = CLI_IMPLEMENTER_ADAPTERS[toolId];
    const env = CREDENTIAL_ENV[toolId] ?? {};
    const previousEnv = Object.fromEntries(
      Object.keys(env).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    try {
      installShim(fixture, 'signal-exit');
      resetCapture(fixture);
      const signalResult = await invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_PLACEHOLDER,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(env),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: undefined,
        },
        prompt: FULL_PROMPT,
        callContext: {
          callId: `signal-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
      });
      expect(signalResult.status).toBe('failed');
      expect(signalResult.error?.code).toBe('signal-exit');

      installShim(fixture, 'output-flood');
      resetCapture(fixture);
      const flood = await invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_PLACEHOLDER,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(env),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: undefined,
        },
        prompt: FULL_PROMPT,
        callContext: {
          callId: `flood-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
      });
      if (adapter.outputContract.kind === 'structured-terminal') {
        expect(flood.status).toBe('truncated');
        expect(flood.error?.code).toBe('output-budget-breach');
      }

      installShim(fixture, 'success-direct');
      const callback = await invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_PLACEHOLDER,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(env),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: undefined,
        },
        prompt: FULL_PROMPT,
        callContext: {
          callId: `callback-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
        onCallEvent: (event) => {
          if (event.type === 'call_completed') throw new Error('consumer failed');
        },
      });
      expect(callback.status).toBe('failed');
      expect(callback.error?.code).toBe('callback-failure');
    } finally {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 120_000);

  it.skipIf(process.platform === 'win32')(
    'aborts and reaps descendant processes',
    async () => {
      const fixture = createFixture(toolId);
      installShim(fixture, 'abort-wait');
      resetCapture(fixture);
      refreshTrustedGate(fixture);
      const controller = new AbortController();
      const adapter = CLI_IMPLEMENTER_ADAPTERS[toolId];
      const startedMarker = join(fixture.captureDir, 'started.marker');
      const descendantPidFile = join(fixture.captureDir, 'descendant.pid');
      const invokePromise = invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_PLACEHOLDER,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: controller.signal,
        },
        prompt: FULL_PROMPT,
        callContext: {
          callId: `abort-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
      });
      for (let attempt = 0; attempt < 100 && !existsSync(startedMarker); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (let attempt = 0; attempt < 100 && !existsSync(descendantPidFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(startedMarker)).toBe(true);
      expect(existsSync(descendantPidFile)).toBe(true);
      const descendantPid = Number.parseInt(readFileSync(descendantPidFile, 'utf8'), 10);
      expect(descendantPid).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid)).toBe(false);
      controller.abort();
      const aborted = await invokePromise;
      expect(aborted.status).toBe('aborted');
      expect(aborted.error?.code).toBe('user-abort');
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(processIsAbsent(descendantPid)).toBe(true);
    },
    30_000,
  );
});

describe('T-017 stable CLI outcome taxonomy', () => {
  it('covers every declared runner outcome state', () => {
    const covered = new Set<string>([
      'success',
      'spawn-not-found',
      'incompatible-version',
      'unauthenticated',
      'timeout',
      'user-abort',
      'signal-exit',
      'non-zero-exit',
      'protocol-failure',
      'output-budget-breach',
      'callback-failure',
      'no-staged-change',
      'platform-limitation',
    ]);
    expect([...RUNNER_OUTCOME_STATES].sort()).toEqual([...covered].sort());
  });

  it('maps unsupported_tool to platform-limitation', () => {
    const result = callResult('unsupported_tool', 'unsupported-tool');
    expect(runnerCallOutcome(result).state).toBe('platform-limitation');
  });
});
