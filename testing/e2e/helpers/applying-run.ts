import { cpSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sessionDir } from '../../../src/core/paths.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { applyBackupDir, writeApplyBackup } from '../../../src/engine/orchestrator/apply/backup.js';
import { captureAcquisitionBaseline } from '../../../src/engine/orchestrator/approval/file-snapshots/entry.js';
import { buildApplyPartialRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/apply.js';
import { createSnapshot } from '../../../src/engine/snapshots/create.js';
import type { StopContinueFixture } from './stop-continue-fixture.js';

/** A run in a staged-copy fixture whose Apply wrote a.txt and stopped before b.txt, partial or interrupted. */
export async function seedApplyingRun(
  target: StopContinueFixture,
  kind: 'partial' | 'interrupted',
) {
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
    theirs: new Map(
      [...(await captureAcquisitionBaseline(target.projectDir))].map(([path, file]) => [
        path,
        { kind: 'file', ...file },
      ]),
    ),
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
  return { ref, files, workspaceDir, backupDir, backup, statePath };
}
