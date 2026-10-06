import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { sha256Hex } from '../../../utils/sha256.js';
import {
  ABSENT_INPUT_HASH,
  inputHashesNow,
  inputsMovedUnexpectedly,
  specInputFiles,
  taskInputFiles,
} from './stale-inputs.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('stale-inputs');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
});
afterEach(() => cleanupTempDir(projectDir));

describe('inputHashesNow', () => {
  it('hashes each present input and hashes a missing file as absent', () => {
    writeFileSync(join(projectDir, 'src/input.ts'), 'export const input = 1;\n');

    expect(inputHashesNow(projectDir, ['src/input.ts', 'src/gone.ts'])).toEqual({
      'src/input.ts': sha256Hex('export const input = 1;\n'),
      'src/gone.ts': ABSENT_INPUT_HASH,
    });
    expect(ABSENT_INPUT_HASH).toBe(sha256Hex(''));
  });
});

describe('specInputFiles', () => {
  it('hashes every suggested file and every context file, a missing one as absent', () => {
    writeFileSync(join(projectDir, 'src/a.ts'), 'export const a = 1;\n');
    const spec = {
      suggestedFiles: ['src/a.ts', 'src/new.ts'],
      contextFiles: ['src/context.ts'],
    };

    expect(specInputFiles(spec)).toEqual(['src/a.ts', 'src/new.ts', 'src/context.ts']);
    expect(inputHashesNow(projectDir, specInputFiles(spec))).toEqual({
      'src/a.ts': sha256Hex('export const a = 1;\n'),
      'src/new.ts': ABSENT_INPUT_HASH,
      'src/context.ts': ABSENT_INPUT_HASH,
    });
  });

  it('flags the task when a suggested file is created after the revision was recorded', () => {
    const spec = { suggestedFiles: ['src/new.ts'], contextFiles: [] };
    const task = makeTask({
      suggestedFiles: ['src/new.ts'],
      inputHashes: inputHashesNow(projectDir, specInputFiles(spec)),
    });
    expect(inputsMovedUnexpectedly(projectDir, task, [])).toBe(false);

    writeFileSync(join(projectDir, 'src/new.ts'), 'export const created = 1;\n');

    expect(inputsMovedUnexpectedly(projectDir, task, [])).toBe(true);
  });
});

describe('taskInputFiles', () => {
  it('reads the recorded input set of the revision', () => {
    const task = makeTask({ inputHashes: { 'src/a.ts': 'one', 'src/context.ts': 'two' } });
    expect(taskInputFiles(task)).toEqual(['src/a.ts', 'src/context.ts']);
  });

  it('is empty for a task that recorded no hashes', () => {
    expect(taskInputFiles(makeTask({ inputHashes: undefined }))).toEqual([]);
  });
});

describe('inputsMoved', () => {
  it('does not flag a task that recorded no hashes', () => {
    const task = makeTask({ inputHashes: undefined });
    expect(inputsMovedUnexpectedly(projectDir, task, [])).toBe(false);
  });

  it('does not flag a task whose recorded inputs are unchanged', () => {
    writeFileSync(join(projectDir, 'src/a.ts'), 'export const a = 1;\n');
    const task = makeTask({ inputHashes: inputHashesNow(projectDir, ['src/a.ts']) });
    expect(inputsMovedUnexpectedly(projectDir, task, [])).toBe(false);
  });

  it('flags an input whose content changed since the revision was recorded', () => {
    writeFileSync(join(projectDir, 'src/a.ts'), 'export const a = 1;\n');
    const task = makeTask({ inputHashes: inputHashesNow(projectDir, ['src/a.ts']) });
    writeFileSync(join(projectDir, 'src/a.ts'), 'export const a = 2;\n');
    expect(inputsMovedUnexpectedly(projectDir, task, [])).toBe(true);
  });

  it('flags an input that appeared since the revision was recorded', () => {
    const task = makeTask({ inputHashes: inputHashesNow(projectDir, ['src/a.ts']) });
    writeFileSync(join(projectDir, 'src/a.ts'), 'export const a = 1;\n');
    expect(inputsMovedUnexpectedly(projectDir, task, [])).toBe(true);
  });

  it('flags an input that disappeared since the revision was recorded', () => {
    writeFileSync(join(projectDir, 'src/a.ts'), 'export const a = 1;\n');
    const task = makeTask({ inputHashes: inputHashesNow(projectDir, ['src/a.ts']) });
    rmSync(join(projectDir, 'src/a.ts'));
    expect(inputsMovedUnexpectedly(projectDir, task, [])).toBe(true);
  });

  it('does not flag inputs that were absent at the revision and are still absent', () => {
    const task = makeTask({ inputHashes: inputHashesNow(projectDir, ['src/never.ts']) });
    expect(inputsMovedUnexpectedly(projectDir, task, [])).toBe(false);
  });
});
