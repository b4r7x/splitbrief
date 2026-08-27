import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir } from '../../../core/paths.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { registerProcess } from '../../../lib/process/registry.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
  withActiveTaskSnapshot,
} from '../changed-files-baseline.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { awaitActiveWorkflowShutdown, shutdownWorkflow, withShutdownHandlers } from './shutdown.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupGitProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('session-lifecycle-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-final';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('shutdownWorkflow', () => {
  it('persists tracked state to disk when one is available', async () => {
    const { projectDir, sessionId } = setupGitProject();

    const trackedState: WorkflowState = {
      ...createInitialState('feat'),
      feature: 'shutdown-test',
    };

    await shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => trackedState,
      getCurrentTask: () => undefined,
    });

    const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(persisted.feature).toBe('shutdown-test');
  });

  it('is safe when there is no tracked state and no current task', async () => {
    const { projectDir, sessionId } = setupGitProject();
    await shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => undefined,
      getCurrentTask: () => undefined,
    });

    expect(existsSync(join(sessionDir(projectDir, sessionId), 'state.json'))).toBe(false);
  });

  it('waits for current task rollback during shutdown', async () => {
    const { projectDir, sessionId } = setupGitProject();
    const file = 'src/generated.ts';
    const filePath = join(projectDir, file);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const generated = true;\n');

    await shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => undefined,
      getCurrentTask: () => ({ file, action: 'create' }),
    });

    expect(existsSync(filePath)).toBe(false);
  });

  it('waits for process cleanup before persisting state or rolling back files', async () => {
    const { projectDir, sessionId } = setupGitProject();
    const file = 'src/generated.ts';
    const filePath = join(projectDir, file);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const generated = true;\n');
    const trackedState: WorkflowState = {
      ...createInitialState('feat'),
      feature: 'process-barrier-test',
    };
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100)); process.stdout.write("ready"); setInterval(() => {}, 1000);',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
    registerProcess(child);

    const shutdown = shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => trackedState,
      getCurrentTask: () => ({ file, action: 'create' }),
    });

    const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(filePath)).toBe(true);

    await shutdown;

    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });
});

function writeProjectFile(projectDir: string, file: string, content: string): void {
  const target = join(projectDir, file);
  mkdirSync(join(projectDir, file.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(target, content);
}

async function stateWithBaseline(projectDir: string, tasks: Task[]): Promise<WorkflowState> {
  const baseline = await captureChangedFilesBaseline(projectDir);
  return {
    ...createInitialState('feat'),
    phase: 'implementing',
    tasks,
    currentTaskIndex: 0,
    changedFilesBaseline: serializeChangedFilesBaseline(baseline),
  };
}

async function stateWithActiveTaskSnapshot(
  projectDir: string,
  tasks: Task[],
): Promise<WorkflowState> {
  const baseline = await captureChangedFilesBaseline(projectDir);
  const activeTaskSnapshot = await getChangedFilesSnapshot(projectDir);
  return {
    ...createInitialState('feat'),
    phase: 'implementing',
    tasks,
    currentTaskIndex: 0,
    changedFilesBaseline: serializeChangedFilesBaseline(
      withActiveTaskSnapshot(baseline, activeTaskSnapshot),
    ),
  };
}

describe('shutdownWorkflow — interrupted-task rollback', () => {
  it('discards the whole attributed set, not just task.file, for a multi-file task', async () => {
    const projectDir = createTempDir('session-lifecycle-test');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, { 'src/a.ts': 'committed a\n' });
    const sessionId = 'sess-multi';
    ensureSessionDir(projectDir, sessionId);

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/a.ts',
      scope: { inBounds: ['src/b.ts'] },
    });
    const trackedState = await stateWithBaseline(projectDir, [task]);

    writeProjectFile(projectDir, 'src/a.ts', 'partial agent a\n');
    writeProjectFile(projectDir, 'src/b.ts', 'partial agent b\n');

    await shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => trackedState,
      getCurrentTask: () => ({ file: 'src/a.ts', action: 'modify' }),
    });

    expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf-8')).toBe('committed a\n');
    expect(existsSync(join(projectDir, 'src/b.ts'))).toBe(false);
  });

  it('restores a pre-dirty attributed file to its exact pre-task content', async () => {
    const projectDir = createTempDir('session-lifecycle-test');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, { 'src/a.ts': 'committed a\n' });
    const sessionId = 'sess-dirty';
    ensureSessionDir(projectDir, sessionId);

    writeProjectFile(projectDir, 'src/a.ts', 'user edit a\n');
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/a.ts',
      scope: { inBounds: ['src/generated.ts'] },
    });
    const trackedState = await stateWithActiveTaskSnapshot(projectDir, [task]);

    writeProjectFile(projectDir, 'src/a.ts', 'agent a\n');
    writeProjectFile(projectDir, 'src/generated.ts', 'agent generated\n');

    await shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => trackedState,
      getCurrentTask: () => ({ file: 'src/a.ts', action: 'modify' }),
    });

    expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf-8')).toBe('user edit a\n');
    expect(existsSync(join(projectDir, 'src/generated.ts'))).toBe(false);
  });

  it('restores from an active task snapshot after state is reloaded', async () => {
    const projectDir = createTempDir('session-lifecycle-test');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, { 'src/a.ts': 'committed a\n' });
    const sessionId = 'sess-reloaded';
    ensureSessionDir(projectDir, sessionId);

    writeProjectFile(projectDir, 'src/a.ts', 'user edit a\n');
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/a.ts',
      scope: { inBounds: ['src/generated.ts'] },
    });
    const state = await stateWithActiveTaskSnapshot(projectDir, [task]);
    saveState({ projectDir, sessionId }, state);
    const reloaded = loadState({ projectDir, sessionId });
    if (!reloaded) throw new Error('expected persisted workflow state');

    writeProjectFile(projectDir, 'src/a.ts', 'agent a\n');
    writeProjectFile(projectDir, 'src/generated.ts', 'agent generated\n');

    await shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => reloaded,
      getCurrentTask: () => ({ file: 'src/a.ts', action: 'modify' }),
    });

    expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf-8')).toBe('user edit a\n');
    expect(existsSync(join(projectDir, 'src/generated.ts'))).toBe(false);
  });
});

describe('awaitActiveWorkflowShutdown — TUI exit alignment', () => {
  it('is a no-op when no workflow is running', async () => {
    await expect(awaitActiveWorkflowShutdown()).resolves.toBeUndefined();
  });

  it('runs the same rollback the signal path runs, sharing one shutdown', async () => {
    const projectDir = createTempDir('session-lifecycle-test');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-tui';
    ensureSessionDir(projectDir, sessionId);
    const file = 'src/generated.ts';

    let stateDuringRun: WorkflowState | undefined;
    await withShutdownHandlers(
      {
        projectDir,
        sessionId,
        getTrackedState: () => stateDuringRun,
        getCurrentTask: () => ({ file, action: 'create' }),
      },
      async () => {
        const task = makeTask({ id: 'T001', action: 'create', file });
        stateDuringRun = await stateWithBaseline(projectDir, [task]);
        writeProjectFile(projectDir, file, 'export const generated = true;\n');

        await awaitActiveWorkflowShutdown();
        expect(existsSync(join(projectDir, file))).toBe(false);
      },
    );

    await expect(awaitActiveWorkflowShutdown()).resolves.toBeUndefined();
  });
});
