import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { runApplyAtRest } from '../../../engine/orchestrator/apply/at-rest.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { closedChangesSuffix, closeRunIfOpen } from '../../../engine/orchestrator/run/close.js';
import { finalizeRunAtRest } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { countNoun } from '../../../utils/pluralize.js';
import { assertNever } from '../../../utils/type-guards.js';
import { cliError } from '../../errors.js';
import { emitRecoveryAndFailIfPending, recordWriterFor } from '../../headless.js';

export async function settleReadyRun(input: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  action: 'apply' | 'discard';
  json: boolean;
}): Promise<WorkflowState | undefined> {
  const { projectDir, sessionId, state, action, json } = input;
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

  if (action === 'discard') {
    const closure = await closeRunIfOpen({ projectDir, sessionId, bus }, state, 'discarded');
    if (closure.closedNow) finalize(closure.state);
    process.stderr.write(`Run ${sessionId} discarded.${closedChangesSuffix(ref, closure.state)}\n`);
    return undefined;
  }

  const result = await runApplyAtRest({ wctx: { projectDir, sessionId, bus }, state });
  switch (result.outcome) {
    case 'applied':
      process.stderr.write(`Applied ${countNoun(result.files.length, 'file')} to your checkout.\n`);
      return undefined;
    case 'review':
      process.stderr.write(
        `Your checkout changed files run ${sessionId} changed too; the merged result goes through its checks and review again.\n`,
      );
      return result.state;
    case 'needs-confirmation':
      throw cliError(
        `Run ${sessionId} was accepted as is; confirm Apply on the run screen with /run accept confirm.`,
        1,
      );
    case 'halted':
      emitRecoveryAndFailIfPending({
        state: result.state,
        sessionId,
        writeRecord: recordWriterFor(!json),
      });
      throw cliError(`Apply of run ${sessionId} stopped.`, 1);
    default:
      return assertNever(result);
  }
}
