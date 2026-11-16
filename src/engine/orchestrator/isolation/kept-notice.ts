import type { SessionRef } from '../../../core/types/session-ref.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { sessionFileFailure } from '../../../core/sessions/errors.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../core/sessions/workspace-notice.js';
import { createLogger } from '../../../lib/logger.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import type { EventBus } from '../../events/types.js';
import { publishError, publishWarning } from '../publish/notice.js';
import {
  readWorkspaceRecord,
  recordPath,
  retainedDirectoryMatches,
  retentionError,
} from './retention.js';

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
