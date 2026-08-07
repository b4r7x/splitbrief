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

  it('continues to lint and test when typecheck was already red at baseline', async () => {
    const typeError = () =>
      processError.exitCode({ command: 'tsc', code: 1, stderr: 'type error', output: '' });
    const validator = createValidator({
      runCommand: makeCommandRunner(
        typeError(),
        { stdout: 'ok', stderr: '', code: 0 },
        { stdout: 'ok', stderr: '', code: 0 },
        typeError(),
        { stdout: 'ok', stderr: '', code: 0 },
        { stdout: 'ok', stderr: '', code: 0 },
      ),
      captureBaseline: true,
    });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: true,
      lintCommand: 'npm run lint',
      test: true,
      testCommand: 'npm test',
    });

    await validator.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.map((r) => r.stage)).toEqual(['typecheck', 'lint', 'test']);
    expect(results.find((r) => r.stage === 'lint')?.passed).toBe(true);
    expect(results.find((r) => r.stage === 'test')?.passed).toBe(true);
  });

  it('stops at the first failure when the baseline was green', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        { stdout: 'ok', stderr: '', code: 0 },
        { stdout: 'ok', stderr: '', code: 0 },
        { stdout: 'ok', stderr: '', code: 0 },
        processError.exitCode({ command: 'tsc', code: 1, stderr: 'new error', output: '' }),
      ),
      captureBaseline: true,
    });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: true,
      lintCommand: 'npm run lint',
      test: true,
      testCommand: 'npm test',
    });

    await validator.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.map((r) => r.stage)).toEqual(['typecheck']);
    const acceptance = validator.decideAcceptance({ results, changedFiles: ['src/app.ts'] });
    expect(acceptance.blockingStages).toContain('typecheck');
    expect(acceptance.exemptStages).toEqual([]);
    const error = formatValidationError(results, acceptance);
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });

  it('exempts nothing when the baseline was never primed', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.exitCode({ command: 'tsc', code: 1, stderr: 'type error', output: '' }),
      ),
    });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const acceptance = validator.decideAcceptance({ results, changedFiles: ['src/app.ts'] });
    expect(acceptance.exemptStages).toEqual([]);
    expect(acceptance.blockingStages).toContain('typecheck');
    expect(acceptance.accepted).toBe(false);
  });

  it('exempts a baseline-red stage when its evidence names no changed file, and blocks one that does', async () => {
    const typeError = () =>
      processError.exitCode({ command: 'tsc', code: 1, stderr: 'type error', output: '' });
    const validator = createValidator({
      runCommand: makeCommandRunner(typeError()),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    await validator.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const probedCommand = 'npx tsc --noEmit';
    const exemptAcceptance = validator.decideAcceptance({
      results: [
        {
          passed: false,
          stage: 'typecheck',
          command: probedCommand,
          failureFiles: ['src/unrelated.ts'],
        },
      ],
      changedFiles: ['src/app.ts'],
    });
    expect(exemptAcceptance.exemptStages).toContain('typecheck');
    expect(exemptAcceptance.blockingStages).toEqual([]);
    expect(exemptAcceptance.accepted).toBe(true);
    expect(
      formatValidationError(
        [{ passed: false, stage: 'typecheck', failureFiles: ['src/unrelated.ts'] }],
        exemptAcceptance,
      ),
    ).toBe('');

    const blockingAcceptance = validator.decideAcceptance({
      results: [
        {
          passed: false,
          stage: 'typecheck',
          command: probedCommand,
          failureFiles: ['src/app.ts'],
        },
      ],
      changedFiles: ['src/app.ts'],
    });
    expect(blockingAcceptance.exemptStages).toEqual([]);
    expect(blockingAcceptance.blockingStages).toContain('typecheck');
    expect(blockingAcceptance.accepted).toBe(false);
  });

  it('probes the default test baseline against the affected test file, not the whole suite', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner, captureBaseline: true });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    await validator.primeBaseline({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

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

    await validator.primeBaseline({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const results = await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const acceptance = validator.decideAcceptance({ results, changedFiles: ['src/foo.ts'] });
    expect(acceptance.exemptStages).toEqual([]);
    expect(acceptance.blockingStages).toContain('test');
    const error = formatValidationError(results, acceptance);
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });

  it('does not exempt a test failure narrowed to a file the baseline never probed', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    writeFileSync(join(tempDir, 'src', 'bar.test.ts'), '');
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.exitCode({
          command: 'npm',
          code: 1,
          stderr: 'FAIL src/foo.test.ts',
          output: '',
        }),
        processError.exitCode({
          command: 'npm',
          code: 1,
          stderr: 'FAIL src/bar.test.ts',
          output: '',
        }),
      ),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    await validator.primeBaseline({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const results = await validator.runValidation({
      task: mkTask('src/bar.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/bar.ts'],
    });

    const acceptance = validator.decideAcceptance({ results, changedFiles: ['src/bar.ts'] });
    expect(acceptance.exemptStages).toEqual([]);
    expect(acceptance.blockingStages).toContain('test');
    expect(acceptance.accepted).toBe(false);
  });

  it('still exempts the test stage when the task runs the same narrowed command as the baseline', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.exitCode({
          command: 'npm',
          code: 1,
          stderr: 'FAIL src/foo.test.ts',
          output: '',
        }),
        processError.exitCode({
          command: 'npm',
          code: 1,
          stderr: 'FAIL src/foo.test.ts',
          output: '',
        }),
      ),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    await validator.primeBaseline({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const results = await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/foo.ts'],
    });

    const acceptance = validator.decideAcceptance({ results, changedFiles: ['src/foo.ts'] });
    expect(acceptance.exemptStages).toEqual(['test']);
    expect(acceptance.blockingStages).toEqual([]);
    expect(acceptance.accepted).toBe(true);
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

    await validator.primeBaseline({
      task: mkTask('src/main.rs'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const acceptance = validator.decideAcceptance({
      results: [{ passed: false, stage: 'lint', failureFiles: ['src/unrelated.rs'] }],
      changedFiles: ['src/main.rs'],
    });
    expect(acceptance.exemptStages).toEqual([]);
    expect(acceptance.blockingStages).toContain('lint');
  });
});

describe('baseline probe heartbeat', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-baseline-heartbeat');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function capturedBaselineDone(
    events: EngineEvent[],
  ): EngineEventOf<'validation_baseline'> | undefined {
    return events.find(
      (event): event is EngineEventOf<'validation_baseline'> =>
        event.type === 'validation_baseline' && event.status === 'done',
    );
  }

  it('publishes a running event naming the active stage before any done event', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        { stdout: 'ok', stderr: '', code: 0 },
        { stdout: 'ok', stderr: '', code: 0 },
      ),
      captureBaseline: true,
    });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: true,
      lintCommand: 'cargo clippy --no-deps',
      test: false,
    });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    await validator.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const activeStageIndex = events.findIndex(
      (event): event is EngineEventOf<'validation_baseline'> =>
        event.type === 'validation_baseline' &&
        event.status === 'running' &&
        event.activeStage !== undefined,
    );
    const doneIndex = events.findIndex(
      (event) => event.type === 'validation_baseline' && event.status === 'done',
    );
    expect(activeStageIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(activeStageIndex);
  });

  it('reports every enabled stage exactly once, red stages in failing and green stages true in stages', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        { stdout: 'ok', stderr: '', code: 0 },
        processError.exitCode({ command: 'cargo', code: 1, stderr: 'clippy error', output: '' }),
      ),
      captureBaseline: true,
    });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: true,
      lintCommand: 'cargo clippy --no-deps',
      test: false,
    });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    await validator.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    expect(capturedBaselineDone(events)).toMatchObject({
      stages: { typecheck: true, lint: false, test: false },
      failing: { lint: true },
      commands: {
        typecheck: 'npm run typecheck',
        lint: 'cargo clippy --no-deps',
      },
    });
  });

  it('reports the affected-test-narrowed test command actually run', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    const validator = createValidator({
      runCommand: makeCommandRunner(),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: false, lint: false, test: true });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    await validator.primeBaseline({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    expect(capturedBaselineDone(events)?.commands?.test).toContain(
      join(tempDir, 'src', 'foo.test.ts'),
    );
  });

  it('never reports a skipped stage as green, and progress agrees with done', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    const validator = createValidator({
      runCommand: makeCommandRunner(processError.notFound('npm')),
      captureBaseline: true,
    });
    const config = makeConfig({ typecheck: false, lint: false, test: true });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    await validator.primeBaseline({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const progress = events.filter(
      (event): event is EngineEventOf<'validation_baseline'> =>
        event.type === 'validation_baseline' && event.status === 'running',
    );
    const done = capturedBaselineDone(events);
    expect(progress.at(-1)?.stages).toEqual({ typecheck: false, lint: false, test: false });
    expect(done?.stages).toEqual(progress.at(-1)?.stages);
    expect(done?.failing).toBeUndefined();
  });

  it('keeps a stage disabled by its master switch out of both sets', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner({ stdout: 'ok', stderr: '', code: 0 }),
      captureBaseline: true,
    });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: false,
      test: false,
    });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    await validator.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const done = capturedBaselineDone(events);
    expect(done?.stages).toEqual({ typecheck: true, lint: false, test: false });
    expect(done?.failing).toBeUndefined();
  });

  it('publishes nothing when baseline capture is not enabled', async () => {
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: false,
      test: false,
    });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    await validator.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    expect(events.some((event) => event.type === 'validation_baseline')).toBe(false);
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
