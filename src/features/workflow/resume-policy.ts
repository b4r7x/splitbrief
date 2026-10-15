import type { PreparationPolicy } from '../../engine/runners/prepare-execution/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';

/**
 * The terms this run is admitted under again whenever it is re-prepared — a run started here
 * re-entering its own session, or a halt's seat swap bringing in another tool. A preparation the
 * TUI drives is always interactive, discloses unverified auth and approves through the
 * tiered-approval prompt; hooks and repo runners stay as the run was first admitted.
 */
export function runResumePolicy(
  prepared: PreparedExecution,
): Extract<PreparationPolicy, { purpose: 'resume' }> {
  return {
    purpose: 'resume',
    interaction: 'interactive',
    unverifiedAuth: 'disclosed',
    allowHooks: prepared.runtime.allowHooks,
    allowRepoRunners: prepared.runtime.allowRepoRunners,
    onTieredApproval: openApprovalPrompt,
    modelCache: modelCacheStore,
  };
}
