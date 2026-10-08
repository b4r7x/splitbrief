import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir } from '../../../core/paths.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { registerProcess } from '../../../lib/process/registry.js';
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

  it('keeps the interrupted task partial changes instead of reverting them', async () => {
    const { projectDir, sessionId } = setupGitProject();
    const file = 'src/generated.ts';
    const filePath = join(projectDir, file);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const generated = true;\n');

    await shutdownWorkflow({
      projectDir,
      sessionId,
      getTrackedState: () => undefined,
      getCurrentTask: () => ({ suggestedFiles: [file], action: 'create' }),
    });

    expect(readFileSync(filePath, 'utf-8')).toBe('export const generated = true;\n');
  });

  it('waits for process cleanup before persisting state', async () => {
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
      getCurrentTask: () => ({ suggestedFiles: [file], action: 'create' }),
    });

    const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
    expect(existsSync(statePath)).toBe(false);

    await shutdown;

    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(filePath)).toBe(true);
  });
});

describe('awaitActiveWorkflowShutdown — TUI exit alignment', () => {
  it('is a no-op when no workflow is running', async () => {
    await expect(awaitActiveWorkflowShutdown()).resolves.toBeUndefined();
  });

  it('shares one shutdown with the signal path and keeps the run changes', async () => {
    const { projectDir, sessionId } = setupGitProject();
    const file = 'src/generated.ts';

    let stateDuringRun: WorkflowState | undefined;
    await withShutdownHandlers(
      {
        projectDir,
        sessionId,
        getTrackedState: () => stateDuringRun,
        getCurrentTask: () => ({ suggestedFiles: [file], action: 'create' }),
      },
      async () => {
        stateDuringRun = { ...createInitialState('feat'), feature: 'tui-exit' };
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, file), 'export const generated = true;\n');

        await awaitActiveWorkflowShutdown();
        expect(existsSync(join(projectDir, file))).toBe(true);
      },
    );

    const persisted = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), 'state.json'), 'utf-8'),
    );
    expect(persisted.feature).toBe('tui-exit');
    await expect(awaitActiveWorkflowShutdown()).resolves.toBeUndefined();
  });
});
