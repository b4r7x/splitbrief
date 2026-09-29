import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { sessionDir } from '../../../core/paths.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../../core/phases.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Task } from '../../../core/schemas/task.js';
import {
  RetainedWorkspaceSchema,
  StagedWorkspaceLeafSchema,
  type RetainedWorkspace,
  type WorkspaceOwner,
} from '../../../core/schemas/retained-workspace.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import {
  assertSessionConfinement,
  assertSessionDirConfined,
} from '../../../core/sessions/confinement.js';
import {
  SECURE_FILE_MODE,
  writeConfinedSecureFileAsync,
  writeSecureFile,
} from '../../../lib/fs.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { isENOENT, isNodeError } from '../../../lib/process/errors.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { error, matches } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { workflowCancelledReasonFromSignal } from '../../events/workflow-cancel.js';
import type { IsolatedWorkspace } from './types.js';

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4096;
// Exclusive creation refuses any existing final leaf; descriptor writes stay
// bound to the opened file and never re-resolve the parent pathname.
const RECEIPT_CREATE_FLAGS =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_RDWR |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;
// The idempotent retry probe must not follow a swapped symlink or block on a foreign FIFO.
const RECEIPT_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export const retentionError = {
  unavailable: () =>
    error(
      'isolation-retention-unavailable',
      'The stopped workspace could not be verified. Its files were left in place; automatic continuation is blocked.',
    ),
  failed: (dir: string, cause: unknown) =>
    error(
      'isolation-retention-failed',
      `Files remain at ${dir}, but their continuation record could not be saved. Automatic continuation is unavailable.`,
      undefined,
      cause,
    ),
  isFailed: matches('isolation-retention-failed'),
  isUnavailable: matches('isolation-retention-unavailable'),
};

export function isResumableWorkspaceStop(signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    workflowCancelledReasonFromSignal(signal) === undefined &&
    signal.reason !== WORKFLOW_REWIND_ABORT_REASON
  );
}

export function workspaceOwner(input: {
  task: Task;
  attempt: number;
  config: Config;
}): WorkspaceOwner {
  const { task, attempt, config } = input;
  return {
    taskId: task.id,
    contract: hashTaskBrief([task]),
    attempt,
    buildSeat: sha256Hex(canonicalJSON(config.implementer)),
  };
}

function recordPath(ref: SessionRef, name = 'retained-workspace.json'): string {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const root = sessionDir(ref.projectDir, ref.sessionId);
  const path = join(root, name);
  assertSessionConfinement(path, root);
  return relative(ref.projectDir, path);
}

export function clearWorkspaceRecord(ref: SessionRef): void {
  writeSecureFile(join(ref.projectDir, recordPath(ref)), 'null\n');
}

interface ReceiptParent {
  dev: number;
  ino: number;
}

function isEEXIST(err: unknown): boolean {
  return isNodeError(err) && err.code === 'EEXIST';
}

function receiptParentIdentity(directory: string): ReceiptParent {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink())
    throw retentionError.unavailable();
  return { dev: stat.dev, ino: stat.ino };
}

function assertReceiptParent(directory: string, expected: ReceiptParent): void {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (
    stat === undefined ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino
  )
    throw retentionError.unavailable();
}

function assertReceiptHandle(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw retentionError.unavailable();
}

function readReceiptBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let filled = 0;
  while (filled < size) {
    const read = readSync(fd, bytes, filled, size - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  return filled === size ? bytes : bytes.subarray(0, filled);
}

function assertCompleteReceipt(fd: number, path: string, expected: Buffer): void {
  const stat = fstatSync(fd);
  if (stat.size !== expected.length) throw retentionError.unavailable();
  if (!readReceiptBytes(fd, expected.length).equals(expected)) throw retentionError.unavailable();
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (
    current === undefined ||
    !current.isFile() ||
    current.dev !== stat.dev ||
    current.ino !== stat.ino
  )
    throw retentionError.unavailable();
}

// Publish at the final leaf without a replacement rename: exclusive creation refuses
// any existing entry, and every byte travels through the returned descriptor, so a
// renamed parent cannot redirect the write onto foreign bytes. An existing entry is
// accepted only when it already holds the exact complete expected receipt; anything
// else is left untouched and fails.
function publishRetainedReceipt(path: string, expected: Buffer): void {
  const directory = dirname(path);
  const parent = receiptParentIdentity(directory);
  let fd: number;
  let created = false;
  try {
    fd = openSync(path, RECEIPT_CREATE_FLAGS, SECURE_FILE_MODE);
    created = true;
  } catch (err) {
    if (!isEEXIST(err)) throw err;
    fd = openSync(path, RECEIPT_READ_FLAGS);
  }
  try {
    assertReceiptHandle(fd);
    if (created) {
      // A parent swapped in before exclusive creation can only hold the empty leaf
      // just created; refuse before that leaf receives receipt content. The empty
      // residual is left in place: removing it by pathname would be substitution-prone.
      assertReceiptParent(directory, parent);
      let written = 0;
      while (written < expected.length) {
        written += writeSync(fd, expected, written, expected.length - written);
      }
      fsyncSync(fd);
    }
    assertCompleteReceipt(fd, path, expected);
    assertReceiptParent(directory, parent);
  } finally {
    closeSync(fd);
  }
}

export function preserveStagedWorkspace(
  ref: SessionRef,
  record: Pick<RetainedWorkspace, 'location' | 'directory'>,
): void {
  if (record.location.kind !== 'staged-copy') throw retentionError.unavailable();
  const leaf = StagedWorkspaceLeafSchema.parse(record.location.leaf);
  // A receipt records the old location before its continuation record is retired.
  // It carries no source bytes, credentials, or permission to reacquire the stage.
  const content = `${JSON.stringify({
    version: 1,
    disposition: 'manual-removal',
    location: record.location,
    directory: record.directory,
  })}\n`;
  if (Buffer.byteLength(content) > MAX_RECEIPT_BYTES) throw retentionError.unavailable();
  publishRetainedReceipt(
    join(ref.projectDir, recordPath(ref, `preserved-${leaf}.json`)),
    Buffer.from(content, 'utf8'),
  );
}

export function stagedWorkspaceRoot(ref: SessionRef, leaf: string): string {
  StagedWorkspaceLeafSchema.parse(leaf);
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const path = join(sessionDir(ref.projectDir, ref.sessionId), leaf);
  assertPathConfined(relative(ref.projectDir, path), ref.projectDir);
  assertSessionConfinement(path, sessionDir(ref.projectDir, ref.sessionId));
  return path;
}

export async function workspaceDirectoryIdentity(
  path: string,
): Promise<RetainedWorkspace['directory'] | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

export async function readWorkspaceRecord(ref: SessionRef): Promise<RetainedWorkspace | null> {
  const path = join(ref.projectDir, recordPath(ref));
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES)
      throw retentionError.unavailable();
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length > MAX_RECORD_BYTES) throw retentionError.unavailable();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw retentionError.unavailable();
  }
  if (value === null) return null;
  const parsed = RetainedWorkspaceSchema.safeParse(value);
  if (!parsed.success) throw retentionError.unavailable();
  const record = parsed.data;
  if (record.projectDir !== (await realpath(ref.projectDir)) || record.sessionId !== ref.sessionId)
    throw retentionError.unavailable();
  for (const file of new Set([
    ...record.snapshot.files,
    ...Object.keys(record.snapshot.dirtyFileContents),
    ...Object.keys(record.snapshot.dirtyFileEntries ?? {}),
    ...Object.keys(record.snapshot.baselineFileHashes ?? {}),
    ...Object.keys(record.targetFiles),
  ]))
    assertPathConfined(file, ref.projectDir);
  if (
    record.snapshot.ignoreProjectDir !== undefined &&
    (await realpath(record.snapshot.ignoreProjectDir)) !== (await realpath(ref.projectDir))
  )
    throw retentionError.unavailable();
  return record;
}

export async function retainedDirectoryMatches(
  record: Pick<RetainedWorkspace, 'directory'>,
  dir: string,
): Promise<boolean> {
  const identity = await workspaceDirectoryIdentity(dir);
  return identity !== null && canonicalJSON(identity) === canonicalJSON(record.directory);
}

async function writeRetainedWorkspace(ref: SessionRef, record: RetainedWorkspace): Promise<void> {
  const content = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(content) > MAX_RECORD_BYTES) {
    throw error('isolation-retention-size', 'The workspace continuation record exceeds 8 MiB.');
  }
  await writeConfinedSecureFileAsync(ref.projectDir, recordPath(ref), content);
}

export async function retainWorkspaceRecord(
  ref: SessionRef,
  input: {
    workspace: IsolatedWorkspace;
    owner: WorkspaceOwner;
    location: RetainedWorkspace['location'];
    retained?: boolean | undefined;
  },
): Promise<void> {
  const { workspace, owner, location, retained = true } = input;
  const directory = await workspaceDirectoryIdentity(workspace.projectDir);
  if (directory === null || workspace.targetBaseline === undefined)
    throw retentionError.unavailable();
  for (const file of workspace.targetBaseline.keys())
    assertPathConfined(file, workspace.projectDir);
  // Staged copies never restore individual files; they need no rollback bytes.
  // Worktrees retain only their original dirty entries, never clean repository files.
  const snapshot =
    workspace.snapshot.baselineFileHashes === undefined
      ? workspace.snapshot
      : {
          head: workspace.snapshot.head,
          files: [],
          dirtyFileContents: {},
          baselineFileHashes: workspace.snapshot.baselineFileHashes,
          ...(workspace.snapshot.ignoreProjectDir !== undefined && {
            ignoreProjectDir: workspace.snapshot.ignoreProjectDir,
          }),
        };
  await writeRetainedWorkspace(ref, {
    version: 1,
    retained,
    projectDir: await realpath(ref.projectDir),
    sessionId: ref.sessionId,
    owner,
    location,
    directory,
    snapshot,
    targetFiles: Object.fromEntries(workspace.targetBaseline),
  });
}

export function retainedStagedDirectory(ref: SessionRef, record: RetainedWorkspace): string | null {
  return record.location.kind === 'staged-copy'
    ? join(stagedWorkspaceRoot(ref, record.location.leaf), 'workspace')
    : null;
}

export function retainedWorkspaceNotice(
  dir: string,
  purpose?: 'continuation' | 'manual-removal',
): string {
  if (purpose === 'continuation')
    return `Workspace kept at ${dir} for Continue, with its private CLI state and caches.`;
  if (purpose === 'manual-removal')
    return `Workspace kept at ${dir} for manual removal. Its private CLI state and caches remain; Continue will not reuse it.`;
  return `Isolation workspace retained at ${dir}; unpromoted work remains`;
}
