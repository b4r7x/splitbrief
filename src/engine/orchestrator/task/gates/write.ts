import { gateChangedFiles } from '../../approval/gate-files.js';
import { persistApprovalEvidence } from '../../evidence/decisions.js';
import { resolveDependsOnFiles } from '../resolve-deps.js';
import type { ImplementerLoopInput, ImplementerLoopState } from '../types.js';

export async function approveWrite(
  input: ImplementerLoopInput,
  shared: ImplementerLoopState,
  file: string,
): Promise<{ allow: boolean; reason?: string | undefined }> {
  const { wctx, task } = input;
  const { projectDir, sessionId, callbacks, config } = wctx;
  const decision = await gateChangedFiles({
    changedFiles: [file],
    task,
    dependsOnFiles: resolveDependsOnFiles(shared.state.tasks, task),
    projectDir,
    sessionId,
    phase: shared.state.phase,
    taskId: task.id,
    bus: wctx.bus,
    callbacks,
    config,
  });
  if (decision.cancelled) return { allow: false, reason: decision.reason };
  if (!decision.allow) {
    shared.preApplyApprovalDenied = true;
    const files = decision.changedFiles.join(', ');
    input.recordApprovalDenial(
      decision,
      `Task changed files blocked by approval gate: ${decision.reason ?? 'denied'} (${files})`,
    );
    return { allow: false, reason: decision.reason ?? 'write denied by approval gate' };
  }
  shared.preApplyApprovedFiles.push(...decision.changedFiles);
  persistApprovalEvidence({ wctx, state: shared.state, decision, taskId: task.id });
  return { allow: true };
}
