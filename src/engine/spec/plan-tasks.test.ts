import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { TaskSchema } from '../../core/schemas/task.js';
import { taskFromSpec } from './plan-tasks.js';

let projectDir: string;
beforeEach(() => {
  projectDir = createTempDir('plan-tasks');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
});
afterEach(() => cleanupTempDir(projectDir));

describe('taskFromSpec', () => {
  it('maps a new task onto every required legacy field and keeps the new fields', () => {
    const spec = makeTaskSpec({
      id: 'T002',
      dependsOn: ['T001'],
      suggestedFiles: ['src/hello.ts', 'src/hello.test.ts'],
      contextFiles: ['src/names.ts'],
      exclusions: ['Do not touch the CLI'],
      checks: [
        { id: 'K1', kind: 'test', value: 'src/hello.test.ts', required: true },
        { id: 'K2', kind: 'cmd', value: 'npm run lint', required: false },
      ],
      protectedOperations: [{ path: 'package.json', operation: 'write' }],
      batch: 2,
    });

    const task = taskFromSpec(spec, projectDir);

    expect(TaskSchema.parse(task)).toEqual(task);
    expect(task).toMatchObject({
      id: 'T002',
      status: 'pending',
      action: 'create',
      file: 'src/hello.ts',
      files: ['src/hello.ts', 'src/hello.test.ts'],
      dependsOn: ['T001'],
      description: spec.intent,
      tests: ['src/hello.test.ts'],
      implementationSteps: [],
      scope: { outOfBounds: ['Do not touch the CLI'] },
      constraints: [],
      typeDefs: '',
      evidence: ['K1 test: src/hello.test.ts', 'K2 cmd (optional): npm run lint'],
      criteria: ['C1'],
      checks: spec.checks,
      suggestedFiles: spec.suggestedFiles,
      contextFiles: ['src/names.ts'],
      exclusions: ['Do not touch the CLI'],
      protectedOperations: [{ path: 'package.json', operation: 'write' }],
      batch: 2,
    });
  });

  it('modifies a suggested file that exists and carries the steps', () => {
    writeFileSync(join(projectDir, 'src', 'hello.ts'), 'export {};\n');
    const task = taskFromSpec(makeTaskSpec({ steps: ['Add greet()'] }), projectDir);
    expect(task.action).toBe('modify');
    expect(task.implementationSteps).toEqual(['Add greet()']);
    expect(task.protectedOperations).toBeUndefined();
  });
});
