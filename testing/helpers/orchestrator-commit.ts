import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../src/core/schemas/config.js';
import type { CommitStrategy } from '../../src/core/schemas/enums.js';
import type { HooksConfig } from '../../src/core/schemas/hooks.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { createInitialState } from '../../src/core/state/machine.js';
import { makeConfig } from './factories/config.js';
import { makeTask } from './factories/task.js';
import { cleanupTempDir } from './temp-dir.js';
import type { Task } from '../../src/core/schemas/task.js';

const commitTestDirs: string[] = [];

export function cleanupCommitTestProjects(): void {
  for (const dir of commitTestDirs) cleanupTempDir(dir);
  commitTestDirs.length = 0;
}

export function registerCommitTestDir(projectDir: string): void {
  commitTestDirs.push(projectDir);
}

export function makeDirty(projectDir: string, relativePath = 'task-file.txt'): void {
  writeFileSync(join(projectDir, relativePath), 'content');
}

export function firstCommitTask(state: WorkflowState): Task {
  const t = state.tasks[0];
  if (!t) throw new Error('expected first task in state');
  return t;
}

export function makeCommitState(overrides?: Partial<WorkflowState>): WorkflowState {
  const base = createInitialState('test-feature');
  const task = makeTask();
  return {
    ...base,
    phase: 'validating-task',
    tasks: [task],
    currentTaskIndex: 0,
    attempt: 0,
    ...overrides,
  };
}

// ConfigSchema rejects the retired commit strategies and commit hooks, so a config carrying
// them exists only past the loader. These tests are about the engine ignoring such a value if
// one reaches it, not about the loader accepting it; rejection is covered by the schema tests.
export function makeLegacyCommitConfig(options: {
  commitStrategy?: CommitStrategy | undefined;
  hooks?: HooksConfig | undefined;
}): Config {
  const config = makeConfig();
  return {
    ...config,
    workflow: {
      ...config.workflow,
      git: {
        ...config.workflow.git,
        ...(options.commitStrategy !== undefined && { commitStrategy: options.commitStrategy }),
      },
    },
    ...(options.hooks !== undefined && { hooks: options.hooks }),
  };
}
