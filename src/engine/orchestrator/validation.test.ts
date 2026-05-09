import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createValidator, formatValidationError } from './validation.js';
import type { ValidationCommandRunner, ValidationResult } from './validation.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../core/schemas/config.js';
import type { Task } from '../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';
import { createDefaultConfig } from '../../core/config/load/load.js';

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
    expect(createValidator().findAffectedTestFile('src/foo.ts', tempDir)).toBe(join(tempDir, 'tests', 'foo.test.ts'));
  });

  it('maps src/utils/bar.ts to tests/utils/bar.test.ts when test file exists', () => {
    tempDir = createTempDir('validator-test');
    mkdirSync(join(tempDir, 'tests', 'utils'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'utils', 'bar.test.ts'), '');
    expect(createValidator().findAffectedTestFile('src/utils/bar.ts', tempDir)).toBe(join(tempDir, 'tests', 'utils', 'bar.test.ts'));
  });

  it('returns null when no matching test file found', () => {
    tempDir = createTempDir('validator-test');
    expect(createValidator().findAffectedTestFile('src/missing.ts', tempDir)).toBe(null);
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
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', error: longError },
    ];
    const error = formatValidationError(results);
    expect(error).not.toContain('Error line 21');
    expect(error).toContain('Error line 20');
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
    const config = makeConfig({ typecheck: false, typecheckCommand: 'cargo check', lint: false, test: false });
    const results = await validator.runValidation(mkTask('src/main.rs'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);
    expect(results).toHaveLength(0);
  });

  it('skips lint when master switch is off', async () => {
    const config = makeConfig({ lint: false, lintCommand: 'cargo clippy' });
    const results = await validator.runValidation(mkTask('src/main.rs'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);
    const lintResult = results.find((r) => r.stage === 'lint');
    expect(lintResult).toBeUndefined();
  });

  it('skips test when master switch is off', async () => {
    const config = makeConfig({ test: false });
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'foo.test.ts'), '');
    const results = await validator.runValidation(mkTask('src/foo.ts'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);
    const testResult = results.find((r) => r.stage === 'test');
    expect(testResult).toBeUndefined();
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

    const results = await validator.runValidation(mkTask('src/main.py'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id'], discovered);

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('mypy src/');
    expectCommandRanInProject(runner, tempDir);
  });

  it('discovered wins over heuristic', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ lint: false, test: false });
    const discovered: DiscoveredValidation = { typecheckCommand: 'cargo check' };
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');

    const results = await validator.runValidation(mkTask('src/main.rs'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id'], discovered);

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('cargo check');
    expectCommandRanInProject(runner, tempDir);
  });

  it('heuristic fallback when no config and no discovered', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ lint: false, test: false });
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');

    const results = await validator.runValidation(mkTask('src/main.rs'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('cargo check');
    expectCommandRanInProject(runner, tempDir);
  });

  it('lint stage skipped when no layer provides a command', async () => {
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({ typecheck: false, lint: true, test: false });

    const results = await validator.runValidation(mkTask('src/foo.ts'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);

    const lintResult = results.find((r) => r.stage === 'lint');
    expect(lintResult).toBeUndefined();
  });

  it('ENOENT skips gracefully', async () => {
    const enoent = Object.assign(new Error('spawn cargo ENOENT'), { code: 'ENOENT' });
    const validator = createValidator({ runCommand: makeCommandRunner(enoent) });

    const config = makeConfig({ lint: false, test: false });
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');

    const results = await validator.runValidation(mkTask('src/main.rs'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);

    const tc = results.find((r) => r.stage === 'typecheck');
    expect(tc?.passed).toBe(true);
    expect(tc?.output).toContain('not found');
  });

  it('TS project uses default npx tsc --noEmit when heuristic returns null', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ lint: false, test: false });
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');

    const results = await validator.runValidation(mkTask('src/app.ts'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);

    expect(results.find((r) => r.stage === 'typecheck')?.output).toBe('npx tsc --noEmit');
    expectCommandRanInProject(runner, tempDir);
  });

  it('short-circuits on typecheck failure without running lint or test', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        { stdout: '', stderr: 'type error', code: 1 },
        { stdout: 'lint should not run', stderr: '', code: 0 },
      ),
    });

    const config = makeConfig({ typecheck: true, lint: true, test: true });
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');

    const results = await validator.runValidation(mkTask('src/app.ts'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);

    expect(results).toHaveLength(1);
    const tc = results.find((r) => r.stage === 'typecheck');
    expect(tc?.passed).toBe(false);
    expect(results.map((r) => r.stage)).toEqual(['typecheck']);
  });

  it('skips test stage when default source but no test file found', async () => {
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({ typecheck: false, lint: false, test: true, testCommand: undefined });
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');

    const results = await validator.runValidation(mkTask('src/app.ts'), tempDir, config, fakeBus, 'implementing', 't1' as Task['id']);

    expect(results.find((r) => r.stage === 'test')).toBeUndefined();
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
