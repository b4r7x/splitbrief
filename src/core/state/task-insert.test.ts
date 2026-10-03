import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertTasks, lineageIdOf } from './task-insert.js';
import { taskFromSpec } from '../../engine/spec/plan-tasks.js';
import { taskId } from '../schemas/task.js';
import type { TaskSpec } from '../schemas/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

let projectDir: string;
beforeEach(() => {
  projectDir = createTempDir('task-insert');
});
afterEach(() => cleanupTempDir(projectDir));

const convert = (spec: TaskSpec) => taskFromSpec(spec, projectDir);

describe('insertTasks', () => {
  it('converts each spec through taskFromSpec and assigns the next free ids after the highest task id', () => {
    const existing = [makeTask({ id: 'T009' }), makeTask({ id: 'T010' })];
    const specs = [
      makeTaskSpec({ id: 'T003', suggestedFiles: ['src/split-a.ts'] }),
      makeTaskSpec({ id: 'T004', suggestedFiles: ['src/split-b.ts'], dependsOn: ['T003'] }),
    ];

    const inserted = insertTasks(specs, existing, convert);

    expect(inserted.map((task) => task.id)).toEqual(['T011', 'T012']);
    expect(inserted.map((task) => task.status)).toEqual(['pending', 'pending']);
    expect(inserted[0]?.file).toBe('src/split-a.ts');
    expect(inserted[0]?.description).toBe('Return a greeting for a name');
  });

  it('rewrites a dependency on an earlier subtask and passes external dependencies through', () => {
    const existing = [makeTask({ id: 'T010', status: 'done' })];
    const specs = [
      makeTaskSpec({ id: 'T001', suggestedFiles: ['src/split-a.ts'], dependsOn: ['T010'] }),
      makeTaskSpec({ id: 'T002', suggestedFiles: ['src/split-b.ts'], dependsOn: ['T001'] }),
    ];

    const inserted = insertTasks(specs, existing, convert);

    expect(inserted[0]?.dependsOn).toEqual(['T010']);
    expect(inserted[1]?.dependsOn).toEqual(['T011']);
  });
});

describe('lineageIdOf', () => {
  it('returns the parent id for a subtask and the task id at the root', () => {
    expect(lineageIdOf(makeTask({ id: 'T005', parentId: taskId('T002') }))).toBe('T002');
    expect(lineageIdOf(makeTask({ id: 'T005' }))).toBe('T005');
  });
});
