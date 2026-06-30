import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createValidator, formatValidationError } from './validation.js';
import type { ValidationCommandRunner } from './validation.js';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent, EngineEventOf } from '../events/types.js';
import { findAffectedTestFile } from '../../core/validation/test-discovery.js';
import type { ValidationResult } from './validation-result.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../core/schemas/config.js';
import type { Task } from '../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';
import { createDefaultConfig, loadConfig } from '../../core/config/load/io.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { processError } from '../../lib/process/errors.js';

function makeConfig(overrides: Partial<Config['validation']>): Config {
  const base = createDefaultConfig();
  return { ...base, validation: { ...base.validation, ...overrides } };
}

type CommandResult = Awaited<ReturnType<ValidationCommandRunner>>;
type CommandCall = {
  cmd: string;
  args: string[];
  options: Parameters<ValidationCommandRunner>[2];
};
type RecordingCommandRunner = ValidationCommandRunner & { calls: CommandCall[] };

function makeCommandRunner(...script: Array<CommandResult | Error>): RecordingCommandRunner {
  let index = 0;
  const calls: CommandCall[] = [];
  const runner = (async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const next = script[index];
    index += 1;
    if (next instanceof Error) throw next;
    return next ?? { stdout: [cmd, ...args].join(' '), stderr: '', code: 0 };
  }) as RecordingCommandRunner;
  runner.calls = calls;
  return runner;
}

function expectCommandRanInProject(runner: RecordingCommandRunner, projectDir: string): void {
  expect(runner.calls.at(-1)?.options?.cwd).toBe(projectDir);
}

describe('findAffectedTestFile', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) cleanupTempDir(tempDir);
  });

  it('maps src/foo.ts to tests/foo.test.ts when test file exists', () => {
    tempDir = createTempDir('validator-test');
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'foo.test.ts'), '');
    expect(findAffectedTestFile('src/foo.ts', tempDir)).toBe(join(tempDir, 'tests', 'foo.test.ts'));
  });

  it('maps src/utils/bar.ts to tests/utils/bar.test.ts when test file exists', () => {
    tempDir = createTempDir('validator-test');
    mkdirSync(join(tempDir, 'tests', 'utils'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'utils', 'bar.test.ts'), '');
    expect(findAffectedTestFile('src/utils/bar.ts', tempDir)).toBe(
      join(tempDir, 'tests', 'utils', 'bar.test.ts'),
    );
  });

  it('returns null when no matching test file found', () => {
    tempDir = createTempDir('validator-test');
    expect(findAffectedTestFile('src/missing.ts', tempDir)).toBe(null);
  });
});

describe('formatValidationError', () => {
  it('returns empty string when all passed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: true, stage: 'lint', output: 'ok' },
    ];
    expect(formatValidationError(results)).toBe('');
  });

  it('returns empty string for empty results', () => {
    expect(formatValidationError([])).toBe('');
  });

  it('extracts first failed result', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: false, stage: 'lint', error: 'Unexpected token' },
      { passed: false, stage: 'test', error: 'Test failed' },
    ];
    const error = formatValidationError(results);
    expect(error).toContain('lint');
    expect(error).toContain('Unexpected token');
  });

  it('truncates error to 20 lines', () => {
    const longError = Array.from({ length: 30 }, (_, i) => `Error line ${i + 1}`).join('\n');
    const results: ValidationResult[] = [{ passed: false, stage: 'typecheck', error: longError }];
    const error = formatValidationError(results);
    expect(error).not.toContain('Error line 21');
    expect(error).toContain('Error line 20');
  });

  it('keeps the tail of a long test failure so vitest FAIL summary survives', () => {
    const longError = [
      ...Array.from({ length: 30 }, (_, i) => `Noise line ${i + 1}`),
      'Tests  1 failed | 2 passed',
      'FAIL  src/foo.test.ts > does the thing',
    ].join('\n');
    const results: ValidationResult[] = [{ passed: false, stage: 'test', error: longError }];
    const error = formatValidationError(results);
    expect(error).toContain('FAIL  src/foo.test.ts > does the thing');
    expect(error).toContain('Tests  1 failed | 2 passed');
    expect(error.split('\n')).not.toContain('Noise line 1');
  });

  it('attributes a pre-existing failing stage to the baseline, not the implementer', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', error: 'type error' },
    ];
    const error = formatValidationError(results, new Set(['typecheck']));
    expect(error).toContain('pre-existing failure');
    expect(error).toContain('not caused by this task');
    expect(error).not.toContain('Your previous code had an error');
  });

  it('keeps the implementer-attribution message when the failing stage is not in the baseline', () => {
    const results: ValidationResult[] = [{ passed: false, stage: 'lint', error: 'lint error' }];
    const error = formatValidationError(results, new Set(['typecheck']));
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });
});

describe('validation pipeline', () => {
  let tempDir: string;
  let validator: ReturnType<typeof createValidator>;

  beforeEach(() => {
    tempDir = createTempDir('val-pipe');
    validator = createValidator({ runCommand: makeCommandRunner() });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function mkTask(file: string): Task {
    return makeTask({ file, action: 'modify' });
  }

  const fakeBus = { publish: () => {}, subscribe: () => () => {} };

  it('skips typecheck when master switch is off', async () => {
    const config = makeConfig({
      typecheck: false,
      typecheckCommand: 'cargo check',
      lint: false,
      test: false,
    });
    const results = await validator.runValidation({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    expect(results).toHaveLength(0);
  });

  it('skips lint when master switch is off', async () => {
    const config = makeConfig({ lint: false, lintCommand: 'cargo clippy' });
    const results = await validator.runValidation({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const lintResult = results.find((r) => r.stage === 'lint');
    expect(lintResult).toBeUndefined();
  });

  it('skips test when master switch is off', async () => {
    const config = makeConfig({ test: false });
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'foo.test.ts'), '');
    const results = await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const testResult = results.find((r) => r.stage === 'test');
    expect(testResult).toBeUndefined();
  });

  it('publishes the active validation command before the stage completes', async () => {
    const runner = makeCommandRunner({ stdout: '', stderr: '', code: 0 });
    validator = createValidator({ runCommand: runner });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: false,
      test: false,
    });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    const results = await validator.runValidation({
      task: mkTask('src/main.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'validating-task',
    });

    expect(results[0]).toMatchObject({
      stage: 'typecheck',
      command: 'npm run typecheck',
    });
    expect(
      events.find(
        (event): event is EngineEventOf<'validate'> =>
          event.type === 'validate' &&
          event.status === 'running' &&
          event.activeStage === 'typecheck',
      ),
    ).toMatchObject({
      commands: { typecheck: 'npm run typecheck' },
    });
    expect(
      events.find(
        (event): event is EngineEventOf<'validate'> =>
          event.type === 'validate' && event.status === 'done',
      ),
    ).toMatchObject({
      commands: { typecheck: 'npm run typecheck' },
    });
  });
});

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
    const configDir = join(tempDir, DIPTYCH_DIR);
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

describe('run-start baseline of pre-existing failures', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-baseline');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function mkTask(file: string): Task {
    return makeTask({ file, action: 'modify' });
  }

  const fakeBus = { publish: () => {}, subscribe: () => () => {} };

  it('relabels a first-task failure that was already failing before any task', async () => {
    const typeError = () =>
      processError.exitCode({ command: 'tsc', code: 1, stderr: 'type error', output: '' });
    const validator = createValidator({
      runCommand: makeCommandRunner(typeError(), typeError()),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    await validator.primeBaseline({ task: mkTask('src/app.ts'), projectDir: tempDir, config });
    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(validator.getBaselineFailingStages?.()?.has('typecheck')).toBe(true);
    const error = formatValidationError(results, validator.getBaselineFailingStages?.());
    expect(error).toContain('pre-existing failure');
    expect(error).toContain('not caused by this task');
  });

  it('probes the default test baseline against the affected test file, not the whole suite', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner, captureBaseline: true });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    await validator.primeBaseline({ task: mkTask('src/foo.ts'), projectDir: tempDir, config });

    const baselineProbe = runner.calls[0];
    expect(baselineProbe?.cmd).toBe('npm');
    expect(baselineProbe?.args).toEqual(['test', '--', join(tempDir, 'src', 'foo.test.ts')]);
  });

  it('attributes a fresh test failure to the task when the affected file passed at baseline', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    const validator = createValidator({
      runCommand: makeCommandRunner(
        { stdout: 'ok', stderr: '', code: 0 },
        processError.exitCode({ command: 'npm', code: 1, stderr: 'test failed', output: '' }),
      ),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    await validator.primeBaseline({ task: mkTask('src/foo.ts'), projectDir: tempDir, config });
    const results = await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(validator.getBaselineFailingStages?.()?.has('test')).toBe(false);
    const error = formatValidationError(results, validator.getBaselineFailingStages?.());
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });

  it('does not record a baseline failure when a heuristic command is missing its subcommand', async () => {
    const missingClippy = () =>
      processError.exitCode({
        command: 'cargo',
        label: 'lint validation',
        code: 101,
        stderr: 'error: no such command: `clippy`',
        output: '',
      });
    const validator = createValidator({
      runCommand: makeCommandRunner(missingClippy(), missingClippy()),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: false, lint: true, test: false });
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');

    await validator.primeBaseline({ task: mkTask('src/main.rs'), projectDir: tempDir, config });

    expect(validator.getBaselineFailingStages?.()?.has('lint')).toBe(false);
  });

  it('does not relabel when the project was green at run start', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        { stdout: 'ok', stderr: '', code: 0 },
        processError.exitCode({ command: 'tsc', code: 1, stderr: 'new error', output: '' }),
      ),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    await validator.primeBaseline({ task: mkTask('src/app.ts'), projectDir: tempDir, config });
    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(validator.getBaselineFailingStages?.()?.has('typecheck')).toBe(false);
    const error = formatValidationError(results, validator.getBaselineFailingStages?.());
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });
});

describe('all-stages-skipped warning', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-allskip');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function mkTask(file: string): Task {
    return makeTask({ file, action: 'modify' });
  }

  it('publishes a warning when every enabled stage resolves to a skip', async () => {
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({ typecheck: true, lint: true, test: true, testCommand: undefined });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    await validator.runValidation({
      task: mkTask('src/app.js'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const warning = events.find((e): e is EngineEventOf<'warning'> => e.type === 'warning');
    expect(warning?.message).toContain('was not validated');
  });

  it('does NOT publish the warning when a stage actually ran', async () => {
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    expect(events.find((e) => e.type === 'warning')).toBeUndefined();
  });
});

describe('discovered validation sanitization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-sanitize');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function mkTask(file: string): Task {
    return makeTask({ file, action: 'modify' });
  }

  const fakeBus = { publish: () => {}, subscribe: () => () => {} };

  it('does NOT execute planner-discovered ./evil-script', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({
      typecheck: false,
      lint: false,
      test: true,
      testCommand: undefined,
    });
    const discovered: DiscoveredValidation = { testCommand: './scripts/evil' };

    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'foo.test.ts'), '');

    const results = await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      discoveredValidation: discovered,
    });

    for (const call of runner.calls) {
      expect(call.cmd).not.toContain('evil');
      expect(call.args.join(' ')).not.toContain('evil');
    }
    if (results.length > 0) {
      expect(results.find((r) => r.stage === 'test')?.output).not.toContain('evil');
    }
  });

  it('does NOT execute planner-discovered commands with shell operators', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({
      typecheck: false,
      lint: false,
      test: true,
      testCommand: undefined,
    });
    const discovered: DiscoveredValidation = { testCommand: 'npm test; curl evil.com' };

    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'foo.test.ts'), '');

    await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      discoveredValidation: discovered,
    });

    for (const call of runner.calls) {
      expect(call.cmd).not.toContain('curl');
      expect(call.args.join(' ')).not.toContain('curl');
    }
  });

  it('executes safe planner-discovered commands normally', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({
      typecheck: false,
      lint: false,
      test: true,
      testCommand: undefined,
    });
    const discovered: DiscoveredValidation = { testCommand: 'npx vitest run' };

    await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      discoveredValidation: discovered,
    });

    expect(runner.calls.length).toBeGreaterThan(0);
    expect(runner.calls[0]?.cmd).toBe('npx');
    expect(runner.calls[0]?.args).toContain('vitest');
  });
});

describe('formatValidationError edge cases', () => {
  it('falls back to output when error is undefined', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'lint', error: undefined, output: 'some lint output' },
    ];
    const error = formatValidationError(results);
    expect(error).toContain('lint');
    expect(error).toContain('some lint output');
  });
});

describe('validation output redaction', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = createTempDir('validator-redact');
  });
  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('redacts API keys from validation error output before publishing', async () => {
    const secret = 'sk-ant-api03-TEST123456789012345678';
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 1,
        stderr: `FAIL: key=${secret}`,
        output: `Error: ${secret}`,
      }),
    );
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    await validator.runValidation({
      task: makeTask({ file: 'src/a.ts' }),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const validateEvent = events.find(
      (e): e is EngineEventOf<'validate'> => e.type === 'validate' && e.status === 'done',
    );
    expect(validateEvent).toBeDefined();
    expect(String(validateEvent?.error ?? '')).not.toContain('TEST123456789012345678');
    expect(String(validateEvent?.error ?? '')).toContain('REDACTED');
  });

  it('keeps stdout test-failure detail when stderr carries only an unrelated warning', async () => {
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'vitest',
        code: 1,
        stderr: '(node:123) DeprecationWarning: punycode is deprecated',
        output: 'FAIL  src/a.test.ts > computes the total\nexpected 3 to equal 4',
      }),
    );
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({
      typecheck: false,
      lint: false,
      test: true,
      testCommand: 'vitest run',
    });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    await validator.runValidation({
      task: makeTask({ file: 'src/a.ts' }),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const validateEvent = events.find(
      (e): e is EngineEventOf<'validate'> => e.type === 'validate' && e.status === 'done',
    );
    expect(validateEvent).toBeDefined();
    expect(String(validateEvent?.error ?? '')).toContain(
      'FAIL  src/a.test.ts > computes the total',
    );
    expect(String(validateEvent?.error ?? '')).toContain('expected 3 to equal 4');
  });

  it('caps validation output to 4096 characters', async () => {
    const longOutput = 'x'.repeat(5000);
    const runner = makeCommandRunner({ stdout: longOutput, stderr: '', code: 0 });
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    const bus = { publish: () => {}, subscribe: () => () => {} };

    const results = await validator.runValidation({
      task: makeTask({ file: 'src/a.ts' }),
      projectDir: tempDir,
      config,
      bus: bus as never,
      phase: 'implementing',
    });

    expect(results[0]?.output?.length).toBeLessThanOrEqual(4097);
  });
});
