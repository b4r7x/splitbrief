import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import {
  readActive,
  reactivateExistingSession,
} from '../../../src/core/sessions/active-pointer.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { applyBackupDir, writeApplyBackup } from '../../../src/engine/orchestrator/apply/backup.js';
import { captureAcquisitionBaseline } from '../../../src/engine/orchestrator/approval/file-snapshots/entry.js';
import { buildApplyPartialRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/apply.js';
import { createSnapshot } from '../../../src/engine/snapshots/create.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('End run during Apply recovery', () => {
  it.each(['partial', 'interrupted'] as const)(
    'refuses a %s Apply and preserves the checkout, workspace, backup and recovery',
    async (kind) => {
      fixture = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
      const target = fixture;
      const ref = { projectDir: target.projectDir, sessionId: `applying-${kind}` };
      const at = '2026-10-11T00:00:00.000Z';
      const files = ['a.txt', 'b.txt'];
      for (const file of files) writeFileSync(join(target.projectDir, file), 'before Apply\n');
      await createSnapshot({ ...ref, phase: 'manual', name: 'baseline' });
      const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
      const workspaceDir = join(target.tmpDir, 'workspace');
      cpSync(target.projectDir, workspaceDir, {
        recursive: true,
        filter: (path) => !['.git', '.splitbrief'].includes(basename(path)),
      });
      for (const file of files) writeFileSync(join(workspaceDir, file), 'run result\n');
      const backupId = `backup-${kind}`;
      const backupDir = applyBackupDir(ref.projectDir, ref.sessionId, backupId);
      const backup = await writeApplyBackup({
        ...ref,
        backupId,
        workspaceDir,
        files,
        theirsBaseline: await captureAcquisitionBaseline(target.projectDir),
      });
      if (backup.kind !== 'written') throw new Error('fixture checkout changed before Apply');
      writeFileSync(join(target.projectDir, 'a.txt'), 'run result\n');
      const pendingRecovery = buildApplyPartialRecoveryIssue({
        backupId,
        backupDir,
        createdAt: at,
        written: ['a.txt'],
        files,
        failedFile: 'b.txt',
        cause: 'fixture write interrupted',
      });
      saveState(ref, {
        ...createInitialState('Recover Apply'),
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'staged-copy',
          path: workspaceDir,
          base: { snapshotId: base.manifest.id, head: null },
        },
        applying: { at, backupId },
        ...(kind === 'partial' ? { pendingRecovery } : {}),
      });
      reactivateExistingSession(ref);
      const statePath = join(sessionDir(ref.projectDir, ref.sessionId), 'state.json');
      const before = readFileSync(statePath, 'utf8');
      const manifest = readFileSync(join(backupDir, 'manifest.json'), 'utf8');

      for (const json of [false, true]) {
        const ended = await cli(target, ['continue', ref.sessionId, '--action', 'end-run'], {
          json,
          timeoutMs: 60_000,
        });
        expect(ended.exitCode, ended.stderr).toBe(1);
        expect(ended.stderr).toContain('Restore or retry Apply first');
        expect(ended.stderr).not.toContain('saved in');
        if (json) {
          expect(JSON.parse(ended.stdout)).toEqual({
            type: 'error',
            message: 'Apply did not finish. Restore or retry Apply first, then end the run.',
          });
        } else {
          expect(ended.stdout).toBe('');
        }
      }

      expect(readFileSync(statePath, 'utf8')).toBe(before);
      expect(readFileSync(join(backupDir, 'manifest.json'), 'utf8')).toBe(manifest);
      for (const entry of backup.backup.replaced) {
        expect(readFileSync(join(backupDir, 'blobs', entry.sha256), 'utf8')).toBe('before Apply\n');
      }
      expect(readFileSync(join(target.projectDir, 'a.txt'), 'utf8')).toBe('run result\n');
      expect(readFileSync(join(target.projectDir, 'b.txt'), 'utf8')).toBe('before Apply\n');
      for (const file of files)
        expect(readFileSync(join(workspaceDir, file), 'utf8')).toBe('run result\n');
      expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(false);
      expect(readActive(target.projectDir)).toBe(ref.sessionId);
    },
  );
});
