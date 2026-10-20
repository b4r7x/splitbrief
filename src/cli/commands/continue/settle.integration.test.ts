import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeWorkflowState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { buildCommandContext } from '../../../app/command-context.js';
import { listSessions, readSession } from '../../../core/sessions/io.js';
import { sessionStatusWord } from '../../../core/sessions/display.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { writeManifest } from '../../../engine/snapshots/manifest.js';
import { finalizeRunAtRest } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { configStore } from '../../../stores/project/config.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { settleReadyRun } from './settle.js';

let projectDir = '';

afterEach(() => {
  vi.restoreAllMocks();
  resetAllStores();
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
});

describe('Apply halt activity', () => {
  it.each(['run command', 'continue command'] as const)(
    'records the new halt time through the %s',
    async (entry) => {
      projectDir = createTempDir('apply-halt');
      const ref = { projectDir, sessionId: 'apply-conflict' };
      const workspaceDir = join(projectDir, '.splitbrief', 'workspace');
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(join(projectDir, 'asset.bin'), Buffer.from([0, 1]));
      writeFileSync(join(workspaceDir, 'asset.bin'), Buffer.from([0, 2]));
      await writeManifest(projectDir, ref.sessionId, {
        version: 1,
        id: 'baseline',
        sessionId: ref.sessionId,
        createdAt: '2026-10-15T14:00:00.000Z',
        phase: 'manual',
        fileHashes: { 'asset.bin': sha256Hex(Buffer.from([0, 3])) },
        fileEntries: [],
        trackedFileCount: 1,
      });
      const config = makeConfig();
      const state = makeWorkflowState({
        ...RUN_CREW,
        startedAt: '2026-10-15T14:00:00.000Z',
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'staged-copy',
          path: workspaceDir,
          base: { snapshotId: 'baseline', head: null },
        },
      });
      saveState(ref, state);
      const readyAt = Date.parse('2026-10-15T14:26:00.000Z');
      const haltedAt = Date.parse('2026-10-15T14:36:00.000Z');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(readyAt);
      finalizeRunAtRest({ ref, state });
      expect(readSession(ref)?.completedAt).toBe(readyAt);
      sessionsStore.load(projectDir);
      clock.mockReturnValue(haltedAt);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      if (entry === 'run command') {
        configStore.__testReset({ projectDir, config, diskConfig: config });
        routerStore.init({
          screen: 'workflow',
          run: readRunRecord(ref),
          execution: { kind: 'at-rest' },
        });
        const context = buildCommandContext({
          exit: () => {},
          workflow: {
            requestClearQueue: () => ({ status: 'cleared', count: 0 }),
            getRowActions: () => new Map(),
            readScrollMetrics: () => ({
              renderableCount: 0,
              totalHeight: 0,
              maxOffset: 0,
              viewportHeight: 0,
            }),
            resolveCopyValue: () => null,
          },
        });
        expect(await context.acceptRun(false)).toEqual({ status: 'halted' });
        expect(sessionsStore.get().sessions[0]?.completedAt).toBe(haltedAt);
      } else {
        await expect(
          settleReadyRun({ ...ref, state, action: 'apply', json: false }),
        ).rejects.toMatchObject({ exitCode: 1 });
      }

      const halted = readSession(ref);
      expect(halted).toMatchObject({ completedAt: haltedAt, stop: 'waiting-for-you' });
      const rows = listSessions(projectDir);
      expect(rows.map((session) => session.completedAt)).toEqual([haltedAt]);
      expect(rows.map(sessionStatusWord)).toEqual(['waiting for you']);
      const saved = loadState(ref);
      expect(saved?.pendingRecovery?.reason).toBe('apply-conflict');
      expect(saved?.pendingRecovery?.details).toContain(
        'asset.bin · both sides changed a binary file',
      );

      if (saved === null) throw new Error('Missing halted state');
      clock.mockReturnValue(haltedAt + 60_000);
      await expect(
        settleReadyRun({ ...ref, state: saved, action: 'apply', json: false }),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(readSession(ref)?.completedAt).toBe(haltedAt);
    },
  );
});
