import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import { createCliImplementer } from './cli.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { processError } from '../../lib/process/errors.js';

let projectDir: string;
let shimDir: string;
let originalPath: string | undefined;

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
  model: 'auto',
  contextLength: 8192,
  temperature: 0.3,
};

function makeClaudeConfig(): Config {
  return makeConfig({ implementer: cliClaudeImplementer });
}

beforeEach(() => {
  projectDir = createTempDir('diptych-cli-impl');
  createTestGitRepo(projectDir);
  shimDir = createTempDir('diptych-cli-impl-shim');
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
    expect(result.error).toContain('without changing any files');
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

describe('createCliImplementer (opencode arg vector)', () => {
  const opencodeImplementer: CliImplementerConfig = {
    kind: 'cli',
    tool: 'opencode',
    model: 'auto',
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
});

describe('createCliImplementer (timeout surfacing)', () => {
  const opencodeImplementer: CliImplementerConfig = {
    kind: 'cli',
    tool: 'opencode',
    model: 'auto',
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
