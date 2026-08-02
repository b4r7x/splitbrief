import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import { createCliImplementer as createCliImplementerImpl } from './cli.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { CliStartGate } from '../runners/start-gate.js';
import type { ImplementerFactoryOptions } from './types.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { processError } from '../../lib/process/errors.js';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../lib/process/spawn/lifecycle.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { ImplementerPublisher } from './types.js';

let projectDir: string;
let shimDir: string;
let originalPath: string | undefined;

/**
 * Production CLI runners require an explicit identity admitted by readiness.
 * The test shims are real executable files, so derive the same canonical
 * path/fingerprint that readiness would provide instead of bypassing the gate.
 */
function trustedGate(tool: CliToolId): CliStartGate {
  const commandPath = join(shimDir, CLI_TOOL_CATALOG[tool].command);
  if (!existsSync(commandPath)) {
    writeFileSync(commandPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(commandPath, 0o755);
  }
  const path = realpathSync(commandPath);
  const info = statSync(path);
  return {
    tool,
    executable: {
      path,
      fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    },
  };
}

function createCliImplementer(
  config: CliImplementerConfig,
  options?: ImplementerFactoryOptions,
): ReturnType<typeof createCliImplementerImpl> {
  return createCliImplementerImpl(config, {
    ...options,
    trustedCli: options?.trustedCli ?? trustedGate(config.tool),
  });
}

function installRecordingClaudeShim(writtenRelPath: string): { argvFile: string } {
  const argvFile = join(shimDir, 'argv.txt');
  const target = join(projectDir, writtenRelPath);
  const shimPath = join(shimDir, 'claude');
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$@" > '${argvFile}'`,
    'cat > /dev/null',
    `mkdir -p "$(dirname '${target}')"`,
    `printf '%s' 'generated' > '${target}'`,
    `printf '%s\\n' '{"type":"result","result":"done","usage":{"input_tokens":5,"output_tokens":2}}'`,
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { argvFile };
}

const cliClaudeImplementer: CliImplementerConfig = {
  kind: 'cli',
  tool: 'claude-code',
  authChannel: 'session',
  contextLength: 8192,
  temperature: 0.3,
};

function makeClaudeConfig(): Config {
  return makeConfig({ implementer: cliClaudeImplementer });
}

beforeEach(() => {
  projectDir = createTempDir('splitbrief-cli-impl');
  createTestGitRepo(projectDir);
  shimDir = createTempDir('splitbrief-cli-impl-shim');
  originalPath = process.env['PATH'];
  process.env['PATH'] = `${shimDir}:${originalPath ?? ''}`;
});

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env['PATH'];
  } else {
    process.env['PATH'] = originalPath;
  }
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
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

  it('passes only the selected API-key channel to the implementer process', async () => {
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

      expect(result.success).toBe(true);
      expect(readFileSync(envFile, 'utf8')).toBe(
        `sk-anthropic||${join(projectDir, '.splitbrief', 'sandbox', 'home')}`,
      );
    } finally {
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
      if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAi;
    }
  });

  it('fails when the claude subprocess changes no files', async () => {
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

  it('completes with a configured outputFormat that replaces the structured-terminal parser', async () => {
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

    expect(result.success).toBe(true);
  });
});

function installRecordingShim(command: string, writtenRelPath: string): { argvFile: string } {
  const argvFile = join(shimDir, 'argv.txt');
  const target = join(projectDir, writtenRelPath);
  const shimPath = join(shimDir, command);
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$@" > '${argvFile}'`,
    'cat > /dev/null',
    `mkdir -p "$(dirname '${target}')"`,
    `printf '%s' 'generated' > '${target}'`,
    `printf '%s\\n' 'done'`,
  ].join('\n');
  writeFileSync(shimPath, `${script}\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return { argvFile };
}

function readArgv(argvFile: string): string[] {
  return readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
}

function processGroupIsAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
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

  it('spawns opencode with the `run` subcommand as the first arg so the prompt is not read as a project dir', async () => {
    const { argvFile } = installRecordingShim('opencode', 'src/hello.ts');
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
    expect(argv.at(-1)).toContain('src/hello.ts');
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

  it('places an explicit --model under the `run` subcommand, before the prompt positional', async () => {
    const { argvFile } = installRecordingShim('opencode', 'src/hello.ts');
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
    expect(argv.at(-1)).toContain('src/hello.ts');
  });

  it.each([
    'auto',
    'AUTO',
    '  auto  ',
    undefined,
  ])('omits --model entirely for automatic selection (%j) so the tool keeps its own default', async (model) => {
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

  it('preserves a typed budget failure and group reaping through the real CLI path', async () => {
    const pidsFile = join(shimDir, 'pids.txt');
    const shimPath = join(shimDir, 'opencode');
    const script = [
      '#!/usr/bin/env node',
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 25)'], { stdio: 'ignore' });",
      'child.unref();',
      `writeFileSync(${JSON.stringify(pidsFile)}, process.pid + ':' + child.pid);`,
      `process.stdout.write('x'.repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 10}));`,
    ].join('\n');
    writeFileSync(shimPath, `${script}\n`, 'utf8');
    chmodSync(shimPath, 0o755);
    const config = makeConfig({ implementer: opencodeImplementer });
    let events: RunnerCallEvent[] = [];
    const publisher: ImplementerPublisher = {
      publishRunning: () => {},
      publishCallEvent: ({ event }) => events.push(event),
      publishDone: () => {},
      publishFailed: () => {},
    };

    const implementer = createCliImplementer(opencodeImplementer, { publisher });
    for (let iteration = 1; iteration <= 50; iteration += 1) {
      let leaderPid = 0;
      let descendantPid = 0;
      let absentAtSettlement = { group: false, leader: false, descendant: false };
      const result = await implementer
        .implement({
          task: makeTask(),
          projectDir,
          config,
          context: { ...defaultContext, dir: projectDir },
          onOutput: () => {},
          phase: 'implementing',
        })
        .then((value) => {
          const [leader, descendant] = readFileSync(pidsFile, 'utf8').split(':');
          leaderPid = Number.parseInt(leader ?? '', 10);
          descendantPid = Number.parseInt(descendant ?? '', 10);
          absentAtSettlement = {
            group: processGroupIsAbsent(leaderPid),
            leader: processIsAbsent(leaderPid),
            descendant: processIsAbsent(descendantPid),
          };
          return value;
        });

      expect(result, `iteration ${iteration}`).toMatchObject({
        success: false,
        error: expect.stringContaining('CLI output line exceeded the line byte budget'),
      });
      expect(
        events.filter((event) => event.type === 'call_error'),
        `iteration ${iteration}`,
      ).toEqual([
        expect.objectContaining({
          status: 'truncated',
          error: {
            code: 'output-budget-breach',
            message: 'CLI output line exceeded the line byte budget',
          },
        }),
      ]);
      expect(leaderPid, `iteration ${iteration}`).toBeGreaterThan(1);
      expect(descendantPid, `iteration ${iteration}`).toBeGreaterThan(1);
      expect(absentAtSettlement, `iteration ${iteration}`).toEqual({
        group: true,
        leader: true,
        descendant: true,
      });
      events = [];
    }
  }, 60_000);
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

  it('surfaces a tiny-timeout slow command as processError.timeout, not a generic abort', async () => {
    const shimPath = join(shimDir, 'opencode');
    writeFileSync(shimPath, '#!/bin/bash\ncat > /dev/null\nsleep 5\n', 'utf8');
    chmodSync(shimPath, 0o755);
    const config = makeConfig({ implementer: opencodeImplementer });

    const implementer = createCliImplementer(opencodeImplementer);

    let thrown: unknown;
    try {
      await implementer.implement({
        task: makeTask(),
        projectDir,
        config,
        context: { ...defaultContext, dir: projectDir },
        onOutput: () => {},
      });
    } catch (err) {
      thrown = err;
    }

    expect(processError.isTimeout(thrown)).toBe(true);
    expect((thrown as Error).message).not.toMatch(/operation was aborted/i);
  });
});
