import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sessionDir } from '../../../src/core/paths.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { applyBackupDir, writeApplyBackup } from '../../../src/engine/orchestrator/apply/backup.js';
import { captureAcquisitionBaseline } from '../../../src/engine/orchestrator/approval/file-snapshots/entry.js';
import { buildApplyPartialRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/apply.js';
import { stagedWorkspaceRoot } from '../../../src/engine/orchestrator/isolation/retention.js';
import { createSnapshot } from '../../../src/engine/snapshots/create.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import type { StopContinueFixture } from './stop-continue-fixture.js';

const FILES = ['a.txt', 'b.txt'];

/**
 * A staged-copy workspace whose run changed `files` from `before Apply` to `run result`,
 * where a run keeps it: inside the session, so closing the run removes it.
 */
async function seedWorkspace(target: StopContinueFixture, ref: SessionRef, files: string[]) {
  for (const file of files) writeFileSync(join(target.projectDir, file), 'before Apply\n');
  await createSnapshot({ ...ref, phase: 'manual', name: 'baseline' });
  const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
  const copy = join(target.tmpDir, 'workspace');
  cpSync(target.projectDir, copy, {
    recursive: true,
    filter: (path) => !['.git', '.splitbrief'].includes(basename(path)),
  });
  const root = stagedWorkspaceRoot(ref, `stage-${randomBytes(16).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  const workspaceDir = join(root, 'workspace');
  renameSync(copy, workspaceDir);
  for (const file of files) writeFileSync(join(workspaceDir, file), 'run result\n');
  const workspace = {
    kind: 'staged-copy' as const,
    path: workspaceDir,
    base: { snapshotId: base.manifest.id, head: null },
  };
  return { files, workspaceDir, workspace };
}

function statePathOf(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), 'state.json');
}

/** A reviewed run in a staged-copy fixture, ready to apply a.txt and b.txt. */
export async function seedReadyRun(target: StopContinueFixture) {
  const ref = { projectDir: target.projectDir, sessionId: 'ready-to-apply' };
  const { files, workspaceDir, workspace } = await seedWorkspace(target, ref, FILES);
  saveState(ref, {
    ...createInitialState('Apply the run'),
    phase: 'complete',
    reviewStatus: 'passed',
    workspace,
  });
  reactivateExistingSession(ref);
  return { ref, files, workspaceDir, statePath: statePathOf(ref) };
}

/**
 * A run in a staged-copy fixture whose Apply wrote the first file and stopped before the second,
 * partial or interrupted; a.txt and b.txt unless `runFiles` names others.
 */
export async function seedApplyingRun(
  target: StopContinueFixture,
  kind: 'partial' | 'interrupted',
  runFiles: string[] = FILES,
) {
  const ref = { projectDir: target.projectDir, sessionId: `applying-${kind}` };
  const at = '2026-10-11T00:00:00.000Z';
  const { files, workspaceDir, workspace } = await seedWorkspace(target, ref, runFiles);
  const [writtenFile = '', failedFile = ''] = files;
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
  writeFileSync(join(target.projectDir, writtenFile), 'run result\n');
  const pendingRecovery = buildApplyPartialRecoveryIssue({
    backupId,
    backupDir,
    createdAt: at,
    written: [writtenFile],
    files,
    failedFile,
    cause: 'fixture write interrupted',
  });
  saveState(ref, {
    ...createInitialState('Recover Apply'),
    phase: 'complete',
    reviewStatus: 'passed',
    workspace,
    applying: { at, backupId },
    ...(kind === 'partial' ? { pendingRecovery } : {}),
  });
  reactivateExistingSession(ref);
  return { ref, files, workspaceDir, backupDir, backup, statePath: statePathOf(ref) };
}
