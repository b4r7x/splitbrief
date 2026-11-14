import { judgeFixCheck, fixCheckCounts } from '../../../../core/review/fix/checks.js';
import type { FixCheckKeys } from '../../../../core/review/fix/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { throwIfAborted } from '../../../../utils/abort.js';
import type { EventBus } from '../../../events/types.js';
import { publishReviewCheck } from '../../publish/review.js';
import type { RunBase } from '../../isolation/run-base/tree.js';
import { type BaseGate, type BaseSplit, splitFailureAtBase } from '../../validation/base-gate.js';
import type { FailureKeys } from '../../validation/extract-failure-keys.js';
import { newFailureKeys } from '../../validation/failure-text.js';
import { runChecks } from '../../validation/checks/runner.js';
import type { RunChecksOptions, CheckRunResult } from '../../validation/checks/types.js';

function noRunBase(
  notices: { bus: EventBus; phase: WorkflowState['phase'] },
  chosen: { id: string; command: string },
): { preExisting: string[]; unavailable: string } {
  const detail = 'this run recorded no run base';
  publishReviewCheck(notices, {
    status: 'not-run',
    id: chosen.id,
    command: chosen.command,
    moment: 'base',
    detail,
  });
  return { preExisting: [], unavailable: `not run: ${detail}` };
}

/**
 * The failures of a red reviewer check split by the project gate's run at the run base, which ran
 * beside the build (`splitFailureAtBase`): this waits for that run, marks the check's running row
 * as waiting on it (`waitsOnBase`), and never runs the command itself.
 */
async function splitAtRunBase(input: {
  id: string;
  command: string;
  failure: FailureKeys;
  gate: BaseGate | undefined;
  base: RunBase | undefined;
  notices: { bus: EventBus; phase: WorkflowState['phase'] };
}): Promise<BaseSplit> {
  if (input.gate === undefined || input.base === undefined) {
    return noRunBase(input.notices, { id: input.id, command: input.command });
  }
  publishReviewCheck(input.notices, {
    status: 'running',
    id: input.id,
    command: input.command,
    moment: 'pre-review',
    waitsOnBase: true,
  });
  return splitFailureAtBase({
    failure: input.failure,
    atBase: await input.gate.outcome(input.id),
    base: input.base,
  });
}

/**
 * Runs a reviewer check once. A pre-review red splits at the run base before its row settles, so
 * the row carries the split; while the review waits on the run base its row stays running.
 */
export async function runReviewCheck(
  input: {
    check: { id: string; command: string };
    checkOptions: RunChecksOptions;
  } & (
    | { moment: 'pre-review'; baseGate: BaseGate | undefined }
    | { moment: 'brief'; carried: FixCheckKeys | undefined }
  ),
): Promise<{
  run: CheckRunResult;
  fresh: string[];
  unavailable?: string | undefined;
  notVerified?: string | undefined;
}> {
  const { moment, checkOptions } = input;
  const { id, command } = input.check;
  const notices = { bus: checkOptions.bus, phase: checkOptions.phase };
  const startedAt = Date.now();
  const [result] = await runChecks([id], checkOptions, (_check, prepared) =>
    publishReviewCheck(notices, { status: 'running', id, command: prepared, moment }),
  );
  const run: CheckRunResult = result ?? {
    checkId: id,
    status: 'unknown',
    output: `no result for ${id}`,
  };
  if (run.status !== 'pass' && run.status !== 'fail') {
    publishReviewCheck(notices, {
      status: run.status === 'refused' ? 'refused' : 'not-run',
      id,
      command,
      moment,
      detail: run.output,
    });
    return { run, fresh: [] };
  }
  const clock =
    run.reusedAt === undefined ? { duration: Date.now() - startedAt } : { reusedAt: run.reusedAt };
  const judged =
    input.moment === 'brief'
      ? judgeFixCheck(input.carried, run.status === 'fail' ? run.failure : null)
      : null;
  const split =
    input.moment === 'pre-review' && run.status === 'fail'
      ? await splitAtRunBase({
          id,
          command: run.command ?? command,
          failure: run.failure,
          gate: input.baseGate,
          base: checkOptions.base,
          notices,
        })
      : null;
  throwIfAborted(checkOptions.signal);
  publishReviewCheck(notices, {
    status: 'done',
    id,
    command: run.command ?? command,
    moment,
    passed: run.status === 'pass' || judged?.left.length === 0,
    ...(run.timedOut !== undefined && { timedOut: run.timedOut }),
    ...clock,
    ...(judged !== null && fixCheckCounts(judged)),
    ...split?.counts,
  });
  if (run.status !== 'fail') return { run, fresh: [] };
  if (split === null) return { run, fresh: judged === null ? run.failure.keys : judged.left };
  const { preExisting, base, unavailable, notVerified } = split;
  const splitRun: CheckRunResult = {
    ...run,
    ...(preExisting.length > 0 && { preExisting }),
    ...(base !== undefined && {
      base: {
        output: base.output,
        ...(base.exitCode !== undefined && { exitCode: base.exitCode }),
      },
    }),
  };
  return { run: splitRun, fresh: newFailureKeys(splitRun), unavailable, notVerified };
}
