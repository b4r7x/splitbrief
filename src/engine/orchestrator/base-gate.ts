import type { Phase } from '../../core/schemas/enums.js';
import type { Config } from '../../core/schemas/config.js';
import type { Check } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { redactSecrets } from '../../utils/redact.js';
import type { EventBus } from '../events/types.js';
import { publishReviewCheck, publishWarning } from './events.js';
import {
  runBaseIncomplete,
  runBaseOf,
  withRunBaseTree,
  type RunBase,
} from './isolation/base-tree.js';
import type { FailureKeys } from './validation/extract-failure-keys.js';
import { storedCheckRun, type CheckResultStore } from './validation/result-store.js';
import {
  enabledReviewChecks,
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
} from './validation/run-checks.js';

/** What the run base says about one gate command: its run there, or why it has none. */
export type BaseOutcome =
  | { kind: 'ran'; run: CheckRunResult }
  | { kind: 'unavailable'; reason: string };

type BaseSplitCounts = {
  newFailures: number;
  preExisting: number;
  notVerified?: number | undefined;
  newKeys?: string[] | undefined;
  preExistingKeys?: string[] | undefined;
  detail?: string | undefined;
};

/** How the failures of a red command split against the same command's run at the run base. */
export type BaseSplit = {
  preExisting: string[];
  base?: CheckRunResult | undefined;
  unavailable?: string | undefined;
  notVerified?: string | undefined;
  counts?: BaseSplitCounts | undefined;
};

/** Why two reds whose keys include a placeholder do not show the same failure. */
function notVerifiedReason(workspace: FailureKeys, base: FailureKeys): string {
  if (workspace.placeholder !== undefined && workspace.placeholder === base.placeholder) {
    return `both runs ${workspace.placeholder}`;
  }
  return [
    workspace.placeholder === undefined ? null : `the workspace run ${workspace.placeholder}`,
    base.placeholder === undefined ? null : `the run base re-run ${base.placeholder}`,
  ]
    .filter((side) => side !== null)
    .join(' and ');
}

/**
 * The failures of a red command split by the same command's outcome at the run base. `preExisting`
 * are the keys the run base also shows. A red at the run base proves a pre-existing failure only
 * when both runs name their failures: with a placeholder on either side, or a run base copy with no
 * base commit, nothing is pre-existing, and `notVerified` says why. A base run that could not run
 * leaves every key not verified with its reason; a refused or skipped one leaves every key new, and
 * `unavailable` says why. `counts` is the split the check's row carries.
 */
export function splitFailureAtBase(
  failure: FailureKeys,
  atBase: BaseOutcome,
  base: Pick<RunBase, 'head'>,
): BaseSplit {
  if (atBase.kind === 'unavailable') {
    return {
      preExisting: [],
      notVerified: atBase.reason,
      counts: {
        newFailures: 0,
        preExisting: 0,
        notVerified: failure.keys.length,
        detail: atBase.reason,
      },
    };
  }
  const { run } = atBase;
  if (run.status !== 'pass' && run.status !== 'fail') {
    return {
      preExisting: [],
      base: run,
      unavailable: `${run.status === 'refused' ? 'refused' : 'not run'}: ${run.output}`,
    };
  }
  const baseFailure = run.status === 'fail' ? run.failure : undefined;
  const reason =
    baseFailure === undefined
      ? undefined
      : (runBaseIncomplete(base) ??
        (failure.placeholder !== undefined || baseFailure.placeholder !== undefined
          ? notVerifiedReason(failure, baseFailure)
          : undefined));
  const known = new Set(baseFailure?.keys);
  const keys =
    baseFailure !== undefined && reason === undefined
      ? failure.keys.filter((key) => known.has(key))
      : [];
  return {
    preExisting: keys,
    base: run,
    notVerified: reason,
    counts:
      reason === undefined
        ? {
            newFailures: failure.keys.length - keys.length,
            preExisting: keys.length,
            newKeys: failure.keys.filter((key) => !known.has(key)),
            preExistingKeys: keys,
          }
        : { newFailures: 0, preExisting: 0, notVerified: failure.keys.length, detail: reason },
  };
}

/**
 * The split of a red command's failures by the gate command that runs the same command text at the
 * run base. It waits for that command's outcome there. None when no gate command runs it: such a red
 * stays whole.
 */
export async function splitCommandAtBase(
  gate: BaseGate | undefined,
  command: string,
  failure: FailureKeys,
  base: Pick<RunBase, 'head'> | undefined,
): Promise<BaseSplit | undefined> {
  const atBase = gate?.outcomeForCommand(command);
  if (atBase === undefined || base === undefined) return undefined;
  return splitFailureAtBase(failure, await atBase, base);
}

/** The project gate running at the run base beside the build. */
export type BaseGate = {
  /** Settles once the command of `id` has a result at the run base, or cannot get one. */
  outcome(id: string): Promise<BaseOutcome>;
  /** The outcome of the gate command with this command text; none when no gate command runs it. */
  outcomeForCommand(command: string): Promise<BaseOutcome> | undefined;
  /** Cuts the command still running and waits until its process and base tree are gone. */
  stop(): Promise<void>;
};

/**
 * Starts the project gate the plan names at the run base, one command after the other in one base
 * tree, and stores each result for the review. A command already stored for the run base does not
 * run again, and with every command stored no base tree is made. No gate starts while End-of-run
 * checks are off, when the plan names no gate, or when the run recorded no run base.
 */
export function startBaseGate(opts: {
  ref: SessionRef;
  workspaceDir: string;
  config: Config;
  bus: EventBus;
  state: WorkflowState;
  phase: () => Phase;
  signal?: AbortSignal | undefined;
}): BaseGate | undefined {
  const gate = enabledReviewChecks(opts.config, opts.state.plan);
  const base = runBaseOf(opts.ref, opts.state);
  if (gate.length === 0 || base === undefined) return undefined;
  const cut = new AbortController();
  const signal =
    opts.signal === undefined ? cut.signal : AbortSignal.any([opts.signal, cut.signal]);
  const outcomes = new Map(gate.map((check) => [check.id, Promise.withResolvers<BaseOutcome>()]));
  const notices = () => ({ bus: opts.bus, phase: opts.phase() });
  const store: CheckResultStore = { ref: opts.ref, state: opts.state, tree: 'run-base' };

  const run = async () => {
    const settled = new Set<string>();
    const settle = (id: string, outcome: BaseOutcome) => {
      settled.add(id);
      outcomes.get(id)?.resolve(outcome);
    };
    let current: string | undefined;
    try {
      const pending: Check[] = [];
      for (const check of gate) {
        const stored = await storedCheckRun({
          store,
          workspaceDir: opts.workspaceDir,
          checkId: check.id,
          command: check.value,
        });
        if (stored === undefined) pending.push(check);
        else settle(check.id, { kind: 'ran', run: stored });
      }
      if (pending.length === 0) return;
      const { cleanupError } = await withRunBaseTree(base, opts.workspaceDir, async ({ dir }) => {
        for (const check of pending) {
          current = check.id;
          const startedAt = Date.now();
          publishReviewCheck(notices(), {
            status: 'running',
            id: check.id,
            command: check.value,
            moment: 'base',
          });
          const [result] = await runChecks([check.id], {
            plan: opts.state.plan,
            tasks: opts.state.tasks,
            reviewChecks: gate,
            projectDir: dir,
            sessionId: opts.ref.sessionId,
            config: opts.config,
            bus: opts.bus,
            phase: opts.phase(),
            npmScriptsApproved: planApprovesNpmScripts({ config: opts.config, state: opts.state }),
            discoveredValidation: opts.state.discoveredValidation,
            signal,
            results: store,
          });
          const ran: CheckRunResult = result ?? {
            checkId: check.id,
            status: 'unknown',
            output: `no result for ${check.id}`,
          };
          publishReviewCheck(notices(), {
            id: check.id,
            command: check.value,
            moment: 'base',
            ...(ran.status === 'pass' || ran.status === 'fail'
              ? {
                  status: 'done',
                  passed: ran.status === 'pass',
                  ...(ran.reusedAt === undefined
                    ? { duration: Date.now() - startedAt }
                    : { reusedAt: ran.reusedAt }),
                }
              : { status: ran.status === 'refused' ? 'refused' : 'not-run', detail: ran.output }),
          });
          settle(check.id, { kind: 'ran', run: ran });
          current = undefined;
        }
      });
      if (cleanupError !== undefined) publishWarning({ ...notices(), message: cleanupError });
    } catch (err) {
      // A stop settles only the row of the command it cut; any other error settles every command
      // still open as not run, with the error as its reason.
      const stopped = signal.aborted;
      const reason = stopped
        ? 'the run stopped before it finished'
        : redactSecrets(toErrorMessage(err));
      for (const check of gate) {
        if (settled.has(check.id)) continue;
        if (!stopped || check.id === current) {
          publishReviewCheck(notices(), {
            status: stopped ? 'stopped' : 'not-run',
            id: check.id,
            command: check.value,
            moment: 'base',
            ...(!stopped && { detail: reason }),
          });
        }
        settle(check.id, { kind: 'unavailable', reason });
      }
    }
  };
  const done = run();
  const outcome = (id: string): Promise<BaseOutcome> =>
    outcomes.get(id)?.promise ??
    Promise.resolve({ kind: 'unavailable', reason: `the project gate names no ${id}` });

  return {
    outcome,
    outcomeForCommand: (command) => {
      const check = gate.find((each) => each.value === command);
      return check === undefined ? undefined : outcome(check.id);
    },
    stop: async () => {
      cut.abort();
      await done;
    },
  };
}
