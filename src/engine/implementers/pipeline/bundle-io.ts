import type { ImplementerOptions, ImplementerResult } from '../types.js';
import type { RunnerCallStatus } from '../../calls/types.js';
import type { Task } from '../../../core/schemas/task.js';
import { taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { AppliedFile, BundleApplyResult, BundleBaseline } from '../file-bundle/contract.js';
import { captureBundleBaseline } from '../file-bundle/baseline.js';
import { parseFileBundle } from '../file-bundle/parse.js';
import { applyFileBundle } from '../file-bundle/apply.js';
import { orderChangedFiles } from '../../change-detection.js';
import { worksInPlace } from './checkout-guard.js';
import type { BundleSeat } from './types.js';

function creationScope(opts: ImplementerOptions): string {
  return JSON.stringify([opts.projectDir, opts.task.id]);
}

/**
 * The brief as the confined filesystem holds it right now: the operation of
 * every declared target and the code the answer has to rewrite come from the
 * capture, never from a `currentCode` the brief carried in. An anchor the
 * capture reads as existing is a modify even when the brief still says create.
 */
function refreshTaskCode(task: Task, baselines: readonly BundleBaseline[]): Task {
  const anchor = baselines.find((baseline) => baseline.path === task.suggestedFiles[0]);
  const byFile = Object.fromEntries(
    baselines.flatMap((baseline) =>
      baseline.path !== task.suggestedFiles[0] && baseline.kind === 'text'
        ? ([[baseline.path, baseline.content]] as const)
        : [],
    ),
  );
  return {
    ...task,
    action: anchor?.operation ?? task.action,
    currentCode: anchor?.kind === 'text' ? anchor.content : undefined,
    currentCodeByFile: Object.keys(byFile).length > 0 ? byFile : undefined,
  };
}

/**
 * One brief, one diff: the applied files in the order they landed, each named
 * when more than one changed so the card can tell them apart, and the line
 * counts summed over the whole bundle.
 */
function aggregateApplied(applied: readonly AppliedFile[]): {
  diff: string;
  linesAdded: number;
  linesRemoved: number;
} {
  const diff =
    applied.length === 1
      ? (applied[0]?.diff ?? '')
      : applied.map((file) => `${file.path}\n${file.diff}`).join('\n');
  return {
    diff,
    linesAdded: applied.reduce((total, file) => total + file.linesAdded, 0),
    linesRemoved: applied.reduce((total, file) => total + file.linesRemoved, 0),
  };
}

function bundleFailure(
  seat: BundleSeat,
  opts: ImplementerOptions,
  output: string,
  usage: TokenDelta | null,
  applyResult: Exclude<BundleApplyResult, { status: 'applied' }>,
): ImplementerResult {
  seat.failTask(opts, applyResult.error);
  return {
    success: false,
    output,
    error: applyResult.error,
    applyResult,
    ...(usage !== null && { usage }),
  };
}

/**
 * Every declared target's baseline, taken from the confined filesystem before
 * the prompt, the reserve or any generation exists. A capture that refuses is
 * a refusal of the whole brief: nothing is dispatched and nothing is written.
 */
export async function prepareCall(
  seat: BundleSeat,
  opts: ImplementerOptions,
): Promise<
  | { kind: 'ready'; opts: ImplementerOptions; baselines: readonly BundleBaseline[] }
  | { kind: 'refused'; result: ImplementerResult }
> {
  if (seat.outputContract !== 'file-bundle-v1') return { kind: 'ready', opts, baselines: [] };

  const captured = await captureBundleBaseline({
    projectDir: opts.projectDir,
    task: opts.task,
    createdByThisTask:
      worksInPlace(opts) && opts.createdByThisTask !== undefined
        ? opts.createdByThisTask
        : [
            ...(seat.createdByTask.get(creationScope(opts)) ?? []),
            ...(opts.createdByThisTask ?? []),
          ],
  });
  if (captured.kind === 'rejected') {
    const error = `${captured.path}: ${captured.error}`;
    return {
      kind: 'refused',
      result: bundleFailure(seat, opts, '', null, {
        // The refusal precedes the call, so there is no call to name and no
        // response to have proposed a candidate.
        callId: null,
        candidatePaths: [],
        status: 'rejected',
        code: captured.code,
        error,
        applied: [],
        // A refusal before generation has no response to tell a no-op from an
        // omission: every declared target is simply untouched.
        noops: [],
        untouched: [...opts.task.suggestedFiles].sort(),
      }),
    };
  }
  return {
    kind: 'ready',
    opts: { ...opts, task: refreshTaskCode(opts.task, captured.baselines) },
    baselines: captured.baselines,
  };
}

/**
 * The completed response as `file-bundle-v1`: validated whole against the
 * captured targets, then applied. What landed is the result — a rejection
 * wrote nothing, and a partial application is a failure that names what it
 * already changed.
 */
export async function applyBundleOutput(
  seat: BundleSeat,
  input: {
    opts: ImplementerOptions;
    baselines: readonly BundleBaseline[];
    callId: string;
    text: string;
    status: RunnerCallStatus;
    startTime: number;
    usage: TokenDelta | null;
  },
): Promise<ImplementerResult> {
  const { opts, baselines, callId, text, usage } = input;

  const parsed = parseFileBundle({
    text,
    status: input.status,
    targets: baselines,
    scope: taskDeclaredPatterns(opts.task),
  });
  if (parsed.kind === 'blocked') {
    return {
      success: false,
      output: text,
      error: `Implementer is blocked: ${parsed.question}`,
      blocked: { question: parsed.question, filesNeeded: parsed.filesNeeded },
      ...(usage !== null && { usage }),
    };
  }
  if (parsed.kind === 'rejected') {
    return bundleFailure(seat, opts, text, usage, {
      callId,
      // A response the parser refused produced no candidate to apply.
      candidatePaths: [],
      status: 'rejected',
      code: parsed.code,
      error: parsed.error,
      applied: [],
      noops: [],
      untouched: baselines.map((baseline) => baseline.path),
    });
  }

  const applyResult = await applyFileBundle({
    projectDir: opts.projectDir,
    baselines,
    callId,
    candidates: parsed.candidates,
    noops: parsed.noops,
    approveWrite: opts.approveWrite,
    signal: opts.signal,
  });
  const created = applyResult.applied.filter((file) => file.action === 'create');
  if (created.length > 0) {
    const owned = seat.createdByTask.get(creationScope(opts)) ?? new Set<string>();
    for (const file of created) owned.add(file.path);
    seat.createdByTask.set(creationScope(opts), owned);
  }
  if (applyResult.status !== 'applied') return bundleFailure(seat, opts, text, usage, applyResult);

  if (opts.phase) {
    const aggregate = aggregateApplied(applyResult.applied);
    seat.publisher?.publishDone({
      phase: opts.phase,
      taskId: opts.task.id,
      file: opts.task.suggestedFiles[0],
      files: orderChangedFiles(
        applyResult.applied.map((file) => file.path),
        opts.task.suggestedFiles,
      ),
      diff: aggregate.diff,
      linesAdded: aggregate.linesAdded,
      linesRemoved: aggregate.linesRemoved,
      duration: Date.now() - input.startTime,
      kept: opts.continuation?.kept,
    });
  }
  return {
    success: true,
    output: text,
    applyResult,
    ...(usage !== null && { usage }),
  };
}
