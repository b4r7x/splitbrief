import type { SessionRef } from '../../core/types/session-ref.js';
import type { PreparationPolicy } from '../../engine/runners/prepare-execution/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';

type RunTerms = Pick<PreparedExecution['runtime'], 'allowHooks' | 'allowRepoRunners'>;

const NO_GRANT: RunTerms = { allowHooks: false, allowRepoRunners: false };

/** The terms each run this process drove was admitted under; never persisted. */
const admittedRuns = new Map<string, RunTerms>();

function runKey(ref: SessionRef): string {
  return `${ref.projectDir}\0${ref.sessionId}`;
}

/**
 * The terms this run is admitted under again whenever it is re-prepared — a run started here
 * re-entering its own session, or a halt's seat swap bringing in another tool. A preparation the
 * TUI drives is always interactive, discloses unverified auth and approves through the
 * tiered-approval prompt; hooks and repo runners stay as the run was first admitted.
 */
export function runResumePolicy(
  terms: RunTerms,
): Extract<PreparationPolicy, { purpose: 'resume' }> {
  return {
    purpose: 'resume',
    interaction: 'interactive',
    unverifiedAuth: 'disclosed',
    allowHooks: terms.allowHooks,
    allowRepoRunners: terms.allowRepoRunners,
    onTieredApproval: openApprovalPrompt,
    modelCache: modelCacheStore,
  };
}

/** Keeps the terms of a run this process drives, so continuing it after a stop keeps them. */
export function recordRunTerms(prepared: PreparedExecution): void {
  admittedRuns.set(runKey(prepared.session.ref), {
    allowHooks: prepared.runtime.allowHooks,
    allowRepoRunners: prepared.runtime.allowRepoRunners,
  });
}

/**
 * A run continued at rest keeps the terms this process admitted it under. A run this process never
 * drove, such as one another process started, gets no grant.
 */
export function atRestResumePolicy(
  ref: SessionRef,
): Extract<PreparationPolicy, { purpose: 'resume' }> {
  return runResumePolicy(admittedRuns.get(runKey(ref)) ?? NO_GRANT);
}
