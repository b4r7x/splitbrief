import { withCommandRun } from '../../../core/evidence/ledger-state.js';
import { mutateEvidenceLedger, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EvidenceCommandRun } from '../../../core/schemas/evidence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { warnError } from '../../../lib/warn.js';
import { nowIso } from '../../../utils/format-time.js';
import { deserializeChangedFilesBaseline } from '../changed-files-baseline.js';
import { getOrCreateLedger } from '../evidence/persistence.js';
import { currentCandidateId } from '../evidence/record-checks.js';
import type { CheckRunResult } from './run-checks.js';

/**
 * Where a run keeps the result of each command it ran, so one command runs once per state of the
 * tree it runs in. `rerunRedBefore` runs a command again when its stored result is a red stored
 * before that time, and stores the new one: a verify confirms a red that may be a flake, and a red
 * the verify itself stored serves the next id of the same command.
 */
export type CheckResultStore = {
  ref: SessionRef;
  state: WorkflowState;
  tree: EvidenceCommandRun['tree'];
  rerunRedBefore?: string | undefined;
};

/**
 * Runs one command of a check, or takes the stored result of the same command on the same tree
 * state. A pass and a red are stored; a run that timed out, was stopped or did not run is not, so
 * the next check runs it again. A run with no store, or a tree with no state id, runs as it is.
 */
export async function runCommandOnce(opts: {
  store: CheckResultStore | undefined;
  workspaceDir: string;
  checkId: string;
  command: string;
  run: () => Promise<CheckRunResult>;
}): Promise<CheckRunResult> {
  const { store } = opts;
  if (store === undefined) return opts.run();
  const stateId = await treeStateId(store, opts.workspaceDir);
  if (stateId === undefined) return opts.run();
  const stored = storedRun(store, stateId, opts.command);
  if (stored !== undefined && !isStaleRed(store, stored)) return reusedResult(stored, opts.checkId);
  const result = await opts.run();
  const entry = commandRunEntry(result, store.tree, stateId, opts.command);
  if (entry !== null) {
    try {
      mutateEvidenceLedger(store.ref, (ledger) =>
        withCommandRun(ledger ?? getOrCreateLedger({ ref: store.ref, state: store.state }), entry),
      );
    } catch (err) {
      warnError('Could not store the check result; the next check runs the command again', err);
    }
  }
  return result;
}

function isStaleRed(store: CheckResultStore, stored: EvidenceCommandRun): boolean {
  return (
    stored.status === 'fail' &&
    store.rerunRedBefore !== undefined &&
    stored.ts < store.rerunRedBefore
  );
}

async function treeStateId(
  store: CheckResultStore,
  workspaceDir: string,
): Promise<string | undefined> {
  if (store.tree === 'run-base') return store.state.workspace?.base.snapshotId;
  const baseline = store.state.changedFilesBaseline;
  if (baseline === undefined) return undefined;
  try {
    return await currentCandidateId(workspaceDir, deserializeChangedFilesBaseline(baseline));
  } catch (err) {
    warnError('Could not read the workspace state; the check runs its command', err);
    return undefined;
  }
}

function storedRun(
  store: CheckResultStore,
  stateId: string,
  command: string,
): EvidenceCommandRun | undefined {
  try {
    return readEvidenceLedger(store.ref)?.commandRuns?.find(
      (entry) =>
        entry.tree === store.tree && entry.stateId === stateId && entry.command === command,
    );
  } catch (err) {
    warnError('Could not read the stored check results; the check runs its command', err);
    return undefined;
  }
}

function commandRunEntry(
  result: CheckRunResult,
  tree: EvidenceCommandRun['tree'],
  stateId: string,
  command: string,
): EvidenceCommandRun | null {
  if (result.timedOut === true) return null;
  const common = {
    tree,
    stateId,
    command,
    ts: nowIso(),
    ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
    output: result.output,
  };
  if (result.status === 'pass') return { ...common, status: 'pass' };
  if (result.status !== 'fail') return null;
  const { failure } = result;
  return {
    ...common,
    status: 'fail',
    failure: {
      keys: failure.keys,
      ...(failure.placeholder !== undefined && { placeholder: failure.placeholder }),
      ...(failure.messages !== undefined && { messages: Object.fromEntries(failure.messages) }),
    },
  };
}

function reusedResult(entry: EvidenceCommandRun, checkId: string): CheckRunResult {
  const common = {
    checkId,
    output: entry.output,
    command: entry.command,
    ...(entry.exitCode !== undefined && { exitCode: entry.exitCode }),
    reusedAt: entry.ts,
  };
  if (entry.status === 'pass') return { ...common, status: 'pass' };
  const { failure } = entry;
  return {
    ...common,
    status: 'fail',
    failure: {
      keys: failure.keys,
      ...(failure.placeholder !== undefined && { placeholder: failure.placeholder }),
      ...(failure.messages !== undefined && {
        messages: new Map(Object.entries(failure.messages)),
      }),
    },
  };
}
