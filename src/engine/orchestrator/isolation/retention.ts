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
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../core/sessions/workspace-notice.js';
import {
  assertSessionConfinement,
  assertSessionDirConfined,
} from '../../../core/sessions/confinement.js';
import { writeConfinedSecureFileAsync, writeSecureFile } from '../../../lib/fs.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { error, matches } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { workflowCancelledReasonFromSignal } from '../../events/workflow-cancel.js';
import type { EventBus } from '../../events/types.js';
import { publishError, publishWarning } from '../events.js';
import type { IsolatedWorkspace } from './types.js';

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
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
  return signal?.aborted === true && workflowCancelledReasonFromSignal(signal) === undefined;
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
  // Staged rollback bytes stay in the session's entry store; the record carries hashes and modes.
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

export async function publishRetainedWorkspaceNotice(
  input: SessionRef & { state: WorkflowState; bus: EventBus },
): Promise<boolean> {
  const { state, bus } = input;
  if (deriveRunStatus({ state, liveness: 'not-alive' }).kind !== 'open') return false;
  const workspace = state.workspace;
  if (workspace === undefined || workspace.kind === 'checkout') return false;
  try {
    const record = await readWorkspaceRecord(input);
    if (record?.retained !== true || !(await retainedDirectoryMatches(record, workspace.path)))
      return false;
  } catch (err) {
    publishError({ bus, phase: state.phase, message: toErrorMessage(err) });
    return false;
  }
  publishWarning({
    bus,
    phase: state.phase,
    message: retainedWorkspaceNotice(workspace.path),
    safety: { category: WORKSPACE_NOTICE_CATEGORY, code: WORKSPACE_KEPT_CODE },
  });
  return true;
}
