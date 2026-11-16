import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { sessionDir } from '../../../core/paths.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  RetainedWorkspaceSchema,
  StagedWorkspaceLeafSchema,
  type RetainedWorkspace,
  type WorkspaceOwner,
} from '../../../core/schemas/retained-workspace.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { sessionError, sessionFileFailure } from '../../../core/sessions/errors.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../core/sessions/workspace-notice.js';
import {
  assertSessionConfinement,
  assertSessionDirConfined,
} from '../../../core/sessions/confinement.js';
import { writeConfinedSecureFileAsync, writeSecureFile } from '../../../lib/fs/secure.js';
import { createLogger } from '../../../lib/logger.js';
import { assertPathConfined } from '../../../lib/fs/confinement.js';
import { isENOENT } from '../../../utils/errno.js';
import { isAbortError } from '../../../utils/abort.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { error, matches } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { workflowCancelledReasonFromSignal } from '../../events/workflow-cancel.js';
import type { EventBus } from '../../events/types.js';
import { publishWarning } from '../publish/notice.js';
import { publishError } from '../publish/notice.js';
import type { IsolatedWorkspace, RunIsolationState } from './types.js';

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const retentionError = {
  unavailable: () =>
    error(
      'isolation-retention-unavailable',
      'The stopped workspace could not be verified. Its files were left in place; automatic continuation is blocked.',
    ),
  moved: (dir: string) =>
    error(
      'isolation-project-moved',
      `This run started in ${dir}. Move the project back to that folder to continue the run, or end the run.`,
      { dir },
    ),
  failed: (dir: string, cause: unknown) =>
    error(
      'isolation-retention-failed',
      `Files remain at ${dir}, but their continuation record could not be saved. Automatic continuation is unavailable.`,
      undefined,
      cause,
    ),
  isFailed: matches('isolation-retention-failed'),
  isMoved: matches('isolation-project-moved'),
  isUnavailable: matches('isolation-retention-unavailable'),
};

export function isResumableWorkspaceStop(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && workflowCancelledReasonFromSignal(signal) === undefined;
}

/**
 * Settles the workspace of a BUILD call that threw. A stop takes the call's files back, and a stop
 * the run can resume keeps them for it. A failed save of the run takes them back too, because the
 * run stops with no consult. A call that failed keeps them for the consult.
 */
export async function settleThrownCall(
  workspace: IsolatedWorkspace,
  signal: AbortSignal | undefined,
  err: unknown,
): Promise<void> {
  if (isAbortError(err) && isResumableWorkspaceStop(signal)) await workspace.retain?.();
  else if (
    isAbortError(err) ||
    sessionError.isLocalSaveFailure(err) ||
    (signal?.aborted && !retentionError.isFailed(err))
  )
    workspace.cleanup();
}

export function workspaceOwner(input: { sessionId: string; config: Config }): WorkspaceOwner {
  return {
    runId: input.sessionId,
    buildSeat: sha256Hex(canonicalJSON(input.config.implementer)),
  };
}

function recordPath(ref: SessionRef): string {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const root = sessionDir(ref.projectDir, ref.sessionId);
  const path = join(root, 'retained-workspace.json');
  assertSessionConfinement(path, root);
  return relative(ref.projectDir, path);
}

export function clearWorkspaceRecord(ref: SessionRef): void {
  writeSecureFile(join(ref.projectDir, recordPath(ref)), 'null\n');
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

export async function readWorkspaceRecordFile(ref: SessionRef): Promise<RetainedWorkspace | null> {
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
  return parsed.data;
}

export async function readWorkspaceRecord(ref: SessionRef): Promise<RetainedWorkspace | null> {
  const record = await readWorkspaceRecordFile(ref);
  if (record === null) return null;
  if (record.sessionId !== ref.sessionId) throw retentionError.unavailable();
  if (record.projectDir !== (await realpath(ref.projectDir)))
    throw retentionError.moved(record.projectDir);
  for (const file of new Set([
    ...record.snapshot.files,
    ...Object.keys(record.snapshot.dirtyFileContents),
    ...Object.keys(record.snapshot.dirtyFileEntries ?? {}),
    ...Object.keys(record.snapshot.storedDirtyEntries ?? {}),
    ...Object.keys(record.snapshot.baselineFileHashes ?? {}),
    ...Object.keys(record.snapshot.symlinks ?? {}),
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

/**
 * Throws the moved error when the project folder is not the folder that the run started in. The
 * record of a worktree or a staged copy names that folder; a run in the checkout keeps no record,
 * and its workspace is that folder.
 */
export async function assertProjectNotMoved(
  ref: SessionRef,
  workspace: WorkflowState['workspace'],
): Promise<void> {
  if (workspace?.kind !== 'checkout') await readWorkspaceRecord(ref);
  else if (workspace.path !== ref.projectDir) throw retentionError.moved(workspace.path);
}

export async function retainedDirectoryMatches(
  record: Pick<RetainedWorkspace, 'directory'>,
  dir: string,
): Promise<boolean> {
  const identity = await workspaceDirectoryIdentity(dir);
  return identity !== null && canonicalJSON(identity) === canonicalJSON(record.directory);
}

export async function workspaceIdentityMatches(
  state: RunIsolationState,
  dir: string,
): Promise<boolean> {
  const { projectDir, sessionId } = state.opts;
  const { directory, location } = state;
  return (
    directory !== undefined &&
    location !== undefined &&
    (await retainedDirectoryMatches({ directory }, dir)) &&
    (location.kind !== 'staged-copy' ||
      (await retainedDirectoryMatches(
        { directory: location.rootDirectory },
        stagedWorkspaceRoot({ projectDir, sessionId }, location.leaf),
      )))
  );
}

async function writeRetainedWorkspace(ref: SessionRef, record: RetainedWorkspace): Promise<void> {
  const content = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(content) > MAX_RECORD_BYTES) {
    throw error('isolation-retention-size', 'The workspace continuation record exceeds 8 MiB.');
  }
  await writeConfinedSecureFileAsync(ref.projectDir, recordPath(ref), content);
}

/** Ends the keep of a stopped attempt whose brief gave its files back. */
export async function releaseRetainedWorkspace(ref: SessionRef): Promise<void> {
  const record = await readWorkspaceRecordFile(ref);
  if (record?.retained === true) await writeRetainedWorkspace(ref, { ...record, retained: false });
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
  // A workspace snapshot keeps its rollback bytes in the session's entry store and carries hashes
  // and modes; a staged copy's record also drops its list of every entry.
  const snapshot =
    workspace.snapshot.baselineFileHashes === undefined
      ? workspace.snapshot
      : {
          head: workspace.snapshot.head,
          files: [],
          dirtyFileContents: {},
          ...(workspace.snapshot.restoreFiles !== undefined && {
            restoreFiles: workspace.snapshot.restoreFiles,
          }),
          baselineFileHashes: workspace.snapshot.baselineFileHashes,
          ...(workspace.snapshot.baselineFileModes !== undefined && {
            baselineFileModes: workspace.snapshot.baselineFileModes,
          }),
          symlinks: workspace.snapshot.symlinks,
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

export function retainedWorkspaceNotice(dir: string): string {
  return `Workspace kept at ${dir} for Continue, with its private CLI state and caches.`;
}

export function foreignWorkspaceNotice(path: string): string {
  return `The run workspace at ${path} belongs to another project folder and stays on disk. Delete that run workspace when you no longer need it.`;
}

export async function publishRetainedWorkspaceNotice(
  input: SessionRef & { state: WorkflowState; bus: EventBus },
): Promise<boolean> {
  const { state, bus } = input;
  const status = deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false });
  if (status.kind !== 'open') return false;
  const workspace = state.workspace;
  if (workspace === undefined || workspace.kind === 'checkout') return false;
  try {
    const record = await readWorkspaceRecord(input);
    if (record?.retained !== true || !(await retainedDirectoryMatches(record, workspace.path)))
      return false;
  } catch (err) {
    if (retentionError.isMoved(err)) return false;
    const message = retentionError.isUnavailable(err)
      ? toErrorMessage(err)
      : sessionFileFailure('Could not read the kept workspace record', recordPath(input), err);
    publishError({ bus, phase: state.phase, message });
    return false;
  }
  const message = retainedWorkspaceNotice(workspace.path);
  // A paused run, which a stop the user asked for or a watchdog park leaves, keeps the workspace
  // for Continue, so only the debug log names it.
  if (status.stop.kind === 'stopped' && status.stop.on.kind === 'paused') {
    createLogger('engine').debug(WORKSPACE_KEPT_CODE, { message });
    return true;
  }
  publishWarning({
    bus,
    phase: state.phase,
    message,
    safety: { category: WORKSPACE_NOTICE_CATEGORY, code: WORKSPACE_KEPT_CODE },
  });
  return true;
}
