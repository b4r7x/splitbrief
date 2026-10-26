import { createSteeringPort, deliverToRunningCall, type SteerOutcome } from '../calls/steering.js';
import { installClaudeSteeringShim } from '#testing/helpers/claude-steering-shim.js';
import { installOpencodeSteeringShim } from '#testing/helpers/opencode-steering-shim.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import { createCliImplementer as createCliImplementerImpl } from './cli.js';
import type { ImplementerFactoryOptions } from './types.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  CURSOR_MODEL_REFUSAL_FORMS,
  writeCursorRefusalShim,
} from '#testing/helpers/cursor-refusal.js';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../lib/process/spawn/lifecycle.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { ImplementerPublisher } from './types.js';

let projectDir: string;
let shimDir: string;
let restorePath: () => void;

function createCliImplementer(
  config: CliImplementerConfig,
  options?: ImplementerFactoryOptions,
): ReturnType<typeof createCliImplementerImpl> {
  return createCliImplementerImpl(config, {
    ...options,
    trustedCli: options?.trustedCli ?? trustedShimGate({ dir: shimDir, tool: config.tool }),
  });
}

function installRecordingClaudeShim(writtenRelPath: string): {
  argvFile: string;
  stdinFile: string;
} {
  return installClaudeShimWithLines(writtenRelPath, [
    '{"type":"result","result":"done","usage":{"input_tokens":5,"output_tokens":2}}',
  ]);
}

function installClaudeShimWithLines(
  writtenRelPath: string,
  terminalLines: readonly string[],
): { argvFile: string; stdinFile: string } {
  const argvFile = join(shimDir, 'argv.txt');
  const stdinFile = join(shimDir, 'stdin.txt');
  const target = join(projectDir, writtenRelPath);
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `cat > '${stdinFile}'`,
    `mkdir -p "$(dirname '${target}')"`,
    `printf '%s' 'generated' > '${target}'`,
    ...terminalLines.map((line) => `printf '%s\\n' '${line}'`),
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { argvFile, stdinFile };
}

function installTwoFileClaudeShim(relPaths: readonly string[]): void {
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/bin/bash',
    'cat > /dev/null',
    ...relPaths.flatMap((rel) => {
      const target = join(projectDir, rel);
      return [`mkdir -p "$(dirname '${target}')"`, `printf '%s' 'generated' > '${target}'`];
    }),
    `printf '%s\\n' '{"type":"result","result":"done"}'`,
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
}

function installRecordingCodexShim(
  writtenRelPath: string,
  terminalLines: readonly string[],
): { argvFile: string; stdinFile: string } {
  const argvFile = join(shimDir, 'argv.txt');
  const stdinFile = join(shimDir, 'stdin.txt');
  const target = join(projectDir, writtenRelPath);
  const shimPath = join(shimDir, 'codex');
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `cat > '${stdinFile}'`,
    `mkdir -p "$(dirname '${target}')"`,
    `printf '%s' 'generated' > '${target}'`,
    ...terminalLines.map((line) => `printf '%s\\n' '${line}'`),
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { argvFile, stdinFile };
}

const cliClaudeImplementer: CliImplementerConfig = {
  kind: 'cli',
  tool: 'claude-code',
  contextLength: 8192,
  temperature: 0.3,
};

function makeClaudeConfig(): Config {
  return makeConfig({ implementer: cliClaudeImplementer });
}

const cliCodexImplementer: CliImplementerConfig = {
  kind: 'cli',
  tool: 'codex',
  contextLength: 8192,
  temperature: 0.3,
};

function makeCodexConfig(): Config {
  return makeConfig({ implementer: cliCodexImplementer });
}

beforeEach(() => {
  projectDir = createTempDir('splitbrief-cli-impl');
  createTestGitRepo(projectDir);
  shimDir = createTempDir('splitbrief-cli-impl-shim');
  restorePath = prependPath(shimDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath();
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

it('attaches the shared steering port to the fallback implementer after a Codex refusal', async () => {
  writeFileSync(
    join(shimDir, 'codex'),
    '#!/bin/sh\ncat > /dev/null\nprintf \'%s\\n\' \'{"type":"error","message":"Insufficient Balance"}\'\nexit 1\n',
  );
  chmodSync(join(shimDir, 'codex'), 0o755);
  installClaudeSteeringShim(shimDir);
  const port = createSteeringPort();
  const task = makeTask();
  const call = {
    task,
    projectDir,
    config: makeCodexConfig(),
    context: { ...defaultContext, dir: projectDir },
    onOutput: () => {},
    steering: port,
    phase: 'implementing' as const,
    allowNoChange: true,
  };
  const refused = await createCliImplementer(cliCodexImplementer).implement(call);
  expect(refused.success).toBe(false);
  expect(port.current()).toBeNull();
  let delivery: Promise<SteerOutcome> | undefined;
  const fallback = createCliImplementer(cliClaudeImplementer, {
    trustedCli: {
      ...trustedShimGate({ dir: shimDir, tool: 'claude-code' }),
      installedVersion: '2.1.296',
    },
    publisher: {
      publishRunning: () => {},
      publishDone: () => {},
      publishFailed: () => {},
      publishWarning: () => {},
      publishCallEvent: ({ event }) => {
        if (event.type === 'call_tool_use_delta') {
          expect(port.current()).toMatchObject({ role: 'implementer', taskId: task.id });
          delivery = deliverToRunningCall(port.current(), {
            id: 'fallback',
            text: 'fallback correction',
          });
        }
      },
    },
  });
  const result = await fallback.implement({ ...call, config: makeClaudeConfig() });
  expect(result.success).toBe(true);
  expect(await delivery).toBe('delivered');
  expect(port.current()).toBeNull();
});

it('steers OpenCode through the implementer sandbox with bridged credentials and XDG paths', async () => {
  const shim = installOpencodeSteeringShim(shimDir);
  const hostHome = join(shimDir, 'host-home');
  const hostConfig = join(hostHome, '.config');
  const hostData = join(hostHome, '.local', 'share');
  mkdirSync(join(hostData, 'opencode'), { recursive: true });
  writeFileSync(
    join(hostData, 'opencode', 'auth.json'),
    JSON.stringify({ fixture: { type: 'api', key: 'fixture-provider-key-1234567890' } }),
  );
  vi.stubEnv('HOME', hostHome);
  vi.stubEnv('XDG_CONFIG_HOME', hostConfig);
  vi.stubEnv('XDG_DATA_HOME', hostData);
  vi.stubEnv('UNRELATED_HOST_SECRET', 'must-not-reach-child');
  const runner: CliImplementerConfig = {
    kind: 'cli',
    tool: 'opencode',
    authChannel: 'provider-dependent',
    contextLength: 8192,
    temperature: 0.3,
  };
  const port = createSteeringPort();
  let delivery: Promise<SteerOutcome> | undefined;
  const implementer = createCliImplementer(runner, {
    trustedCli: {
      ...trustedShimGate({ dir: shimDir, tool: 'opencode' }),
      installedVersion: '2.0.26',
    },
    publisher: {
      publishRunning: () => {},
      publishDone: () => {},
      publishFailed: () => {},
      publishWarning: () => {},
      publishCallEvent: ({ event }) => {
        if (event.type === 'call_tool_use_delta')
          delivery = deliverToRunningCall(port.current(), {
            id: 'sandbox',
            text: 'sandbox correction',
          });
      },
    },
  });
  const result = await implementer.implement({
    task: makeTask(),
    projectDir,
    config: makeConfig({ implementer: runner }),
    context: { ...defaultContext, dir: projectDir },
    onOutput: () => {},
    steering: port,
    phase: 'implementing',
    allowNoChange: true,
  });
  expect(result.success).toBe(true);
  expect(await delivery).toBe('delivered');
  const run = JSON.parse(readFileSync(shim.captureFile, 'utf8'));
  const server = JSON.parse(readFileSync(shim.serverFile, 'utf8'));
  for (const child of [run, server]) {
    expect(realpathSync(child.cwd)).toBe(realpathSync(projectDir));
    expect(child.home).not.toBe(hostHome);
    expect(child.xdgConfig).toBe(join(child.home, '..', 'config'));
    expect(child.xdgData).toBe(join(child.home, '..', 'data'));
    expect(JSON.parse(child.auth)).toEqual({
      fixture: { type: 'api', key: 'fixture-provider-key-1234567890' },
    });
    expect(child.unrelatedSecret).toBeUndefined();
    expect(processIsAbsent(child.pid)).toBe(true);
  }
  expect(run.args).toContain('--server');
  expect(run.password).toBe(shim.password);
  expect(port.current()).toBeNull();
});

describe('createCliImplementer (claude-code)', () => {
  it('invokes claude with --permission-mode acceptEdits so writes are not auto-denied', async () => {
    const { argvFile } = installRecordingClaudeShim('src/hello.ts');
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const flagIdx = argv.indexOf('--permission-mode');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(argv[flagIdx + 1]).toBe('acceptEdits');
  });

  it('reports success when the claude subprocess writes a file', async () => {
    installRecordingClaudeShim('src/hello.ts');
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(projectDir, 'src/hello.ts'), 'utf8')).toBe('generated');
  });

  it('constructs and runs a legacy config that selects no auth channel', async () => {
    installRecordingClaudeShim('src/hello.ts');
    const legacyConfig: CliImplementerConfig = {
      kind: 'cli',
      tool: 'claude-code',
      contextLength: 8192,
      temperature: 0.3,
    };

    const implementer = createCliImplementer(legacyConfig);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig({ implementer: legacyConfig }),
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(projectDir, 'src/hello.ts'), 'utf8')).toBe('generated');
  });

  it('refuses an explicit unproven API-key channel before spawning the implementer process', async () => {
    const envFile = join(shimDir, 'env.txt');
    const target = join(projectDir, 'src/hello.ts');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        `printf '%s|%s|%s' "$ANTHROPIC_API_KEY" "$OPENAI_API_KEY" "$HOME" > '${envFile}'`,
        'cat > /dev/null',
        `mkdir -p "$(dirname '${target}')"`,
        `printf generated > '${target}'`,
        `printf '%s\n' '{"type":"result","result":"done"}'`,
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalOpenAi = process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
    process.env.OPENAI_API_KEY = 'sk-openai';
    try {
      const apiKeyConfig: CliImplementerConfig = {
        ...cliClaudeImplementer,
        authChannel: 'api-key',
      };
      const implementer = createCliImplementer(apiKeyConfig);
      const result = await implementer.implement({
        task: makeTask(),
        projectDir,
        config: makeConfig({ implementer: apiKeyConfig }),
        context: { ...defaultContext, dir: projectDir },
        onOutput: () => {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Remove authChannel from this runner');
      expect(existsSync(envFile)).toBe(false);
    } finally {
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
      if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAi;
    }
  });

  it('nothing changed is no-staged-change', async () => {
    const argvFile = join(shimDir, 'argv.txt');
    const shimPath = join(shimDir, 'claude');
    const script = [
      '#!/bin/bash',
      `printf '%s\\n' "$@" > '${argvFile}'`,
      'cat > /dev/null',
      `printf '%s\\n' '{"type":"result","result":"nothing to do"}'`,
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('no-staged-change');
    expect(result.error).toContain('without changing any files');
  });

  it('a review-fix attempt that changed nothing completes and names the no-op on its done row', async () => {
    const shimPath = join(shimDir, 'claude');
    const script = [
      '#!/bin/bash',
      'cat > /dev/null',
      `printf '%s\\n' '{"type":"result","result":"already done"}'`,
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);
    const publishDone = vi.fn();
    const publisher = {
      publishRunning: vi.fn(),
      publishCallEvent: vi.fn(),
      publishDone,
      publishFailed: vi.fn(),
      publishWarning: vi.fn(),
    };

    const implementer = createCliImplementer(cliClaudeImplementer, { publisher });
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeClaudeConfig(),
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      phase: 'implementing',
      allowNoChange: true,
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBeUndefined();
    expect(publishDone).toHaveBeenCalledWith(
      expect.objectContaining({ linesAdded: 0, linesRemoved: 0, noChange: true }),
    );
    expect(publisher.publishWarning).not.toHaveBeenCalled();
  });

  it('counts the lines a direct writer changed against the attempt start', async () => {
    // init.txt is committed as `init`; notes.txt is already dirty before the call starts.
    writeFileSync(join(projectDir, 'notes.txt'), 'kept');
    const shimPath = join(shimDir, 'claude');
    const script = [
      '#!/bin/bash',
      'cat > /dev/null',
      `printf 'INIT\\nmore' > '${join(projectDir, 'init.txt')}'`,
      `printf 'kept\\nadded' > '${join(projectDir, 'notes.txt')}'`,
      `printf '%s\\n' '{"type":"result","result":"done"}'`,
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);
    const publishDone = vi.fn();
    const publisher = {
      publishRunning: vi.fn(),
      publishCallEvent: vi.fn(),
      publishDone,
      publishFailed: vi.fn(),
      publishWarning: vi.fn(),
    };

    const implementer = createCliImplementer(cliClaudeImplementer, { publisher });
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeClaudeConfig(),
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      phase: 'implementing',
    });

    expect(result.success).toBe(true);
    // init.txt: init → INIT and more (+2 -1) against HEAD; notes.txt: +1 against its dirty start.
    expect(publishDone).toHaveBeenCalledWith(
      expect.objectContaining({ linesAdded: 3, linesRemoved: 1 }),
    );
  });

  it('allowNoChange false keeps nothing changed a no-staged-change failure', async () => {
    const shimPath = join(shimDir, 'claude');
    const script = [
      '#!/bin/bash',
      'cat > /dev/null',
      `printf '%s\\n' '{"type":"result","result":"nothing to do"}'`,
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeClaudeConfig(),
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      allowNoChange: false,
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('no-staged-change');
  });

  it('a review-fix attempt that changed nothing after a usage limit on stderr is still usage-limit', async () => {
    const shimPath = join(shimDir, 'claude');
    const script = [
      '#!/bin/bash',
      'cat > /dev/null',
      `printf '%s\\n' 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)' >&2`,
      `printf '%s\\n' '{"type":"result","result":"nothing to do"}'`,
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeClaudeConfig(),
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      allowNoChange: true,
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('usage-limit');
  });

  it('a child that changed nothing after a usage limit on stderr is usage-limit', async () => {
    const shimPath = join(shimDir, 'claude');
    // Captured live from `agy -p` on 2026-09-21: the first limit hit exits 0.
    const script = [
      '#!/bin/bash',
      'cat > /dev/null',
      `printf '%s\\n' 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)' >&2`,
      `printf '%s\\n' '{"type":"result","result":"nothing to do"}'`,
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeClaudeConfig(),
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('usage-limit');
    expect(result.error).toContain('Individual quota reached');
  });

  it('refuses a configured outputFormat that would replace the structured-terminal parser', async () => {
    installRecordingShim('claude', 'src/hello.ts');
    const implementerConfig: CliImplementerConfig = {
      ...cliClaudeImplementer,
      outputFormat: 'text',
    };
    const config = makeConfig({ implementer: implementerConfig });

    const implementer = createCliImplementer(implementerConfig);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    // REQ-018: user configuration cannot replace the backend's terminal
    // protocol; the refusal happens before any spawn.
    expect(result.success).toBe(false);
    expect(result.error).toContain('outputFormat');
    expect(existsSync(join(shimDir, 'argv.txt'))).toBe(false);
  });

  it('by default an undeclared src/unrelated.ts write succeeds and stays on disk', async () => {
    installRecordingClaudeShim('src/unrelated.ts');
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(projectDir, 'src/unrelated.ts'), 'utf8')).toBe('generated');
  });

  it('a caller that rejects undeclared writes gets implementer-effect-invalid naming the file', async () => {
    installRecordingClaudeShim('src/unrelated.ts');
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      undeclaredWrites: 'reject',
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('implementer-effect-invalid');
    expect(result.error).toContain("wrote outside the brief's declared files: src/unrelated.ts");
    expect(readFileSync(join(projectDir, 'src/unrelated.ts'), 'utf8')).toBe('generated');
  });

  it('anchor plus declared test file succeeds', async () => {
    installTwoFileClaudeShim(['src/hello.ts', 'src/hello.test.ts']);
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask({ suggestedFiles: ['src/hello.ts', 'src/hello.test.ts'] }),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(projectDir, 'src/hello.test.ts'), 'utf8')).toBe('generated');
  });

  it('approved out-of-bounds file alone succeeds', async () => {
    installRecordingClaudeShim('src/shared/types.ts');
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask({ scope: { approvedOutOfBounds: ['src/shared/types.ts'] } }),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
  });

  it('applies no deadline when timeout is unset', async () => {
    installRecordingClaudeShim('src/hello.ts');
    const config = makeClaudeConfig();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    try {
      const implementer = createCliImplementer(cliClaudeImplementer);
      const result = await implementer.implement({
        task: makeTask(),
        projectDir,
        config,
        context: { ...defaultContext, dir: projectDir },
        onOutput: () => {},
      });

      expect(result.success).toBe(true);
      expect(cliClaudeImplementer.timeout).toBeUndefined();
      expect(timeoutSpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('applies a configured deadline when timeout is set', async () => {
    installRecordingClaudeShim('src/hello.ts');
    const customClaudeImplementer: CliImplementerConfig = {
      ...cliClaudeImplementer,
      timeout: 5_000,
    };
    const config = makeConfig({ implementer: customClaudeImplementer });
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    try {
      const implementer = createCliImplementer(customClaudeImplementer);
      const result = await implementer.implement({
        task: makeTask(),
        projectDir,
        config,
        context: { ...defaultContext, dir: projectDir },
        onOutput: () => {},
      });

      expect(result.success).toBe(true);
      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('reports result usage from the structured terminal as implementer usage', async () => {
    installRecordingClaudeShim('src/hello.ts');
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      counterCoverage: {
        input: 'reported',
        output: 'partial',
        cacheRead: 'missing',
        cacheCreate: 'missing',
        reasoning: 'missing',
      },
      providerTotals: { output: 2 },
    });
  });

  it('prefers terminal usage over mid-stream usage samples', async () => {
    installClaudeShimWithLines('src/hello.ts', [
      '{"type":"stream_event","event":{"type":"message_delta","usage":{"input_tokens":5,"output_tokens":2}}}',
      '{"type":"result","result":"done","usage":{"input_tokens":100,"output_tokens":40}}',
    ]);
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      counterCoverage: {
        input: 'reported',
        output: 'partial',
        cacheRead: 'missing',
        cacheCreate: 'missing',
        reasoning: 'missing',
      },
      providerTotals: { output: 40 },
    });
  });

  it('keeps mid-stream usage when the terminal result carries none', async () => {
    installClaudeShimWithLines('src/hello.ts', [
      '{"type":"stream_event","event":{"type":"message_delta","usage":{"input_tokens":5,"output_tokens":2}}}',
      '{"type":"result","result":"done"}',
    ]);
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      counterCoverage: {
        input: 'reported',
        output: 'partial',
        cacheRead: 'missing',
        cacheCreate: 'missing',
        reasoning: 'missing',
      },
      providerTotals: { output: 2 },
    });
  });
});

describe('createCliImplementer (exact-effect gate fixtures)', () => {
  function removeGit(): void {
    rmSync(join(projectDir, '.git'), { recursive: true, force: true });
  }

  it('passes on the file-hashes path when the child creates exactly the declared file', async () => {
    removeGit();
    installRecordingClaudeShim('src/hello.ts');
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(projectDir, 'src/hello.ts'), 'utf8')).toBe('generated');
  });

  it('fails on the file-hashes path when the child modifies the declared file and adds an extra new file', async () => {
    removeGit();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/hello.ts'), 'original', 'utf8');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        'mkdir -p src',
        "printf '%s' 'generated' > src/hello.ts",
        "printf '%s' 'extra' > notes.md",
        `printf '%s\\n' '{"type":"result","result":"done"}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      undeclaredWrites: 'reject',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("wrote outside the brief's declared files: notes.md");
  });

  it('fails with no-staged-change on the file-hashes path when the child changes nothing', async () => {
    removeGit();
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        `printf '%s\\n' '{"type":"result","result":"nothing to do"}'`,
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('no-staged-change');
    expect(result.error).toContain('without changing any files');
  });

  it('counts a file dirty before the call and edited by it when the workspace declares file hashes', async () => {
    writeFileSync(join(projectDir, 'notes.md'), 'dirty before the call', 'utf8');
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        "printf '%s' 'edited by the call' > notes.md",
        `printf '%s\\n' '{"type":"result","result":"done"}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeClaudeConfig(),
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      changeDetection: 'file-hashes',
    });

    expect(result.outcome).not.toBe('no-staged-change');
    expect(result.success).toBe(true);
    expect(readFileSync(join(projectDir, 'notes.md'), 'utf8')).toBe('edited by the call');
  });

  it.each(['git-status', 'file-hashes'] as const)(
    'counts a call that only makes the declared file executable on the %s path',
    async (changeDetection) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src/hello.ts'), 'original', 'utf8');
      chmodSync(join(projectDir, 'src/hello.ts'), 0o644);
      const shimPath = join(shimDir, 'claude');
      writeFileSync(
        shimPath,
        [
          '#!/bin/bash',
          'cat > /dev/null',
          'chmod 755 src/hello.ts',
          `printf '%s\\n' '{"type":"result","result":"done"}'`,
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(shimPath, 0o755);

      const implementer = createCliImplementer(cliClaudeImplementer);
      const result = await implementer.implement({
        task: makeTask(),
        projectDir,
        config: makeClaudeConfig(),
        context: { ...defaultContext, dir: projectDir },
        onOutput: () => {},
        changeDetection,
        undeclaredWrites: 'reject',
      });

      expect(result.outcome).not.toBe('no-staged-change');
      expect(result.success).toBe(true);
    },
  );

  it('passes on the git-status path when the child writes to its sandbox home beside the declared file', async () => {
    const target = join(projectDir, 'src/hello.ts');
    const sandboxHomeFile = join(
      projectDir,
      '.splitbrief',
      'sandbox',
      'implementer',
      'claude-code',
      'home',
      '.claude.json',
    );
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        `mkdir -p "$(dirname '${target}')"`,
        `printf '%s' 'generated' > '${target}'`,
        `mkdir -p "$(dirname '${sandboxHomeFile}')"`,
        `printf '%s' '{}' > '${sandboxHomeFile}'`,
        `printf '%s\\n' '{"type":"result","result":"done"}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('generated');
  });

  it('rejects a non-internal extra write even when the child also writes its sandbox home, so the carve-out above is per-path and not per-run', async () => {
    const sandboxHomeFile = join(
      projectDir,
      '.splitbrief',
      'sandbox',
      'implementer',
      'claude-code',
      'home',
      '.claude.json',
    );
    const shimPath = join(shimDir, 'claude');
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat > /dev/null',
        'mkdir -p src',
        "printf '%s' 'generated' > src/hello.ts",
        `mkdir -p "$(dirname '${sandboxHomeFile}')"`,
        `printf '%s' '{}' > '${sandboxHomeFile}'`,
        "printf '%s' 'extra' > notes.md",
        `printf '%s\\n' '{"type":"result","result":"done"}'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    const config = makeClaudeConfig();

    const implementer = createCliImplementer(cliClaudeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      undeclaredWrites: 'reject',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("wrote outside the brief's declared files: notes.md");
    expect(result.error).not.toContain('.splitbrief');
    expect(existsSync(sandboxHomeFile)).toBe(true);
  });
});

it.each(['implement', 'retry'] as const)(
  'sends Claude correction images outside the project as content blocks on %s',
  async (method) => {
    const { argvFile, stdinFile } = installRecordingClaudeShim('src/hello.ts');
    const imagePath = join(shimDir, 'reference.data');
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    writeFileSync(imagePath, bytes);
    const call = {
      task: makeTask(),
      projectDir,
      config: makeClaudeConfig(),
      context: defaultContext,
      onOutput: () => {},
      images: [
        {
          id: 'reference',
          kind: 'image' as const,
          path: imagePath,
          mimeType: 'image/png',
          sizeBytes: bytes.length,
        },
      ],
      continuation: { steer: 'Use the screenshot.' },
    };
    const implementer = createCliImplementer(cliClaudeImplementer);
    const result =
      method === 'implement'
        ? await implementer.implement(call)
        : await implementer.retry({ ...call, kind: 'local', attempt: 1, error: 'fix layout' });
    expect(result.success).toBe(true);
    const args = readArgv(argvFile);
    expect(args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2)).toEqual([
      '--input-format',
      'stream-json',
    ]);
    const stdin = readFileSync(stdinFile, 'utf8');
    const content = JSON.parse(stdin).message.content;
    expect(content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('Use the screenshot.'),
    });
    expect(content.slice(1)).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
      },
    ]);
    expect(stdin).toBe(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  },
);

describe('createCliImplementer (codex usage capture)', () => {
  it.each(['implement', 'retry'] as const)(
    'passes correction images to Codex on %s and retains the prompt paths',
    async (method) => {
      const { argvFile, stdinFile } = installRecordingCodexShim('src/hello.ts', [
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
      ]);
      const imagePath = join(projectDir, 'reference.png');
      writeFileSync(imagePath, 'image fixture');
      const call = {
        task: makeTask(),
        projectDir,
        config: makeCodexConfig(),
        context: defaultContext,
        onOutput: vi.fn(),
        images: [
          {
            id: 'reference',
            kind: 'image' as const,
            path: imagePath,
            mimeType: 'image/png',
            sizeBytes: 13,
          },
        ],
        continuation: { steer: `Use the screenshot.\n[image:reference] = ${imagePath}` },
      };
      const implementer = createCliImplementer(cliCodexImplementer);
      const result =
        method === 'implement'
          ? await implementer.implement(call)
          : await implementer.retry({ ...call, kind: 'local', attempt: 1, error: 'fix layout' });
      expect(result.success).toBe(true);
      const args = readArgv(argvFile);
      const imageIndex = args.indexOf('--image');
      expect(imageIndex).toBeGreaterThan(-1);
      expect(args[imageIndex + 1]).toBe(imagePath);
      expect(args.filter((arg) => arg === '--image')).toHaveLength(1);
      expect(readFileSync(stdinFile, 'utf8')).toContain(`[image:reference] = ${imagePath}`);
    },
  );

  it('reports turn usage as implementer usage, excluding cached input from input tokens', async () => {
    const { argvFile, stdinFile } = installRecordingCodexShim('src/hello.ts', [
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4,"cached_input_tokens":6}}',
    ]);
    const config = makeCodexConfig();

    const implementer = createCliImplementer(cliCodexImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(readArgv(argvFile).at(-1)).toBe('-');
    expect(readFileSync(stdinFile, 'utf8')).toContain('src/hello.ts');
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 4,
      cacheReadTokens: 6,
      counterCoverage: {
        input: 'reported',
        output: 'partial',
        cacheRead: 'reported',
        cacheCreate: 'missing',
        reasoning: 'missing',
      },
      providerTotals: { input: 10, output: 4 },
    });
  });

  it('succeeds and reports no usage when the turn carries no usage key', async () => {
    installRecordingCodexShim('src/hello.ts', ['{"type":"turn.completed"}']);
    const config = makeCodexConfig();

    const implementer = createCliImplementer(cliCodexImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.usage).toBeUndefined();
  });
});

function installRecordingShim(
  command: string,
  writtenRelPath: string,
): { argvFile: string; stdinFile: string } {
  const argvFile = join(shimDir, 'argv.txt');
  const stdinFile = join(shimDir, 'stdin.txt');
  const target = join(projectDir, writtenRelPath);
  const shimPath = join(shimDir, command);
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `cat > '${stdinFile}'`,
    `mkdir -p "$(dirname '${target}')"`,
    `printf '%s' 'generated' > '${target}'`,
    `printf '%s\\n' 'done'`,
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { argvFile, stdinFile };
}

function readArgv(argvFile: string): string[] {
  return readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
}

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

describe('createCliImplementer (opencode arg vector)', () => {
  const opencodeImplementer: CliImplementerConfig = {
    kind: 'cli',
    tool: 'opencode',
    authChannel: 'provider-dependent',
    contextLength: 8192,
    temperature: 0.3,
  };

  it('spawns opencode with the `run` subcommand as the first arg and the prompt on stdin', async () => {
    const { argvFile, stdinFile } = installRecordingShim('opencode', 'src/hello.ts');
    const config = makeConfig({ implementer: opencodeImplementer });

    const implementer = createCliImplementer(opencodeImplementer);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    const argv = readArgv(argvFile);
    expect(argv[0]).toBe('run');
    expect(argv.join(' ')).not.toContain('src/hello.ts');
    expect(readFileSync(stdinFile, 'utf8')).toContain('src/hello.ts');
  });

  it('checks availability without executing the implementer command', async () => {
    const markerFile = join(shimDir, 'availability-ran.txt');
    const shimPath = join(shimDir, 'opencode');
    writeFileSync(
      shimPath,
      ['#!/bin/bash', `printf ran > '${markerFile}'`, 'exit 2'].join('\n') + '\n',
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const implementer = createCliImplementer(opencodeImplementer);

    expect(await implementer.isAvailable()).toBe(true);
    expect(await implementer.getVersion()).toBeNull();
    expect(existsSync(markerFile)).toBe(false);
  });

  it('places an explicit --model under the `run` subcommand', async () => {
    const { argvFile, stdinFile } = installRecordingShim('opencode', 'src/hello.ts');
    const withModel: CliImplementerConfig = { ...opencodeImplementer, model: 'qwen2.5-coder:7b' };
    const config = makeConfig({ implementer: withModel });

    const implementer = createCliImplementer(withModel);
    await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    const argv = readArgv(argvFile);
    expect(argv.slice(0, 3)).toEqual(['run', '--model', 'qwen2.5-coder:7b']);
    expect(readFileSync(stdinFile, 'utf8')).toContain('src/hello.ts');
  });

  it.each(['auto', 'AUTO', '  auto  ', undefined])(
    'omits --model entirely for automatic selection (%j) so the tool keeps its own default',
    async (model) => {
      const { argvFile } = installRecordingShim('opencode', 'src/hello.ts');
      const automatic: CliImplementerConfig = {
        ...opencodeImplementer,
        ...(model === undefined ? {} : { model }),
      };
      const config = makeConfig({ implementer: automatic });

      const implementer = createCliImplementer(automatic);
      await implementer.implement({
        task: makeTask(),
        projectDir,
        config,
        context: { ...defaultContext, dir: projectDir },
        onOutput: () => {},
      });

      expect(readArgv(argvFile)).not.toContain('--model');
    },
  );

  it('emits --effort on the claude-code implementer argv when the config sets it', async () => {
    const { argvFile } = installRecordingClaudeShim('src/hello.ts');
    const withEffort: CliImplementerConfig = { ...cliClaudeImplementer, effort: 'high' };
    const config = makeConfig({ implementer: withEffort });

    const implementer = createCliImplementer(withEffort);
    await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    const argv = readArgv(argvFile);
    expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual([
      '--effort',
      'high',
    ]);
  });

  it('emits --variant on the opencode implementer argv when the config sets it', async () => {
    const { argvFile } = installRecordingShim('opencode', 'src/hello.ts');
    const withVariant: CliImplementerConfig = {
      ...opencodeImplementer,
      model: 'openai/gpt-5.6-luna',
      variant: 'xhigh',
    };
    const config = makeConfig({ implementer: withVariant });

    const implementer = createCliImplementer(withVariant);
    await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    const argv = readArgv(argvFile);
    expect(argv.slice(0, 5)).toEqual([
      'run',
      '--model',
      'openai/gpt-5.6-luna',
      '--variant',
      'xhigh',
    ]);
  });

  it('emits neither flag when the config sets neither', async () => {
    const { argvFile } = installRecordingShim('opencode', 'src/hello.ts');
    const config = makeConfig({ implementer: opencodeImplementer });

    const implementer = createCliImplementer(opencodeImplementer);
    await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    const argv = readArgv(argvFile);
    expect(argv).not.toContain('--variant');
    expect(argv).not.toContain('--effort');
  });

  it('retry() drives the same `run` arg vector and reports success on a file change', async () => {
    const { argvFile } = installRecordingShim('opencode', 'src/hello.ts');
    const config = makeConfig({ implementer: opencodeImplementer });

    const implementer = createCliImplementer(opencodeImplementer);
    const result = await implementer.retry({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      error: 'previous attempt failed',
      attempt: 1,
      kind: 'local',
    });

    expect(result.success).toBe(true);
    expect(readArgv(argvFile)[0]).toBe('run');
  });

  it('appends cfg.args to the spawned argv after the tool-built args', async () => {
    const { argvFile } = installRecordingShim('opencode', 'src/hello.ts');
    const withArgs: CliImplementerConfig = {
      ...opencodeImplementer,
      args: ['--extra-flag', 'value'],
    };
    const config = makeConfig({ implementer: withArgs });

    const implementer = createCliImplementer(withArgs);
    await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    const argv = readArgv(argvFile);
    expect(argv[0]).toBe('run');
    expect(argv.slice(-2)).toEqual(['--extra-flag', 'value']);
  });

  it('warns on an over-long stdout line and completes through the real CLI path', async () => {
    const pidsFile = join(shimDir, 'pids.txt');
    const shimPath = join(shimDir, 'opencode');
    const script = [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(pidsFile)}, String(process.pid));`,
      `process.stdout.write('x'.repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 10}));`,
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);
    const config = makeConfig({ implementer: opencodeImplementer });
    const events: RunnerCallEvent[] = [];
    const publisher: ImplementerPublisher = {
      publishRunning: () => {},
      publishCallEvent: ({ event }) => events.push(event),
      publishDone: () => {},
      publishFailed: () => {},
      publishWarning: () => {},
    };

    const implementer = createCliImplementer(opencodeImplementer, { publisher });
    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      phase: 'implementing',
    });
    const leaderPid = Number.parseInt(readFileSync(pidsFile, 'utf8'), 10);

    expect(result).toMatchObject({ success: false, outcome: 'no-staged-change' });
    expect(
      events.filter((event) => event.type === 'call_warning').map((event) => event.warning.code),
    ).toContain('stdout_line_overflow');
    expect(leaderPid).toBeGreaterThan(1);
    expect(processIsAbsent(leaderPid)).toBe(true);
  });
});

describe('createCliImplementer (cursor account refusal)', () => {
  const cursorImplementer: CliImplementerConfig = {
    kind: 'cli',
    tool: 'cursor',
    model: 'claude-haiku-5-5-thinking-high',
    contextLength: 32768,
    temperature: 0.3,
  };

  it.each(CURSOR_MODEL_REFUSAL_FORMS)(
    'a model refusal in the %s form on stderr with exit 1 is a usage limit in the tool words',
    async (_form, refusal) => {
      writeCursorRefusalShim(shimDir, { stderr: refusal });

      const result = await createCliImplementer(cursorImplementer).implement({
        task: makeTask(),
        projectDir,
        config: makeConfig({ implementer: cursorImplementer }),
        context: { ...defaultContext, dir: projectDir },
        onOutput: () => {},
      });

      expect(result).toMatchObject({ success: false, outcome: 'usage-limit' });
      expect(result.error).toContain(refusal);
    },
  );
});

describe('createCliImplementer (timeout surfacing)', () => {
  const opencodeImplementer: CliImplementerConfig = {
    kind: 'cli',
    tool: 'opencode',
    authChannel: 'provider-dependent',
    contextLength: 8192,
    temperature: 0.3,
    timeout: 50,
  };

  it('returns a tiny-timeout slow command as a timed-out call, not a generic abort', async () => {
    const shimPath = join(shimDir, 'opencode');
    writeFileSync(shimPath, '#!/bin/bash\ncat > /dev/null\nsleep 5\n', 'utf8');
    chmodSync(shimPath, 0o755);
    const config = makeConfig({ implementer: opencodeImplementer });

    const implementer = createCliImplementer(opencodeImplementer);

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config,
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
    });

    expect(result).toMatchObject({ success: false, outcome: 'timeout' });
    expect(result.error).toBe('OpenCode CLI timed out after 0s');
  });
});

it.each(['implement', 'retry'] as const)(
  'forwards steering from %s through the pipeline and CLI wrapper',
  async (method) => {
    installClaudeSteeringShim(shimDir);
    const port = createSteeringPort();
    const sends: Promise<SteerOutcome>[] = [];
    let started = false;
    const implementer = createCliImplementer(cliClaudeImplementer, {
      trustedCli: {
        ...trustedShimGate({ dir: shimDir, tool: 'claude-code' }),
        installedVersion: '2.1.296',
      },
      publisher: {
        publishRunning: () => {},
        publishDone: () => {},
        publishFailed: () => {},
        publishWarning: () => {},
        publishCallEvent: ({ event }) => {
          if (event.type === 'call_tool_use_delta' && !started) {
            started = true;
            sends.push(deliverToRunningCall(port.current(), { id: 'forwarded', text: 'steer' }));
          }
        },
      },
    });
    const options = {
      task: makeTask(),
      projectDir,
      config: makeClaudeConfig(),
      context: { ...defaultContext, dir: projectDir },
      onOutput: () => {},
      steering: port,
      phase: 'implementing' as const,
      allowNoChange: true,
    };
    const result =
      method === 'implement'
        ? await implementer.implement(options)
        : await implementer.retry({ ...options, error: 'retry', attempt: 1, kind: 'local' });
    expect(result.success).toBe(true);
    expect(await Promise.all(sends)).toEqual(['delivered']);
    expect(port.current()).toBeNull();
  },
);
