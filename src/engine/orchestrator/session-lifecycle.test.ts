import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { readActive, writeActive } from '../../core/sessions/lifecycle.js';
import { activeFile, sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState } from '../../core/state/machine.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { saveFinalSession, shutdownWorkflow } from './session-lifecycle.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function makeProjectDir(): string {
  const projectDir = createTempDir('session-lifecycle-test');
  dirs.push(projectDir);
  return projectDir;
}

function makeSummary(): Summary {
  return {
    feature: 'recoverable feature',
    totalTasks: 1,
    completedByLocal: 0,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 10,
    tokenUsage: {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    },
    estimatedCostSavings: '$0.00',
    escalationRate: 0,
  };
}

describe('saveFinalSession', () => {
  it('clears the active session by default', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-final';
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
      feature: 'final feature',
      startTime: 1,
      status: 'interrupted',
      summary: makeSummary(),
    });

    expect(existsSync(activeFile(projectDir))).toBe(false);
  });

  it('preserves the active session for recoverable pending recovery stops', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-recovery';
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
      feature: 'recoverable feature',
      startTime: 1,
      status: 'interrupted',
      summary: makeSummary(),
      preserveActive: true,
    });

    expect(readActive(projectDir)).toBe(sessionId);
  });
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

    await shutdownWorkflow(
      projectDir,
      sessionId,
      () => trackedState,
      () => undefined,
    );

    const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(persisted.feature).toBe('shutdown-test');
  });

  it('is safe when there is no tracked state and no current task', async () => {
    const { projectDir, sessionId } = setupGitProject();
    await expect(
      shutdownWorkflow(
        projectDir,
        sessionId,
        () => undefined,
        () => undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it('waits for current task rollback during shutdown', async () => {
    const { projectDir, sessionId } = setupGitProject();
    const file = 'src/generated.ts';
    const filePath = join(projectDir, file);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const generated = true;\n');

    await shutdownWorkflow(
      projectDir,
      sessionId,
      () => undefined,
      () => ({ file, action: 'create' }),
    );

    expect(existsSync(filePath)).toBe(false);
  });
});
