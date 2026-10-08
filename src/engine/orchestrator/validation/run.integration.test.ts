import { acceptValidationResults } from './acceptance.js';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
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
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import type { ValidationCommandRunner } from './types.js';

function mkTask(file: string): Task {
  return makeTask({ suggestedFiles: [file], action: 'modify' });
}

function writeTsProject(dir: string): void {
  writeFileSync(join(dir, 'tsconfig.json'), '{}');
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest run"}}');
}

const fakeBus = { publish: () => {}, subscribe: () => () => {} };

describe('validation failure attribution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-attribution');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('stops at the first failure without a recorded run base', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.exitCode({ command: 'tsc', code: 1, stderr: 'new error', output: '' }),
      ),
    });
    const config = makeConfig({
      typecheck: true,
      typecheckCommand: 'npm run typecheck',
      lint: true,
      lintCommand: 'npm run lint',
      test: true,
      testCommand: 'npm test',
    });

    const results = await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(results.map((r) => r.stage)).toEqual(['typecheck']);
    const acceptance = acceptValidationResults(results, ['src/app.ts']);
    expect(acceptance.blockingStages).toContain('typecheck');
    expect(acceptance.exemptStages).toEqual([]);
    const error = formatValidationError(results, acceptance);
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });

  it('exempts nothing without a recorded run base', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.exitCode({ command: 'tsc', code: 1, stderr: 'type error', output: '' }),
      ),
    });
    const config = makeConfig({ typecheck: true, lint: false, test: false });
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');

    const results = await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const acceptance = acceptValidationResults(results, ['src/app.ts']);
    expect(acceptance.exemptStages).toEqual([]);
    expect(acceptance.blockingStages).toContain('typecheck');
    expect(acceptance.accepted).toBe(false);
  });

  it('attributes a test failure to the task without a recorded run base', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    writeTsProject(tempDir);
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.exitCode({ command: 'npm', code: 1, stderr: 'test failed', output: '' }),
      ),
    });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    const results = await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

      task: mkTask('src/foo.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
    });

    const acceptance = acceptValidationResults(results, ['src/foo.ts']);
    expect(acceptance.exemptStages).toEqual([]);
    expect(acceptance.blockingStages).toContain('test');
    const error = formatValidationError(results, acceptance);
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });

  it('skips a heuristic command whose subcommand is missing', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.exitCode({
          command: 'cargo',
          code: 101,
          stderr: 'error: no such command: `clippy`',
          output: '',
        }),
      ),
    });
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    const suite = await validator.runFullSuite({
      projectDir: tempDir,
      config: makeConfig({ typecheck: false, lint: true, test: false }),
      bus: fakeBus,
      phase: 'final-review',
    });
    expect(suite.results[0]).toMatchObject({ stage: 'lint', skipped: true });
    expect(suite.newFailures).toEqual({});
  });

  it('pytest run narrows to the affected test file and blocks an unattributed failure', async () => {
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
    const runner = makeCommandRunner(redSuite());
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    const results = await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],

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
    const acceptance = acceptValidationResults(results, ['src/service.py']);
    expect(acceptance.blockingStages).toEqual(['test']);
    expect(acceptance.accepted).toBe(false);
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
      redPackage(`${uptimeRed}\n${routesRed}`),
    );
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: false, lint: false, test: true });
    const run = () =>
      validator.runValidation({
        stages: ['typecheck', 'lint', 'test'],

        task: mkTask('pkg/handler.go'),
        projectDir: tempDir,
        config,
        bus: fakeBus,
        phase: 'implementing',
        changedFiles: ['pkg/handler.go'],
      });

    const kept = await run();
    const regressed = await run();

    expect(runner.calls[0]?.cmd).toBe('go');
    expect(runner.calls[0]?.args).toEqual(['test', './pkg/']);
    expect(acceptValidationResults(kept, ['pkg/handler.go'])).toMatchObject({
      blockingStages: ['test'],
      accepted: false,
    });
    expect(regressed.find((r) => r.stage === 'test')?.failureFiles).toEqual([]);
    expect(acceptValidationResults(regressed, ['pkg/handler.go'])).toMatchObject({
      blockingStages: ['test'],
      accepted: false,
    });
  });
});

describe('full-suite progress', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-suite-progress');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('reports every enabled stage exactly once, red stages in failures and green stages passed', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner(
        { stdout: 'ok', stderr: '', code: 0 },
        processError.exitCode({ command: 'cargo', code: 1, stderr: 'clippy error', output: '' }),
      ),
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

    const suite = await validator.runFullSuite({
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    expect(suite.results.map((result) => [result.stage, result.passed])).toEqual([
      ['typecheck', true],
      ['lint', false],
    ]);
    expect(
      events.filter((event) => event.type === 'full_suite' && event.status === 'done'),
    ).toHaveLength(2);
  });

  it('narrows the test stage by the declared files plus the files the attempt changed', async () => {
    mkdirSync(join(tempDir, 'src', 'shared'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'foo.test.ts'), '');
    writeFileSync(join(tempDir, 'src', 'shared', 'button.test.ts'), '');
    writeTsProject(tempDir);
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const config = makeConfig({ typecheck: false, lint: false, test: true });

    const results = await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],

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

  it('keeps a stage disabled by its master switch out of both sets', async () => {
    const validator = createValidator({
      runCommand: makeCommandRunner({ stdout: 'ok', stderr: '', code: 0 }),
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

    const suite = await validator.runFullSuite({
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    expect(suite.results.map((result) => result.stage)).toEqual(['typecheck']);
    expect(suite.newFailures).toEqual({});
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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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

    await validator.runFullSuite({
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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
      stages: ['typecheck', 'lint', 'test'],
      changedFiles: [],

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
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/app.ts'), 'export const app = 1;\n');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });

    await validator.formatChangedFiles({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'README.md'],
    });
    const results = await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],

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

  it('never hands the formatter a file the brief deleted', async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/app.ts'), 'export const app = 1;\n');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });

    await validator.formatChangedFiles({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'src/deleted.ts'],
    });
    await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],

      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'src/deleted.ts'],
    });

    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
      'npx biome format --write src/app.ts',
      'npx biome check .',
    ]);
  });

  it('runs no formatter when the project has only a lint config', async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, '.eslintrc.json'), '{}');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });

    await validator.formatChangedFiles({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });
    await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],

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
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/app.ts'), 'export const app = 1;\n');
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

    await validator.formatChangedFiles({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });
    const results = await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],

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

  it('records the format pass as one row naming the files it rewrote', async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/app.ts'), 'export const app = [ 1,2 ];\n');
    writeFileSync(join(tempDir, 'src/clean.ts'), 'export const clean = 1;\n');
    const calls: string[] = [];
    const runner: ValidationCommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args.includes('format')) {
        writeFileSync(join(tempDir, 'src/app.ts'), 'export const app = [1, 2];\n');
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    const validator = createValidator({ runCommand: runner });
    const { bus, events } = makeBusRecorder();

    await validator.formatChangedFiles({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'src/clean.ts'],
    });
    await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],

      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'src/clean.ts'],
    });

    expect(calls).toEqual([
      'npx biome format --write src/app.ts src/clean.ts',
      'npx biome check .',
    ]);
    const rows = events.filter(
      (e): e is EngineEventOf<'warning'> =>
        e.type === 'warning' && e.code === 'validation_formatted',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'validation', taskId: mkTask('src/app.ts').id });
    expect(rows[0]?.message).toContain('src/app.ts');
    expect(rows[0]?.message).not.toContain('src/clean.ts');
  });

  it('records no format row when the formatter rewrote nothing', async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/app.ts'), 'export const app = 1;\n');
    const validator = createValidator({ runCommand: makeCommandRunner() });
    const { bus, events } = makeBusRecorder();

    await validator.formatChangedFiles({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });
    await validator.runValidation({
      stages: ['typecheck', 'lint', 'test'],

      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config: lintOnly,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });

    expect(events.filter((e) => e.type === 'warning')).toEqual([]);
  });
});

describe('runFullSuite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-full-suite');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const testOnly = makeConfig({ typecheck: false, lint: false, test: true });

  const red = (text: string) =>
    processError.exitCode({ command: 'npm', code: 1, stderr: '', output: text });

  it.each(['typecheck', 'lint', 'test'] as const)(
    'detects a silent nonzero %s exit',
    async (stage) => {
      writeTsProject(tempDir);
      const config = makeConfig({
        typecheck: false,
        lint: false,
        test: false,
        [stage]: true,
        typecheckCommand: 'tsc --noEmit',
        lintCommand: 'biome check .',
        testCommand: 'npm test',
      });
      const validator = createValidator({
        runCommand: makeCommandRunner(
          processError.exitCode({ command: 'check', code: 7, stderr: ' \n', output: '' }),
        ),
      });
      const opts = {
        projectDir: tempDir,
        config,
        bus: fakeBus,
        phase: 'implementing' as const,
      };
      const result = await validator.runFullSuite(opts);

      expect(result.results[0]?.passed).toBe(false);
      expect(result.newFailures[stage]).toEqual([`${stage} exited with code 7`]);
    },
  );

  it('gives a review stage one hour when validation.timeoutMs is unset', async () => {
    writeTsProject(tempDir);
    const runner = makeCommandRunner();
    await createValidator({ runCommand: runner }).runFullSuite({
      projectDir: tempDir,
      config: testOnly,
      bus: fakeBus,
      phase: 'final-review',
    });
    expect(runner.calls.map((call) => call.options?.timeout)).toEqual([3_600_000]);
  });

  it('runs the whole test suite, not a narrowed target, and records its failure keys', async () => {
    writeTsProject(tempDir);
    const runner = makeCommandRunner(
      red('FAIL src/legacy.test.ts > adds\n  ❯ src/legacy.test.ts:5:20'),
    );
    const validator = createValidator({ runCommand: runner });

    const suite = await validator.runFullSuite({
      projectDir: tempDir,
      config: testOnly,
      bus: fakeBus,
      phase: 'implementing',
    });

    expect(runner.calls[0]?.cmd).toBe('npm');
    expect(runner.calls[0]?.args).toEqual(['test']);
    expect(suite.newFailures.test).toEqual(['src/legacy.test.ts::adds']);
  });

  it('names a test timeout without diagnostic output', async () => {
    writeTsProject(tempDir);
    const validator = createValidator({
      runCommand: makeCommandRunner(
        processError.timeout({
          command: 'npm test',
          timeoutMs: 3_600_000,
          output: '',
        }),
      ),
    });
    const suite = await validator.runFullSuite({
      projectDir: tempDir,
      config: makeConfig({ typecheck: false, lint: false, test: true }),
      bus: fakeBus,
      phase: 'final-review',
    });
    expect(suite.newFailures).toEqual({ test: ['test timed out'] });
    expect(suite.results[0]?.timedOut).toBe(true);
  });

  it('stops at the first stage with a new failure and runs no later stage', async () => {
    writeTsProject(tempDir);
    const runner = makeCommandRunner(
      processError.exitCode({
        command: 'tsc',
        code: 1,
        stderr: 'src/legacy.ts(1,1): error TS2322',
        output: '',
      }),
      red('FAIL src/legacy.test.ts > adds\n  ❯ src/legacy.test.ts:5:20'),
    );
    const validator = createValidator({ runCommand: runner });
    const config = makeConfig({ typecheck: true, lint: true, test: true });
    const { bus, events } = makeBusRecorder();

    const result = await validator.runFullSuite({
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    expect(runner.calls).toHaveLength(1);
    expect(result.results.map((r) => r.stage)).toEqual(['typecheck', 'lint', 'test']);
    expect(result.results.slice(1)).toEqual([
      expect.objectContaining({
        stage: 'lint',
        skipped: true,
        output: 'not run: typecheck failed',
      }),
      expect.objectContaining({
        stage: 'test',
        skipped: true,
        output: 'not run: typecheck failed',
      }),
    ]);
    expect(
      events.filter((event) => event.type === 'full_suite' && event.status === 'not-run'),
    ).toEqual([
      expect.objectContaining({ stage: 'lint', command: expect.any(String) }),
      expect.objectContaining({ stage: 'test', command: expect.any(String) }),
    ]);
    expect(result.newFailures).toEqual({ typecheck: ['src/legacy.ts(1,1)'] });
  });

  it('publishes a running and a done full_suite event for every stage it runs', async () => {
    writeTsProject(tempDir);
    const { bus, events } = makeBusRecorder();
    const validator = createValidator({
      runCommand: makeCommandRunner(
        { stdout: 'ok', stderr: '', code: 0 },
        { stdout: 'ok', stderr: '', code: 0 },
      ),
    });
    const config = makeConfig({ typecheck: true, lint: false, test: true });

    await validator.runFullSuite({
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
    });

    const suite = events.filter(
      (event): event is EngineEventOf<'full_suite'> => event.type === 'full_suite',
    );
    expect(suite.map((event) => [event.stage, event.status, event.moment])).toEqual([
      ['typecheck', 'running', 'pre-review'],
      ['typecheck', 'done', 'pre-review'],
      ['test', 'running', 'pre-review'],
      ['test', 'done', 'pre-review'],
    ]);
    const done = suite.find((event) => event.stage === 'test' && event.status === 'done');
    expect(done).toMatchObject({ passed: true, command: expect.stringContaining('test') });
    expect(done?.duration).toBeGreaterThanOrEqual(0);
  });
});

describe('known failures, checked at the red moment against the run base', {
  timeout: 60_000,
}, () => {
  const PROJECT = {
    'package.json': '{"scripts":{"test":"vitest run"}}',
    'tsconfig.json': '{}',
    'src/legacy.ts': 'export const legacy = 1;\n',
    'src/legacy.test.ts': "import { legacy } from './legacy.js';\n",
  };
  const testOnly = makeConfig({ typecheck: false, lint: false, test: true });
  const typecheckOnly = makeConfig({
    typecheck: true,
    typecheckCommand: 'npx tsc --noEmit',
    lint: false,
    test: false,
  });
  const LEGACY_RED = 'FAIL src/legacy.test.ts > adds\n  ❯ src/legacy.test.ts:5:20';
  const FRESH_RED = 'FAIL src/fresh.test.ts > subtracts\n  ❯ src/fresh.test.ts:3:10';
  const OLD_TYPE_ERROR = 'src/old.ts(3,7): error TS2322: Type string is not number.';
  const NEW_TYPE_ERROR = 'src/legacy.ts(1,1): error TS2304: Cannot find name x.';

  type Outcome = Awaited<ReturnType<ValidationCommandRunner>> | Error;
  type Call = { cmd: string; args: string[]; cwd: string };

  const green: Outcome = { stdout: 'ok', stderr: '', code: 0 };
  const red = (output: string): Outcome =>
    processError.exitCode({ command: 'npm', code: 1, stderr: '', output });
  const timedOut = (): Outcome =>
    processError.timeout({
      command: 'npm test',
      label: 'test validation',
      timeoutMs: 3_600_000,
      output: '',
    });

  /** Answers by tree: the run workspace gets `candidate`, every other directory `atBase`. */
  function treeRunner(
    ws: string,
    candidate: (cmd: string, args: string[]) => Outcome,
    atBase: (cmd: string, args: string[]) => Outcome,
  ): { calls: Call[]; runCommand: ValidationCommandRunner } {
    const calls: Call[] = [];
    const runCommand: ValidationCommandRunner = async (cmd, args, options) => {
      const cwd = options?.cwd ?? '';
      calls.push({ cmd, args, cwd });
      const outcome = cwd === ws ? candidate(cmd, args) : atBase(cmd, args);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    return { calls, runCommand };
  }

  function baseOf(run: ApplyRun) {
    return {
      projectDir: run.dir,
      sessionId: run.sessionId,
      snapshotId: run.workspace.base.snapshotId,
    };
  }

  function outside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel.startsWith('..') || isAbsolute(rel);
  }

  it('re-runs only the failing test file at the run base and keeps a red that is red there too out of the new failures', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-test' }, async (run) => {
      writeFileSync(join(run.ws, 'src/fresh.test.ts'), 'export {};\n');
      const { calls, runCommand } = treeRunner(
        run.ws,
        () => red(`${LEGACY_RED}\n${FRESH_RED}`),
        () => red(LEGACY_RED),
      );
      const { bus, events } = makeBusRecorder();

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: testOnly,
        bus,
        phase: 'final-review',
        base: baseOf(run),
      });

      expect(suite.newFailures).toEqual({ test: ['src/fresh.test.ts::subtracts'] });
      expect(suite.results[0]?.preExisting).toEqual(['src/legacy.test.ts::adds']);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ cmd: 'npm', args: ['test'], cwd: run.ws });
      // The file the run added is not at the base, so only the legacy test re-runs there.
      expect(calls[1]).toMatchObject({ cmd: 'npm', args: ['test', '--', 'src/legacy.test.ts'] });
      const baseTree = calls[1]?.cwd ?? '';
      expect(outside(run.dir, baseTree)).toBe(true);
      expect(outside(run.ws, baseTree)).toBe(true);
      expect(existsSync(baseTree)).toBe(false);
      const suiteEvents = events.filter(
        (event): event is EngineEventOf<'full_suite'> => event.type === 'full_suite',
      );
      expect(suiteEvents.map((event) => [event.moment, event.status])).toEqual([
        ['pre-review', 'running'],
        ['pre-review', 'done'],
        ['base', 'running'],
        ['base', 'done'],
      ]);
      expect(suiteEvents[3]).toMatchObject({
        stage: 'test',
        command: expect.stringContaining('src/legacy.test.ts'),
        passed: false,
      });
    });
  });

  it('checks a red stage at the base before the next stage runs, and runs on past a red that is all pre-existing', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-per-stage' }, async (run) => {
      writeFileSync(join(run.ws, 'src/fresh.test.ts'), 'export {};\n');
      const { calls, runCommand } = treeRunner(
        run.ws,
        (cmd) => (cmd === 'npx' ? red(OLD_TYPE_ERROR) : red(FRESH_RED)),
        (cmd) => (cmd === 'npx' ? red(OLD_TYPE_ERROR) : green),
      );

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: makeConfig({
          typecheck: true,
          typecheckCommand: 'npx tsc --noEmit',
          lint: false,
          test: true,
        }),
        bus: fakeBus,
        phase: 'final-review',
        base: baseOf(run),
      });

      expect(calls.map((call) => [call.cmd, call.cwd === run.ws ? 'candidate' : 'base'])).toEqual([
        ['npx', 'candidate'],
        ['npx', 'base'],
        ['npm', 'candidate'],
      ]);
      expect(suite.results.map((result) => result.stage)).toEqual(['typecheck', 'test']);
      expect(suite.results[0]?.preExisting).toEqual(['src/old.ts(3,7)']);
      expect(suite.newFailures).toEqual({ test: ['src/fresh.test.ts::subtracts'] });
    });
  });

  it('compares a whole typecheck run at the base by file and diagnostic', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-typecheck' }, async (run) => {
      const { calls, runCommand } = treeRunner(
        run.ws,
        () => red(`${OLD_TYPE_ERROR}\n${NEW_TYPE_ERROR}`),
        () => red(OLD_TYPE_ERROR),
      );

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: typecheckOnly,
        bus: fakeBus,
        phase: 'final-review',
        base: baseOf(run),
      });

      expect(calls.map((call) => [call.cmd, ...call.args])).toEqual([
        ['npx', 'tsc', '--noEmit'],
        ['npx', 'tsc', '--noEmit'],
      ]);
      expect(suite.newFailures).toEqual({ typecheck: ['src/legacy.ts(1,1)'] });
      expect(suite.results[0]?.preExisting).toEqual(['src/old.ts(3,7)']);
    });
  });

  it.each(['typecheck', 'lint', 'test'] as const)(
    'compares absolute %s failure paths across the two trees and retains candidate keys',
    async (stage) => {
      await withApplyRun(PROJECT, { sessionId: `sess-known-absolute-${stage}` }, async (run) => {
        const file = stage === 'test' ? 'src/legacy.test.ts' : 'src/legacy.ts';
        const runCommand: ValidationCommandRunner = async (_cmd, _args, options) => {
          throw processError.exitCode({
            command: 'check',
            code: 1,
            stderr: '',
            output: `${join(options?.cwd ?? '', file)}:5:20 error`,
          });
        };
        const suite = await createValidator({ runCommand }).runFullSuite({
          projectDir: run.ws,
          config: makeConfig({
            typecheck: false,
            lint: false,
            test: false,
            [stage]: true,
            typecheckCommand: 'npx tsc --noEmit',
            lintCommand: 'npx biome check .',
          }),
          bus: fakeBus,
          phase: 'final-review',
          base: baseOf(run),
        });
        if (stage === 'test') {
          expect(suite.newFailures).toEqual({ test: ['test exited with code 1'] });
          expect(suite.results[0]?.preExisting).toBeUndefined();
        } else {
          expect(suite.newFailures).toEqual({});
          expect(suite.results[0]?.preExisting).toEqual([`${join(run.ws, file)}:5`]);
        }
      });
    },
  );

  it('runs nothing at the base when every stage is green', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-green' }, async (run) => {
      const { calls, runCommand } = treeRunner(
        run.ws,
        () => green,
        () => red(LEGACY_RED),
      );

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: testOnly,
        bus: fakeBus,
        phase: 'final-review',
        base: baseOf(run),
      });

      expect(calls).toHaveLength(1);
      expect(suite.newFailures).toEqual({});
      expect(suite.results[0]?.preExisting).toBeUndefined();
    });
  });

  it('counts every red as new for an older run with no recorded run base', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-no-base' }, async (run) => {
      const { calls, runCommand } = treeRunner(
        run.ws,
        () => red(LEGACY_RED),
        () => red(LEGACY_RED),
      );

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: testOnly,
        bus: fakeBus,
        phase: 'final-review',
      });

      expect(calls).toHaveLength(1);
      expect(suite.newFailures).toEqual({ test: ['src/legacy.test.ts::adds'] });
    });
  });

  it('keeps an unparsed test timeout new and runs nothing at the base', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-slow' }, async (run) => {
      const { calls, runCommand } = treeRunner(run.ws, timedOut, timedOut);

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: testOnly,
        bus: fakeBus,
        phase: 'final-review',
        base: baseOf(run),
      });

      expect(calls).toHaveLength(1);
      expect(suite.newFailures).toEqual({ test: ['test timed out'] });
      expect(suite.results[0]?.timedOut).toBe(true);
      expect(suite.results[0]?.preExisting).toBeUndefined();
    });
  });

  it('counts a timeout as new when the same command finishes at the base', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-hang' }, async (run) => {
      const { runCommand } = treeRunner(run.ws, timedOut, () => green);

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: testOnly,
        bus: fakeBus,
        phase: 'final-review',
        base: baseOf(run),
      });

      expect(suite.newFailures.test).toHaveLength(1);
      expect(suite.results[0]?.preExisting).toBeUndefined();
    });
  });

  it('counts a diagnostic failure as new when its base command times out', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-base-timeout' }, async (run) => {
      const { calls, runCommand } = treeRunner(run.ws, () => red(LEGACY_RED), timedOut);

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: testOnly,
        bus: fakeBus,
        phase: 'final-review',
        base: baseOf(run),
      });

      expect(calls[1]).toMatchObject({ cmd: 'npm', args: ['test', '--', 'src/legacy.test.ts'] });
      expect(suite.newFailures.test).toEqual(['src/legacy.test.ts::adds']);
      expect(suite.results[0]?.preExisting).toBeUndefined();
    });
  });

  it('keeps a failure red when every failing test file is absent at the base', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-base-skip' }, async (run) => {
      writeFileSync(join(run.ws, 'src/fresh.test.ts'), 'export {};\n');
      const { calls, runCommand } = treeRunner(
        run.ws,
        () => red(FRESH_RED),
        () => red(FRESH_RED),
      );

      const suite = await createValidator({ runCommand }).runFullSuite({
        projectDir: run.ws,
        config: testOnly,
        bus: fakeBus,
        phase: 'final-review',
        base: baseOf(run),
      });

      expect(calls.filter((call) => call.cwd !== run.ws)).toEqual([]);
      expect(suite.newFailures.test).toEqual(['src/fresh.test.ts::subtracts']);
      expect(suite.results[0]?.passed).toBe(false);
      expect(suite.results[0]?.preExisting).toBeUndefined();
    });
  });

  it('a brief gate continues past a stage red at the base and accepts it as pre-existing', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-gate' }, async (run) => {
      const { calls, runCommand } = treeRunner(
        run.ws,
        (cmd) => (cmd === 'npx' ? red(OLD_TYPE_ERROR) : green),
        () => red(OLD_TYPE_ERROR),
      );
      const config = makeConfig({
        typecheck: true,
        typecheckCommand: 'npx tsc --noEmit',
        lint: false,
        test: true,
      });

      const results = await createValidator({ runCommand }).runValidation({
        task: mkTask('src/legacy.ts'),
        projectDir: run.ws,
        config,
        bus: fakeBus,
        phase: 'implementing',
        stages: ['typecheck', 'lint', 'test'],
        changedFiles: ['src/legacy.ts'],
        base: baseOf(run),
      });

      expect(results.map((result) => [result.stage, result.passed])).toEqual([
        ['typecheck', false],
        ['test', true],
      ]);
      expect(results[0]?.preExisting).toEqual(['src/old.ts(3,7)']);
      expect(acceptValidationResults(results, ['src/legacy.ts'])).toEqual({
        accepted: true,
        exemptStages: ['typecheck'],
        blockingStages: [],
      });
      expect(calls.filter((call) => call.cwd !== run.ws)).toHaveLength(1);
    });
  });

  it('a brief gate stops at a red that names its own changed file', async () => {
    await withApplyRun(PROJECT, { sessionId: 'sess-known-gate-own' }, async (run) => {
      const { calls, runCommand } = treeRunner(
        run.ws,
        (cmd) => (cmd === 'npx' ? red(`${OLD_TYPE_ERROR}\n${NEW_TYPE_ERROR}`) : green),
        () => red(OLD_TYPE_ERROR),
      );
      const config = makeConfig({
        typecheck: true,
        typecheckCommand: 'npx tsc --noEmit',
        lint: false,
        test: true,
      });

      const results = await createValidator({ runCommand }).runValidation({
        task: mkTask('src/legacy.ts'),
        projectDir: run.ws,
        config,
        bus: fakeBus,
        phase: 'implementing',
        stages: ['typecheck', 'lint', 'test'],
        changedFiles: ['src/legacy.ts'],
        base: baseOf(run),
      });

      expect(results.map((result) => result.stage)).toEqual(['typecheck']);
      expect(acceptValidationResults(results, ['src/legacy.ts'])).toMatchObject({
        accepted: false,
        blockingStages: ['typecheck'],
      });
      expect(calls.filter((call) => call.cwd !== run.ws)).toEqual([]);
    });
  });
});
