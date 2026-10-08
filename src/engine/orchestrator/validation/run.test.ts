import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createValidator } from './run.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent, EngineEventOf } from '../../events/types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { Task } from '../../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
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

describe('formatChangedFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-format');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const config = makeConfig({});

  it("formats the brief's formattable changed files with the project formatter", async () => {
    writeTsProject(tempDir);
    writeFileSync(join(tempDir, 'biome.json'), '{}');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/app.ts'), 'export const app = 1;\n');
    const runner = makeCommandRunner();
    const validator = createValidator({ runCommand: runner });

    await validator.formatChangedFiles({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'README.md'],
    });

    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
      'npx biome format --write src/app.ts',
    ]);
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
      config,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'src/deleted.ts'],
    });

    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
      'npx biome format --write src/app.ts',
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
      config,
      bus: fakeBus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });

    expect(runner.calls).toEqual([]);
  });

  it('warns once when the formatter exits non-zero', async () => {
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
    );
    const validator = createValidator({ runCommand: runner });
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    await validator.formatChangedFiles({
      task: mkTask('src/app.ts'),
      projectDir: tempDir,
      config,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });

    expect(runner.calls.map((call) => [call.cmd, ...call.args].join(' '))).toEqual([
      'npx biome format --write src/app.ts',
    ]);
    const warnings = events.filter((e): e is EngineEventOf<'warning'> => e.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      category: 'validation',
      code: 'validation_format_failed',
    });
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
      config,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts', 'src/clean.ts'],
    });

    expect(calls).toEqual(['npx biome format --write src/app.ts src/clean.ts']);
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
      config,
      bus,
      phase: 'implementing',
      changedFiles: ['src/app.ts'],
    });

    expect(events.filter((e) => e.type === 'warning')).toEqual([]);
  });
});
