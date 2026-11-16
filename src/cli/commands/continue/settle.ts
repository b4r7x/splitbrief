import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import { acceptedCounts, acceptedSentence } from '../../../core/review/accepted.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { RunStatus } from '../../../core/sessions/run/status.js';
import { runApplyAtRest } from '../../../engine/orchestrator/apply/at-rest.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { closedChangesSuffix, closeRunIfOpen } from '../../../engine/orchestrator/run/close.js';
import { finalizeRunAtRest } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { countNoun } from '../../../utils/pluralize.js';
import { assertNever } from '../../../utils/type-guards.js';
import { resolveRunConfig } from '../../build-overrides.js';
import { cliError } from '../../errors.js';
import { withHeadlessStop, writeRunStopped } from '../../headless/stop.js';
import { ensureHooksTrusted } from '../../hook-trust-prompt.js';
import {
  emitReadyToApply,
  emitRecoveryAndFailIfPending,
  recordWriterFor,
} from '../../headless/outcome.js';
import { applyCommand } from '../../sessions/resolve.js';
import type { ContinueOpts, Resumed } from './types.js';

export async function settleRequestedApply(args: {
  sessionId: string;
  state: WorkflowState;
  status: RunStatus;
  action: 'apply' | 'apply-as-is' | 'discard';
  opts: ContinueOpts;
}): Promise<Resumed | undefined> {
  const { sessionId, state, action, opts } = args;
  if (args.status.kind !== 'ready-to-apply') {
    throw cliError(
      `Run ${sessionId} is not ready to apply; --action ${action} settles a run ${action === 'apply-as-is' ? 'that was accepted as is' : 'whose review passed'} in its workspace.`,
      1,
    );
  }
  const settled = { projectDir: opts.projectDir, sessionId, state, json: opts.json === true };
  if (action === 'discard') {
    await settleReadyRun({ ...settled, action: 'discard' });
    return undefined;
  }
  // `apply-as-is` is the confirmation of a run accepted as is, so each word applies only its own
  // run: the other word is refused here, before Apply is asked.
  const accepted = state.acceptedAsIs;
  if (action === 'apply' && accepted !== undefined) {
    throw cliError(
      `Run ${sessionId} was accepted as is with ${acceptedCounts(accepted).phrase}; apply it as is with: ${applyCommand(sessionId, state)}`,
      1,
    );
  }
  if (action === 'apply-as-is' && accepted === undefined) {
    throw cliError(
      `Run ${sessionId} was not accepted as is; apply it with: ${applyCommand(sessionId, state)}`,
      1,
    );
  }
  const { config } = resolveRunConfig({ projectDir: opts.projectDir, opts });
  // Apply can send the merged result back to its checks and review, which run the hooks; their
  // trust is asked before Apply writes, so a refused command leaves the run ready to apply.
  await ensureHooksTrusted({
    projectDir: opts.projectDir,
    hooks: config.hooks,
    allowHooks: opts.allowHooks ?? false,
  });
  if (accepted !== undefined) process.stderr.write(`${acceptedSentence(accepted)}\n`);
  const next = await settleReadyRun({
    ...settled,
    action,
    reviewNone: resolveReviewCadence(config) === 'none',
  });
  if (next === undefined) return undefined;
  return { state: next, config };
}

export async function settleReadyRun(
  input: {
    projectDir: string;
    sessionId: string;
    state: WorkflowState;
    json: boolean;
  } & ({ action: 'discard' } | { action: 'apply' | 'apply-as-is'; reviewNone: boolean }),
): Promise<WorkflowState | undefined> {
  const { projectDir, sessionId, state, json } = input;
  const ref = { projectDir, sessionId };
  const bus = createRecoveryBus({
    projectDir,
    sessionId,
    sink: (event) => {
      if (event.type === 'warning') process.stderr.write(`${event.message}\n`);
    },
  });
  const finalize = (state: WorkflowState): void => {
    finalizeRunAtRest({ ref, state });
  };

  if (input.action === 'discard') {
    const closure = await closeRunIfOpen({ projectDir, sessionId, bus }, state, 'discarded');
    if (closure.closedNow) finalize(closure.state);
    process.stderr.write(`Run ${sessionId} discarded.${closedChangesSuffix(ref, closure.state)}\n`);
    return undefined;
  }

  // Apply has no stop: a signal lets it finish and write its exit record, then the process exits.
  const { stopped, value: result } = await withHeadlessStop(() =>
    runApplyAtRest({
      wctx: { projectDir, sessionId, bus },
      state,
      reviewNone: input.reviewNone,
      overrideConfirmed: input.action === 'apply-as-is',
    }),
  );
  switch (result.outcome) {
    case 'applied':
      process.stderr.write(`Applied ${countNoun(result.files.length, 'file')} to your checkout.\n`);
      return undefined;
    case 'restored':
      process.stderr.write(
        `Restored ${countNoun(result.files.length, 'file')} in your checkout.\n`,
      );
      emitReadyToApply(result.state, sessionId, recordWriterFor(!json));
      return undefined;
    case 'review':
      process.stderr.write(
        `Your checkout changed files run ${sessionId} changed too; the merged result goes through its checks${input.reviewNone ? '' : ' and review'} again.\n`,
      );
      if (stopped) {
        writeRunStopped(sessionId);
        return undefined;
      }
      return result.state;
    // `settleRequestedApply` refuses the plain word on a run accepted as is before Apply is asked, and
    // `apply-as-is` is the confirmation, so Apply does not come back to ask for one.
    case 'needs-confirmation':
    case 'halted':
      emitRecoveryAndFailIfPending({
        state: result.state,
        sessionId,
        reviewNone: input.reviewNone,
        writeRecord: recordWriterFor(!json),
      });
      throw cliError(`Apply of run ${sessionId} stopped.`, 1);
    default:
      return assertNever(result);
  }
}
