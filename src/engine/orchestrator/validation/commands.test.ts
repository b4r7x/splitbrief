import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createValidator } from './run.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { Task } from '../../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { processError } from '../../../lib/process/errors.js';
import {
  makeConfig,
  makeCommandRunner,
  type RecordingCommandRunner,
} from '#testing/helpers/validation-fixtures.js';

function expectCommandRanInProject(runner: RecordingCommandRunner, projectDir: string): void {
  expect(runner.calls.at(-1)?.options?.cwd).toBe(projectDir);
}

describe('layer priority', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-layer');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function mkTask(file: string): Task {
    return makeTask({ file, action: 'modify' });
  }

  const fakeBus = { publish: () => {}, subscribe: () => () => {} };

  it('config wins over discovered', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheckCommand: 'mypy src/', lint: false, test: false });
    const discovered: DiscoveredValidation = { typecheckCommand: 'cargo check' };

    const results = await validator.runValidation({
      task: mkTask('src/main.py'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      discoveredValidation: discovered,
    });

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('mypy src/');
    expectCommandRanInProject(runner, tempDir);
  });

  it('discovered wins over heuristic', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ lint: false, test: false });
    const discovered: DiscoveredValidation = { typecheckCommand: 'cargo check' };
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');

    const results = await validator.runValidation({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      discoveredValidation: discovered,
    });

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('cargo check');
    expectCommandRanInProject(runner, tempDir);
  });

  it('heuristic fallback when no config and no discovered', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ lint: false, test: false });
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');

    const results = await validator.runValidation({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('cargo check');
    expectCommandRanInProject(runner, tempDir);
  });

  it('runs the heuristic cargo test when the loaded config sets no test_command', async () => {
    const configDir = join(tempDir, SPLITBRIEF_DIR);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      YAML.stringify({ validation: { typecheck: false, lint: false, test: true } }),
      'utf-8',
    );
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');

    const { config } = loadConfig(tempDir);
    expect(config.validation.testCommand).toBeUndefined();

    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });

    const results = await validator.runValidation({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.find((r) => r.stage === 'test')?.output).toBe('cargo test');
    expect(runner.calls.at(-1)?.cmd).toBe('cargo');
    expect(runner.calls.at(-1)?.args).toEqual(['test']);
    expectCommandRanInProject(runner, tempDir);
  });

  it('lint stage records a skipped result when no layer provides a command', async () => {
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({ typecheck: false, lint: true, test: false });

    const results = await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const lintResult = results.find((r) => r.stage === 'lint');
    expect(lintResult).toMatchObject({ stage: 'lint', passed: true, skipped: true });
  });

  it('ENOENT skips gracefully', async () => {
    const enoent = Object.assign(new Error('spawn cargo ENOENT'), { code: 'ENOENT' });
    const validator = createValidator({ runCommand: makeCommandRunner(enoent) });

    const config = makeConfig({ lint: false, test: false });
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');

    const results = await validator.runValidation({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const tc = results.find((r) => r.stage === 'typecheck');
    expect(tc).toMatchObject({ stage: 'typecheck', passed: true, skipped: true });
    expect(tc?.output).toContain('not found');
  });

  it('skips a heuristic lint command when the cargo subcommand is missing (rustup minimal)', async () => {
    const missingClippy = processError.exitCode({
      command: 'cargo',
      label: 'lint validation',
      code: 101,
      stderr: 'error: no such command: `clippy`',
      output: '',
    });
    const validator = createValidator({ runCommand: makeCommandRunner(missingClippy) });
    const config = makeConfig({ typecheck: false, lint: true, test: false });
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');

    const results = await validator.runValidation({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const lint = results.find((r) => r.stage === 'lint');
    expect(lint).toMatchObject({ stage: 'lint', passed: true, skipped: true });
  });

  it('still fails a configured command that exits 101 with a missing-subcommand signature', async () => {
    const missingSubcommand = processError.exitCode({
      command: 'cargo',
      label: 'lint validation',
      code: 101,
      stderr: 'error: no such command: `clippy`',
      output: '',
    });
    const validator = createValidator({ runCommand: makeCommandRunner(missingSubcommand) });
    const config = makeConfig({
      typecheck: false,
      lint: true,
      lintCommand: 'cargo clippy --no-deps',
      test: false,
    });
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');

    const results = await validator.runValidation({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const lint = results.find((r) => r.stage === 'lint');
    expect(lint?.passed).toBe(false);
    expect(lint?.skipped).toBeUndefined();
  });

  it('fails when a configured validation command is not found', async () => {
    const enoent = Object.assign(new Error('spawn missing-typecheck ENOENT'), { code: 'ENOENT' });
    const validator = createValidator({ runCommand: makeCommandRunner(enoent) });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'missing-typecheck --strict',
      lint: false,
      test: false,
    });

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const tc = results.find((r) => r.stage === 'typecheck');
    expect(tc).toMatchObject({
      passed: false,
      stage: 'typecheck',
    });
    expect(tc?.error).toContain('Configured typecheck command not found: missing-typecheck');
  });

  it('records a skipped typecheck on a non-TS project instead of running tsc', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'package.json'), '{"name":"plain"}');

    const results = await validator.runValidation({
      task: mkTask('src/app.js'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.find((r) => r.stage === 'typecheck')).toMatchObject({
      stage: 'typecheck',
      passed: true,
      skipped: true,
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('skips typecheck on a Python project instead of falling back to tsc', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'pyproject.toml'), '[tool.pytest]');

    const results = await validator.runValidation({
      task: mkTask('src/app.py'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.find((r) => r.stage === 'typecheck')).toMatchObject({
      stage: 'typecheck',
      passed: true,
      skipped: true,
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('uses default npx tsc --noEmit when tsconfig.json exists but no language deps', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('npx tsc --noEmit');
  });

  it('TS project uses default npx tsc --noEmit when heuristic returns null', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ lint: false, test: false });
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('npx tsc --noEmit');
    expectCommandRanInProject(runner, tempDir);
  });

  it('short-circuits on typecheck failure without running lint or test', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.exitCode({ command: 'tsc', code: 1, stderr: 'type error', output: '' }),
        { stdout: 'lint should not run', stderr: '', code: 0 },
      ),
    });

    const config = makeConfig({ typecheck: true, lint: true, test: true });
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results).toHaveLength(1);
    const tc = results.find((r) => r.stage === 'typecheck');
    expect(tc?.passed).toBe(false);
    expect(results.map((r) => r.stage)).toEqual(['typecheck']);
  });

  it('reports a timed-out stage as a timeout failure, not an exit-code error', async () => {
    const timeout = processError.timeout({
      command: 'tsc',
      label: 'typecheck validation',
      timeoutMs: 600_000,
      output: '',
    });
    const validator = createValidator({ runCommand: makeCommandRunner(timeout) });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const tc = results.find((r) => r.stage === 'typecheck');
    expect(tc?.passed).toBe(false);
    expect(tc?.error).toContain('timed out');
    expect(tc?.error).not.toContain('exited with code');
  });

  it('passes the configured validation.timeoutMs through to the command runner', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: false, test: false, timeoutMs: 900_000 });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(runner.calls.at(-1)?.options?.timeout).toBe(900_000);
  });

  it('passes the abort signal through to validation commands', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    const controller = new AbortController();
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      signal: controller.signal,
    });

    expect(runner.calls.at(-1)?.options?.signal).toBe(controller.signal);
  });

  it('records a skipped test result when default source but no test file found', async () => {
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({
      typecheck: false,
      lint: false,
      test: true,
      testCommand: undefined,
    });
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.find((r) => r.stage === 'test')).toMatchObject({
      stage: 'test',
      passed: true,
      skipped: true,
    });
  });
});
