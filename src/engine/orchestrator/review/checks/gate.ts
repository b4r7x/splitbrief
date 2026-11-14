import type { ReviewScope } from '../../../../core/review/scope.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { nowIso } from '../../../../utils/format/time.js';
import { publishError } from '../../publish/notice.js';
import {
  type UnrunnableCheck,
  buildRequiredChecksUnrunnableRecoveryIssue,
} from '../../recovery/builders/checks.js';
import { raisePendingRecovery } from '../../state-ops/halts.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import type { WorkflowContext } from '../../types.js';
import { planApprovesNpmScripts } from '../../validation/checks/runner.js';
import { runPreReviewChecks } from './required.js';

export type PreReviewResult = Readonly<{
  state: WorkflowState;
  kind: 'review' | 'stopped';
}>;

export function haltRequiredChecksUnrunnable(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  checks: readonly UnrunnableCheck[];
  setTrackedState: (s: WorkflowState) => void;
}): WorkflowState {
  const { wctx, state, checks, setTrackedState } = args;
  const issue = buildRequiredChecksUnrunnableRecoveryIssue({
    phase: state.phase,
    checks,
    createdAt: nowIso(),
  });
  publishError({
    bus: wctx.bus,
    phase: state.phase,
    message: issue.message,
    safety: { category: 'recovery', code: 'required_checks_unrunnable' },
  });
  return raisePendingRecovery(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId, bus: wctx.bus },
    state,
    issue,
    setTrackedState,
  );
}

export async function runPreReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  scope?: ReviewScope['kind'] | undefined;
}): Promise<PreReviewResult> {
  const { wctx, setTrackedState } = args;
  let state = args.state;
  const checks = await runPreReviewChecks({
    state,
    workspaceDir: wctx.workspaceDir,
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    config: wctx.config,
    bus: wctx.bus,
    phase: state.phase,
    npmScriptsApproved: planApprovesNpmScripts({ config: wctx.config, state }),
    scope: args.scope,
    baseGate: wctx.baseGate,
    ...(wctx.signal !== undefined && { signal: wctx.signal }),
  });
  state = checks.state;
  setTrackedState(state);

  if (checks.unrunnable.length > 0) {
    state = haltRequiredChecksUnrunnable({
      wctx,
      state,
      checks: checks.unrunnable,
      setTrackedState,
    });
    return { state, kind: 'stopped' };
  }

  const inputs = checks.defects;
  if (inputs.length > 0) {
    state = transitionAndSave(wctx, state, { type: 'QUEUE_TRIAGE', inputs });
    setTrackedState(state);
  }
  return { state, kind: 'review' };
}
