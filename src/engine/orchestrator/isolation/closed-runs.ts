import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { listSessionIds, sessionsRootLabel } from '../../../core/sessions/orphans.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { warnError, warnStderr } from '../../../lib/warn.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import type { EventBus } from '../../events/types.js';
import { publishWarning } from '../publish/notice.js';
import { publishInfo } from '../publish/notice.js';
import { readWorkflowStateHead } from '../state-ops/head.js';
import { foreignWorkspaceNotice, readWorkspaceRecordFile } from './retention.js';
import { removeRunWorkspace } from './worktree/remove.js';

export async function removeClosedRunWorkspace(
  scope: SessionRef & { bus?: EventBus | undefined },
  workspace: NonNullable<WorkflowState['workspace']>,
  phase: WorkflowState['phase'],
): Promise<void> {
  try {
    const foreign = await removeRunWorkspace(scope.projectDir, scope.sessionId, workspace);
    if (foreign !== null && scope.bus !== undefined) {
      publishInfo({ bus: scope.bus, phase, message: foreignWorkspaceNotice(foreign) });
    }
  } catch (err) {
    if (scope.bus !== undefined) {
      publishWarning({
        bus: scope.bus,
        phase,
        message: `Could not remove the run workspace at ${workspace.path}: ${toErrorMessage(err)}`,
      });
    }
  }
  scope.bus?.publish({ type: 'workspace_closed', ts: Date.now(), phase });
}

export async function removeClosedRunWorkspaces(projectDir: string): Promise<void> {
  let sessionIds: string[];
  try {
    sessionIds = listSessionIds(projectDir);
  } catch (err) {
    warnError(
      `Could not list ${sessionsRootLabel(projectDir)}, so leftover workspaces from closed runs may remain`,
      err,
    );
    return;
  }
  for (const sessionId of sessionIds) {
    const ref = { projectDir, sessionId };
    let workspacePath: string | undefined;
    try {
      const head = readWorkflowStateHead(ref);
      if (head === null) continue;
      const { state } = head;
      const status = deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false });
      if (status.kind !== 'closed') continue;
      const workspace = state.workspace;
      if (
        workspace === undefined ||
        (workspace.kind !== 'worktree' && workspace.kind !== 'staged-copy')
      ) {
        continue;
      }
      workspacePath = workspace.path;
      if ((await readWorkspaceRecordFile(ref)) === null) continue;
      const foreign = await removeRunWorkspace(projectDir, sessionId, workspace);
      if (foreign !== null) warnStderr(foreignWorkspaceNotice(foreign), 'at-exit');
    } catch (err) {
      if (workspacePath !== undefined) {
        warnError(`Could not remove the run workspace at ${workspacePath}`, err);
      }
    }
  }
}
