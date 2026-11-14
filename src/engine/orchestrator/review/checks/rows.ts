import type { Phase } from '../../../../core/schemas/enums.js';
import type { Check } from '../../../../core/schemas/task.js';
import type { EventBus } from '../../../events/types.js';
import { planCheckRow, publishReviewCheck, unranCheckRow } from '../../publish/review.js';
import type { RunBase } from '../../isolation/run-base/tree.js';
import { type BaseGate, splitCommandAtBase } from '../../validation/base-gate.js';
import type { createCheckRunner } from '../../validation/checks/runner.js';
import type { CheckRunResult } from '../../validation/checks/types.js';

/** Runs one check between its running row and the row it settles on, with its clock. */
export async function runCheckWithRows(input: {
  check: Check;
  prepare: ReturnType<typeof createCheckRunner>;
  notices: { bus: EventBus; phase: Phase };
  moment: 'plan' | 'verify';
  /** The failures this review saw red at the run base: a red keeps them as pre-existing. */
  atBase?: readonly string[] | undefined;
  /** A red splits by the gate command that runs the same command text at the run base. */
  baseGate?: BaseGate | undefined;
  base?: RunBase | undefined;
}): Promise<CheckRunResult> {
  const { check, notices } = input;
  const prepared = input.prepare(check);
  const identity = { ...planCheckRow(check.id, prepared.command, check), moment: input.moment };
  const startedAt = Date.now();
  publishReviewCheck(notices, { ...identity, status: 'running' });
  const run = await prepared.run();
  // A red that ran no command, such as a missing test file or npm script, names why on its row.
  const unranRed = run.status === 'fail' && run.command === undefined;
  const failures =
    run.status === 'fail' && run.failure.placeholder === undefined ? run.failure.keys : [];
  const split =
    run.status === 'fail' && run.command !== undefined
      ? await splitCommandAtBase({
          gate: input.baseGate,
          command: run.command,
          failure: run.failure,
          base: input.base,
          wait: { notices: input.notices, row: { ...identity, command: run.command } },
        })
      : undefined;
  const preExisting = split?.preExisting ?? failures.filter((key) => input.atBase?.includes(key));
  publishReviewCheck(notices, {
    ...identity,
    command: unranRed ? '' : (run.command ?? prepared.command),
    ...(run.status === 'pass' || run.status === 'fail'
      ? {
          status: 'done',
          passed: run.status === 'pass',
          ...(run.timedOut !== undefined && { timedOut: run.timedOut }),
          ...(run.reusedAt === undefined
            ? { duration: Date.now() - startedAt }
            : { reusedAt: run.reusedAt }),
          ...(unranRed && { detail: run.output }),
          ...(split === undefined
            ? preExisting.length > 0 && {
                newFailures: failures.length - preExisting.length,
                preExisting: preExisting.length,
              }
            : split.counts),
        }
      : unranCheckRow(run)),
  });
  return preExisting.length > 0 ? { ...run, preExisting } : run;
}
