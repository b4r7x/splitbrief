import { lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { SnapshotManifest } from '../../../core/schemas/snapshot.js';
import { SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
} from '../../../lib/fs/confinement.js';
import type { RejectRunSnapshotResult } from '../../../core/runtime/commands/types.js';
import { runRejectFacts } from '../../../core/runtime/commands/messages.js';
import { resolveValidatedBlobPath } from '../blob-resolver.js';
import { isENOENT } from '../../../utils/errno.js';
import { error } from '../../../utils/error.js';
import { readManifest } from '../manifest.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { loadState } from '../../../core/state/persistence.js';
import { withCheckoutWriteLock } from '../../checkout-write.js';
import { expectedCheckoutWrites } from '../../checkout-writers.js';
import {
  putBackCheckoutEntries,
  saveReplacedEntries,
} from '../../orchestrator/isolation/entry-snapshot.js';
import {
  ABSENT_CHECKOUT_ENTRY,
  fileCheckoutFingerprint,
  readCheckoutFingerprint,
} from '../../orchestrator/isolation/checkout-entries.js';
import { writeConfinedEntry } from '../../orchestrator/approval/file-snapshots/entry/write.js';
import { sameFileEntry } from '../../orchestrator/approval/file-snapshots/entry/read.js';
import { readConfinedEntry } from '../../orchestrator/approval/file-snapshots/entry/read.js';
import {
  ACCEPTED_RUN_SNAPSHOT_NAME,
  createRunLedger,
  readRunLedger,
  resolveLedgerRunSnapshot,
  writeRunLedger,
} from './ledger.js';

async function restoreBaselineFile(opts: {
  projectDir: string;
  sessionId: string;
  path: string;
  baselineEntry: SnapshotManifest['fileEntries'][number] | undefined;
  beforeWrite: () => Promise<void>;
}): Promise<boolean> {
  if (!opts.baselineEntry) return false;

  const sourcePath = await resolveValidatedBlobPath({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    snapshotId: SNAPSHOT_BASELINE_ID,
    path: opts.path,
    entry: opts.baselineEntry,
  });
  if (sourcePath === null) return false;

  let contents: Buffer;
  try {
    contents = await readFile(sourcePath);
  } catch (err) {
    if (!isENOENT(err)) throw err;
    return false;
  }

  await opts.beforeWrite();
  const current = await readConfinedEntry(opts.projectDir, opts.path);
  await writeConfinedEntry(
    opts.projectDir,
    opts.path,
    {
      kind: 'file',
      bytes: contents,
      sha256: opts.baselineEntry.hash,
      mode: current.kind === 'file' ? current.mode : (opts.baselineEntry.mode ?? 0o644),
    },
    opts.beforeWrite,
  );
  return true;
}

async function hashProjectFileIfConfined(
  projectDir: string,
  path: string,
): Promise<string | null | undefined> {
  assertPathConfined(path, projectDir);
  const filePath = join(projectDir, path);
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile()) return undefined;
  } catch (err) {
    if (!isENOENT(err)) throw err;
    assertWritablePathConfined(path, projectDir);
    return null;
  }
  assertExistingPathConfined(path, projectDir);
  const entry = await readConfinedEntry(projectDir, path);
  return entry.kind === 'file' ? entry.sha256 : null;
}

async function restoreBaselinePaths(
  ref: SessionRef,
  baseline: SnapshotManifest,
  latest: SnapshotManifest,
  restore: readonly string[],
  remove: readonly string[],
): Promise<Extract<RejectRunSnapshotResult, { status: 'rejected' }>> {
  const savedTo = await saveReplacedEntries(ref, [...restore, ...remove]);
  const baselineEntries = new Map(baseline.fileEntries.map((entry) => [entry.path, entry]));
  const restoreSet = new Set(restore);
  const restoredPaths: string[] = [];
  const deletedPaths: string[] = [];
  const conflictedPaths: string[] = [];
  const missingSnapshotFiles: string[] = [];
  for (const path of [...restore, ...remove]) {
    const changed = error('snapshot-reject-conflict', `File changed during rejection: ${path}`, {
      path,
    });
    const beforeWrite = async (): Promise<void> => {
      const currentHash = await hashProjectFileIfConfined(ref.projectDir, path);
      if (currentHash !== (latest.fileHashes[path] ?? null)) throw changed;
    };
    try {
      await beforeWrite();
      const current = await readConfinedEntry(ref.projectDir, path);
      const beforeCommit = async (): Promise<void> => {
        await beforeWrite();
        if (!sameFileEntry(current, await readConfinedEntry(ref.projectDir, path))) throw changed;
      };
      if (restoreSet.has(path)) {
        if (
          await restoreBaselineFile({
            ...ref,
            path,
            baselineEntry: baselineEntries.get(path),
            beforeWrite: beforeCommit,
          })
        ) {
          restoredPaths.push(path);
        } else missingSnapshotFiles.push(path);
      } else {
        await writeConfinedEntry(ref.projectDir, path, { kind: 'absent' }, beforeCommit);
        deletedPaths.push(path);
      }
    } catch (err) {
      if (err !== changed) throw err;
      conflictedPaths.push(path);
    }
  }
  return {
    status: 'rejected',
    snapshotId: baseline.id,
    restoredPaths,
    deletedPaths,
    conflictedPaths,
    missingSnapshotFiles,
    ...(savedTo !== undefined && { savedTo: relative(ref.projectDir, savedTo) }),
  };
}

async function restoreCheckoutBaseline(
  ref: SessionRef,
  baseline: SnapshotManifest,
  latest: SnapshotManifest,
): Promise<Extract<RejectRunSnapshotResult, { status: 'rejected' }>> {
  const { projectDir } = ref;
  const oldEntries = new Map(baseline.fileEntries.map((entry) => [entry.path, entry]));
  const newEntries = new Map(latest.fileEntries.map((entry) => [entry.path, entry]));
  const oldLinks = new Map((baseline.symlinks ?? []).map((link) => [link.path, link.target]));
  const newLinks = new Map((latest.symlinks ?? []).map((link) => [link.path, link.target]));
  const paths = new Set([
    ...Object.keys(baseline.fileHashes),
    ...Object.keys(latest.fileHashes),
    ...oldLinks.keys(),
    ...newLinks.keys(),
  ]);
  return withCheckoutWriteLock(projectDir, async () => {
    const candidates: string[] = [];
    const oldFingerprints = new Map<string, string>();
    for (const path of [...paths].sort()) {
      const oldHash = Object.hasOwn(baseline.fileHashes, path)
        ? baseline.fileHashes[path]
        : undefined;
      const newHash = Object.hasOwn(latest.fileHashes, path) ? latest.fileHashes[path] : undefined;
      const oldMode = oldEntries.get(path)?.mode;
      const newMode = newEntries.get(path)?.mode ?? oldMode;
      const oldLink = oldLinks.get(path);
      if (oldHash === newHash && oldMode === newMode && oldLink === newLinks.get(path)) continue;
      const before =
        oldLink !== undefined
          ? `symlink:${oldLink}`
          : oldHash === undefined
            ? ABSENT_CHECKOUT_ENTRY
            : oldMode === undefined
              ? undefined
              : fileCheckoutFingerprint(oldHash, oldMode);
      if (before !== undefined) {
        if (before === (await readCheckoutFingerprint(projectDir, path))) continue;
        oldFingerprints.set(path, before);
      }
      candidates.push(path);
    }
    const result = await putBackCheckoutEntries({
      ref,
      files: candidates,
      expected: expectedCheckoutWrites(ref, baseline.checkoutRevision, oldFingerprints),
      replacement: async (path) => {
        const target = oldLinks.get(path);
        if (target !== undefined) return { kind: 'symlink', target };
        const old = oldEntries.get(path);
        if (old === undefined || old.mode === undefined) {
          return Object.hasOwn(baseline.fileHashes, path) ? undefined : { kind: 'absent' };
        }
        const source = await resolveValidatedBlobPath({
          ...ref,
          snapshotId: baseline.id,
          path,
          entry: old,
        });
        if (source === null) return undefined;
        return { kind: 'file', bytes: await readFile(source), sha256: old.hash, mode: old.mode };
      },
    });
    return {
      status: 'rejected',
      snapshotId: latest.id,
      restoredPaths: result.restoredFiles.filter((path) => !result.removedPaths.includes(path)),
      deletedPaths: result.removedPaths,
      conflictedPaths: result.keptPaths,
      missingSnapshotFiles: result.missingPaths,
      ...(result.savedTo !== undefined && { savedTo: relative(projectDir, result.savedTo) }),
    };
  });
}

export async function rejectRunSnapshotBody(
  projectDir: string,
  sessionId: string,
): Promise<RejectRunSnapshotResult> {
  const ledger = await readRunLedger(projectDir, sessionId);
  if (ledger?.accepted) {
    return { status: 'accepted', snapshotId: ledger.runSnapshotIds.at(-1) ?? '' };
  }
  if (ledger?.rejected) {
    return {
      status: 'rejected',
      snapshotId: ledger.runSnapshotIds.at(-1) ?? '',
      restoredPaths: [],
      deletedPaths: [],
      conflictedPaths: [],
      missingSnapshotFiles: [],
    };
  }

  if (!ledger) return { status: 'empty' };
  const latest = await resolveLedgerRunSnapshot(projectDir, sessionId, ledger);
  if (!latest) return { status: 'empty' };
  if (latest.name === ACCEPTED_RUN_SNAPSHOT_NAME) {
    return { status: 'accepted', snapshotId: latest.id };
  }

  const baseline = await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);
  const ref = { projectDir, sessionId };
  const result =
    loadState(ref)?.workspace?.kind === 'checkout'
      ? await restoreCheckoutBaseline(ref, baseline, latest)
      : await restoreSnapshotBaseline(ref, baseline, latest);
  const fullyRejected =
    result.conflictedPaths.length === 0 && result.missingSnapshotFiles.length === 0;
  const facts = runRejectFacts(result);
  const nextLedger = await createRunLedger({
    projectDir,
    sessionId,
    runSnapshot: latest,
    accepted: false,
    rejected: fullyRejected,
    putBack: { restored: facts.restored, removed: facts.removed },
  });
  await writeRunLedger(projectDir, sessionId, nextLedger);
  return result;
}

async function restoreSnapshotBaseline(
  ref: SessionRef,
  baseline: SnapshotManifest,
  latest: SnapshotManifest,
): Promise<Extract<RejectRunSnapshotResult, { status: 'rejected' }>> {
  const { projectDir } = ref;
  const paths = new Set([...Object.keys(baseline.fileHashes), ...Object.keys(latest.fileHashes)]);

  const restoredPaths: string[] = [];
  const deletedPaths: string[] = [];
  const conflictedPaths: string[] = [];

  for (const path of [...paths].sort()) {
    assertPathConfined(path, projectDir);

    const baselineHash = baseline.fileHashes[path];
    const latestHash = latest.fileHashes[path];
    if (baselineHash === latestHash) continue;

    const currentHash = await hashProjectFileIfConfined(projectDir, path);

    if (baselineHash === undefined) {
      if (currentHash === null) continue;
      if (currentHash !== latestHash) {
        conflictedPaths.push(path);
        continue;
      }
      deletedPaths.push(path);
      continue;
    }

    if (latestHash === undefined) {
      if (currentHash === baselineHash) continue;
      if (currentHash !== null) {
        conflictedPaths.push(path);
        continue;
      }
      restoredPaths.push(path);
      continue;
    }

    if (currentHash === baselineHash) continue;

    if (currentHash !== latestHash) {
      conflictedPaths.push(path);
      continue;
    }

    restoredPaths.push(path);
  }

  const restored = await restoreBaselinePaths(ref, baseline, latest, restoredPaths, deletedPaths);
  return {
    ...restored,
    snapshotId: latest.id,
    conflictedPaths: [...conflictedPaths, ...restored.conflictedPaths].sort(),
  };
}
