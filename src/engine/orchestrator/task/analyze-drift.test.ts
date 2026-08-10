import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { Task } from '../../../core/schemas/task.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { readDriftChainState } from '../drift/chain-state.js';
import { runChainAnalysisSafe } from './analyze-drift.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupRun(runStartChangedFiles: string[]) {
  const projectDir = createTempDir('analyze-drift-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-drift';
  ensureSessionDir(projectDir, sessionId);
  mkdirSync(join(projectDir, 'src'), { recursive: true });

  const t1 = makeTask({ id: 'T001', file: 'src/text.ts' });
  const t2 = makeTask({ id: 'T002', file: 'src/text.test.ts' });
  const state = makeImplState([t1, t2], {
    changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles },
  });
  const wctx = makeWctx({ projectDir, sessionId });
  return { projectDir, sessionId, state, wctx, t1, t2 };
}

function attributeCompletedTasks(
  ref: { projectDir: string; sessionId: string },
  tasks: Task[],
): void {
  writeEvidenceLedger(ref, {
    version: 1,
    sessionId: ref.sessionId,
    feature: 'feat',
    generatedAt: new Date().toISOString(),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      file: task.file,
      status: 'done',
      retries: 0,
      changedFiles: [task.file],
      validation: [],
      expectedEvidence: [],
      observedEvidence: [],
      escalated: false,
    })),
    validationSummary: { passed: tasks.length, failed: 0, skipped: 0, escalated: 0 },
  });
}

describe('runChainAnalysisSafe', () => {
  it('does not chain the run-owned event sink that was dirty at run start', async () => {
    const { projectDir, sessionId, state, wctx, t1, t2 } = setupRun(['run.ndjson']);
    const sink = join(projectDir, 'run.ndjson');
    writeFileSync(sink, 'event 1\n');

    const snapshot1 = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/text.ts'), 'export const a = 1;\n');
    appendFileSync(sink, 'event 2\n');
    attributeCompletedTasks({ projectDir, sessionId }, [t1]);
    await runChainAnalysisSafe({ wctx, task: t1, state, taskStartSnapshot: snapshot1 });

    const snapshot2 = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/text.test.ts'), 'export const b = 2;\n');
    appendFileSync(sink, 'event 3\n');
    attributeCompletedTasks({ projectDir, sessionId }, [t1, t2]);
    await runChainAnalysisSafe({ wctx, task: t2, state, taskStartSnapshot: snapshot2 });

    const chains = readDriftChainState({ projectDir, sessionId });
    expect(chains?.emittedChains).toEqual([]);
    expect(chains?.activeChain.score).toBe(0);
  });

  it('still emits a chain for an untargeted file the run itself keeps changing', async () => {
    const { projectDir, sessionId, state, wctx, t1, t2 } = setupRun([]);
    const stray = join(projectDir, 'stray.log');

    const snapshot1 = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/text.ts'), 'export const a = 1;\n');
    writeFileSync(stray, 'line 1\n');
    attributeCompletedTasks({ projectDir, sessionId }, [t1]);
    await runChainAnalysisSafe({ wctx, task: t1, state, taskStartSnapshot: snapshot1 });

    const snapshot2 = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/text.test.ts'), 'export const b = 2;\n');
    appendFileSync(stray, 'line 2\n');
    attributeCompletedTasks({ projectDir, sessionId }, [t1, t2]);
    await runChainAnalysisSafe({ wctx, task: t2, state, taskStartSnapshot: snapshot2 });

    const chains = readDriftChainState({ projectDir, sessionId });
    expect(chains?.emittedChains).toHaveLength(1);
    expect(chains?.emittedChains[0]?.representativePath).toBe('stray.log');
    expect(chains?.emittedChains[0]?.score).toBeCloseTo(0.64, 10);
  });
});
