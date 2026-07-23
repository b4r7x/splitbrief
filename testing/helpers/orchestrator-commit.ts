import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import { createInitialState } from '../../src/core/state/machine.js';
import { makeTask } from './factories/task.js';
import { createTempDir, cleanupTempDir } from './temp-dir.js';
import { createTestGitRepo } from './git.js';
import { ensureSessionDir } from '../../src/core/paths-io.js';
import type { Task } from '../../src/core/schemas/task.js';
import type { InProgressGitOp } from '../../src/lib/git/repository.js';

const commitTestDirs: string[] = [];

export function cleanupCommitTestProjects(): void {
  for (const dir of commitTestDirs) cleanupTempDir(dir);
  commitTestDirs.length = 0;
}

export function registerCommitTestDir(projectDir: string): void {
  commitTestDirs.push(projectDir);
}

export function setupCommitProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-commit-test');
  commitTestDirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-commit';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

export function makeDirty(projectDir: string, relativePath = 'task-file.txt'): void {
  writeFileSync(join(projectDir, relativePath), 'content');
}

export function makeGitOps(
  overrides: Partial<{
    stageFiles: (dir: string, files: string[]) => Promise<void>;
    getStagedFiles: (dir: string) => Promise<string[]>;
    getInProgressGitOp: (dir: string) => Promise<InProgressGitOp | null>;
    commitChanges: (dir: string, message: string) => Promise<string>;
    createTaggedStash: (dir: string, message: string, tagName: string) => Promise<string>;
    resetIndexPreservingStaged: (dir: string, stagedBefore: string[]) => Promise<void>;
  }> = {},
) {
  return {
    stageFiles: async () => {},
    getStagedFiles: async () => [],
    getInProgressGitOp: async () => null,
    commitChanges: async () => 'commit-sha',
    createTaggedStash: async (_dir: string, _message: string, tagName: string) => tagName,
    resetIndexPreservingStaged: async () => {},
    ...overrides,
  };
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
