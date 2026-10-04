import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { sessionDir } from '../../../core/paths.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE } from '../../../lib/fs.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { error } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { type AcquisitionBaseline, readConfinedEntry } from '../approval/file-snapshots/entry.js';
import { stripGitignoreBookkeeping } from '../approval/staged-project.js';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ModeSchema = z.number().int().min(0).max(0o777);
const ApplyBackupEntrySchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  mode: ModeSchema,
});
const ApplyExpectedEntrySchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema.nullable(),
    mode: ModeSchema.nullable(),
  })
  .refine((entry) => (entry.sha256 === null) === (entry.mode === null));
const ApplyBackupSchema = z.object({
  id: z.string().min(1),
  replaced: z.array(ApplyBackupEntrySchema),
  created: z.array(z.string().min(1)),
  expected: z.array(ApplyExpectedEntrySchema),
});

export type ApplyExpectedEntry = z.infer<typeof ApplyExpectedEntrySchema>;
export type ApplyBackup = z.infer<typeof ApplyBackupSchema>;

export function applyBackupDir(projectDir: string, sessionId: string, backupId: string): string {
  return join(sessionDir(projectDir, sessionId), 'apply', backupId);
}

async function writeSyncedFile(
  path: string,
  bytes: Buffer | string,
  mode: number = SECURE_FILE_MODE,
): Promise<void> {
  const handle = await open(path, 'wx', mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readApplyBackup(
  projectDir: string,
  sessionId: string,
  backupId: string,
): Promise<ApplyBackup> {
  const manifest = await readFile(
    join(applyBackupDir(projectDir, sessionId, backupId), 'manifest.json'),
    'utf8',
  );
  return ApplyBackupSchema.parse(JSON.parse(manifest));
}

export async function readBackupBlob(
  projectDir: string,
  sessionId: string,
  backupId: string,
  sha256: string,
): Promise<Buffer> {
  const blobsDir = join(applyBackupDir(projectDir, sessionId, backupId), 'blobs');
  const blob = await readConfinedEntry(blobsDir, sha256);
  if (blob.kind !== 'file' || blob.sha256 !== sha256) {
    throw error('apply-backup-corrupt', `Apply backup blob does not match its hash: ${sha256}`, {
      path: join(blobsDir, sha256),
    });
  }
  return blob.bytes;
}

export async function writeApplyBackup(input: {
  projectDir: string;
  sessionId: string;
  backupId: string;
  workspaceDir: string;
  files: string[];
  theirsBaseline: AcquisitionBaseline;
}): Promise<
  | { kind: 'written'; backup: ApplyBackup; candidateDir: string }
  | { kind: 'changed'; files: string[] }
> {
  const { projectDir, sessionId, backupId, workspaceDir, files, theirsBaseline } = input;
  const dir = applyBackupDir(projectDir, sessionId, backupId);
  const manifestPath = join(dir, 'manifest.json');
  const previous = await readApplyBackup(projectDir, sessionId, backupId).catch(
    (cause: unknown) => {
      if (isENOENT(cause)) return undefined;
      throw cause;
    },
  );
  const replaced = new Map(previous?.replaced.map((entry) => [entry.path, entry]));
  const created = new Set(previous?.created);
  const expected = new Map(previous?.expected.map((entry) => [entry.path, entry]));
  const blobs = new Map<string, Buffer>();
  const candidates = new Map<string, { bytes: Buffer; mode: number }>();
  const changed: string[] = [];

  for (const path of [...new Set(files)].sort()) {
    assertPathConfined(path, projectDir);
    const stat = await lstat(join(projectDir, path)).catch((cause: unknown) => {
      if (isENOENT(cause)) return undefined;
      throw cause;
    });
    const fingerprint = theirsBaseline.get(path);
    if (stat !== undefined && !stat.isFile()) {
      changed.push(path);
      continue;
    }
    const checkout = await readConfinedEntry(projectDir, path);
    if (
      fingerprint !== undefined &&
      (checkout.kind !== 'file' ||
        checkout.sha256 !== fingerprint.sha256 ||
        (checkout.mode & 0o777) !== (fingerprint.mode & 0o777))
    ) {
      changed.push(path);
      continue;
    }
    if (fingerprint === undefined && checkout.kind !== 'absent') {
      changed.push(path);
      continue;
    }
    if (!replaced.has(path) && !created.has(path)) {
      if (checkout.kind === 'file') {
        replaced.set(path, { path, sha256: checkout.sha256, mode: checkout.mode & 0o777 });
        blobs.set(checkout.sha256, checkout.bytes);
      } else {
        created.add(path);
      }
    }

    const workspace = await readConfinedEntry(workspaceDir, path);
    if (workspace.kind === 'absent') {
      expected.set(path, { path, sha256: null, mode: null });
    } else {
      const bytes =
        path === '.gitignore'
          ? Buffer.from(
              stripGitignoreBookkeeping(
                workspace.bytes.toString('utf8'),
                checkout.kind === 'file' ? checkout.bytes.toString('utf8') : null,
              ),
            )
          : workspace.bytes;
      const mode = workspace.mode & 0o777;
      expected.set(path, { path, sha256: sha256Hex(bytes), mode });
      candidates.set(path, { bytes, mode });
    }
  }
  if (changed.length > 0) return { kind: 'changed', files: changed };

  const backup: ApplyBackup = {
    id: backupId,
    replaced: [...replaced.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
    created: [...created].sort(),
    expected: [...expected.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
  const blobsDir = join(dir, 'blobs');
  await mkdir(blobsDir, { recursive: true, mode: SECURE_DIR_MODE });
  for (const [sha256, bytes] of blobs) {
    const existing = await lstat(join(blobsDir, sha256)).catch((cause: unknown) => {
      if (isENOENT(cause)) return undefined;
      throw cause;
    });
    if (existing !== undefined) {
      await readBackupBlob(projectDir, sessionId, backupId, sha256);
      continue;
    }
    const temporary = join(blobsDir, `.blob.${randomBytes(8).toString('hex')}.tmp`);
    await writeSyncedFile(temporary, bytes);
    await rename(temporary, join(blobsDir, sha256));
  }
  await syncDirectory(blobsDir);
  const candidateDir = join(dir, 'candidate');
  await rm(candidateDir, { recursive: true, force: true });
  await mkdir(candidateDir, { recursive: true, mode: SECURE_DIR_MODE });
  for (const [path, { bytes, mode }] of candidates) {
    const candidatePath = join(candidateDir, path);
    await mkdir(dirname(candidatePath), { recursive: true, mode: SECURE_DIR_MODE });
    await writeSyncedFile(candidatePath, bytes, mode);
    for (let parent = dirname(candidatePath); parent !== candidateDir; parent = dirname(parent)) {
      await syncDirectory(parent);
    }
  }
  await syncDirectory(candidateDir);
  const temporary = join(dir, `.manifest.${randomBytes(8).toString('hex')}.tmp`);
  await writeSyncedFile(temporary, `${JSON.stringify(backup, null, 2)}\n`);
  await rename(temporary, manifestPath);
  await syncDirectory(dir);
  await syncDirectory(dirname(dir));
  await syncDirectory(sessionDir(projectDir, sessionId));
  return { kind: 'written', backup, candidateDir };
}
