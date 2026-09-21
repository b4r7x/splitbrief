import { confinedCreateFile, confinedReplaceFile } from '../../lib/confined-fs.js';
import { assertModelWritablePathConfined } from '../../lib/path-confinement.js';
import { computeDiff } from '../../utils/diff.js';
import { sha256Hex } from '../../utils/sha256.js';
import { readConfinedEntry } from '../orchestrator/approval/file-snapshots/entry.js';
import type { AppliedFile, BundleApplyResult, BundleBaseline } from './file-bundle.js';
import { compareBundleBaseline } from './bundle-baseline.js';
import type { FileBundleCandidate } from './parse-file-bundle.js';

const MIN_GUARDED_BASELINE_LINES = 5;
const MAX_WHOLE_FILE_SHRINK = 0.5;

export interface ApplyFileBundleInput {
  projectDir: string;
  /** The dispatched call this application answers for, carried into its result. */
  callId: string;
  /** Every declared target's captured baseline; the set `untouched` is measured against. */
  baselines: readonly BundleBaseline[];
  /** Prevalidated entries that change content, already free of no-ops. */
  candidates: readonly FileBundleCandidate[];
  /** Entries whose content already equals their baseline; never written, never counted. */
  noops: readonly string[];
  /** The existing per-path write gate, asked once per candidate before any write. */
  approveWrite?:
    | ((path: string) => Promise<{ allow: boolean; reason?: string | undefined }>)
    | undefined;
  /** Aborted before the first mutation rejects; aborted between mutations is partial. */
  signal?: AbortSignal | undefined;
}

function byPath(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function countNonEmptyLines(content: string): number {
  return content.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * The existing whole-file shrink guard, per modify candidate. A bundle carries
 * complete file contents, so a response that drops most of a substantial file
 * is a truncated answer rather than a rewrite — and one such file refuses the
 * whole bundle, before anything is written.
 */
function implausibleRewrite(baseline: BundleBaseline, content: string): string | undefined {
  if (baseline.kind !== 'text') return undefined;
  const had = countNonEmptyLines(baseline.content);
  const kept = countNonEmptyLines(content);
  if (had < MIN_GUARDED_BASELINE_LINES || kept >= had * MAX_WHOLE_FILE_SHRINK) return undefined;
  return [
    `Refusing to overwrite ${baseline.path}: the response keeps ${kept} of ${had} non-empty lines, which is not a plausible whole-file rewrite.`,
    'Return the complete content of every declared file, or ask for the brief to be split so each file fits one response.',
  ].join('\n');
}

/** Declared targets that took no content change, no-ops excluded. */
function untouchedPaths(
  baselines: readonly BundleBaseline[],
  noops: readonly string[],
  applied: readonly AppliedFile[],
): string[] {
  const settled = new Set<string>([...noops, ...applied.map((file) => file.path)]);
  return baselines
    .map((baseline) => baseline.path)
    .filter((path) => !settled.has(path))
    .sort(byPath);
}

type WriteOutcome =
  | { kind: 'applied'; afterSha256: string }
  | { kind: 'failed'; code: 'io-failure' | 'write-uncertain'; error: string };

/**
 * One candidate's write, then its reconciliation from actual confined disk. The
 * write may report an error after the content landed, or land nothing after
 * reporting none, so what happened is decided by re-reading the file and
 * comparing it against the candidate and the baseline — never by the call
 * returning. A disk that matches neither is an outcome nobody can attribute,
 * which is a recovery diagnostic rather than a quiet success or a quiet skip.
 */
async function writeCandidate(
  projectDir: string,
  baseline: BundleBaseline,
  candidate: FileBundleCandidate,
): Promise<WriteOutcome> {
  try {
    assertModelWritablePathConfined(candidate.path, projectDir);
  } catch (err) {
    return { kind: 'failed', code: 'io-failure', error: message(err) };
  }
  let writeError: string | undefined;
  try {
    if (baseline.kind === 'missing') {
      await confinedCreateFile(projectDir, candidate.path, candidate.content);
    } else {
      await confinedReplaceFile(projectDir, candidate.path, candidate.content, baseline.mode);
    }
  } catch (err) {
    writeError = message(err);
  }

  const expected = sha256Hex(Buffer.from(candidate.content, 'utf8'));
  let after: Awaited<ReturnType<typeof readConfinedEntry>>;
  try {
    after = await readConfinedEntry(projectDir, candidate.path);
  } catch (err) {
    return {
      kind: 'failed',
      code: 'write-uncertain',
      error: `${candidate.path}: the outcome of the write could not be established (${message(err)}); recovery must reconcile this file before the brief continues`,
    };
  }

  if (after.kind === 'file' && after.sha256 === expected) {
    return { kind: 'applied', afterSha256: after.sha256 };
  }
  const unchanged =
    baseline.kind === 'missing'
      ? after.kind === 'absent'
      : after.kind === 'file' && after.sha256 === baseline.sha256;
  if (unchanged) {
    return {
      kind: 'failed',
      code: 'io-failure',
      error: `${candidate.path}: ${writeError ?? 'the write left the file unchanged'}`,
    };
  }
  return {
    kind: 'failed',
    code: 'write-uncertain',
    error: `${candidate.path}: the file now holds neither the baseline nor the response content${writeError === undefined ? '' : ` (${writeError})`}; recovery must reconcile this file before the brief continues`,
  };
}

function appliedFile(
  baseline: BundleBaseline,
  candidate: FileBundleCandidate,
  afterSha256: string,
): AppliedFile {
  const before = baseline.kind === 'text' ? baseline.content : '';
  const { diff, linesAdded, linesRemoved } = computeDiff(before, candidate.content);
  return {
    path: candidate.path,
    action: candidate.action,
    beforeSha256: baseline.kind === 'text' ? baseline.sha256 : null,
    afterSha256,
    diff,
    linesAdded,
    linesRemoved,
  };
}

/**
 * The §6 application: prevalidated candidates onto the confined filesystem, in
 * lexical path order, each one approved and rechecked before its own write.
 *
 * Nothing is written until every candidate is approved and the whole captured
 * baseline still matches, so a refusal touches no file. After the first write
 * there is no rollback — a later user edit is not something to undo — and the
 * result names exactly what landed: `partial` with the failing path, never a
 * success. This is per-file replacement, not cross-file atomicity.
 */
export async function applyFileBundle(input: ApplyFileBundleInput): Promise<BundleApplyResult> {
  const { projectDir, baselines, candidates, callId, signal } = input;
  const noops = [...input.noops].sort(byPath);
  const baselineByPath = new Map(baselines.map((baseline) => [baseline.path, baseline]));
  const ordered = [...candidates].sort((left, right) => byPath(left.path, right.path));
  const candidatePaths = ordered.map((candidate) => candidate.path);

  const rejected = (
    code: Extract<BundleApplyResult, { status: 'rejected' }>['code'],
    error: string,
  ): BundleApplyResult => ({
    callId,
    candidatePaths,
    status: 'rejected',
    code,
    error,
    applied: [],
    noops,
    untouched: untouchedPaths(baselines, noops, []),
  });

  if (ordered.length === 0) {
    return rejected('no-changes', 'the bundle carries no candidate that changes a declared target');
  }

  const planned: Array<{ baseline: BundleBaseline; candidate: FileBundleCandidate }> = [];
  for (const candidate of ordered) {
    const baseline = baselineByPath.get(candidate.path);
    if (baseline === undefined) {
      return rejected('unsafe-target', `${candidate.path}: not a declared target of this brief`);
    }
    const shrink = implausibleRewrite(baseline, candidate.content);
    if (shrink !== undefined) return rejected('implausible-rewrite', shrink);
    planned.push({ baseline, candidate });
  }

  for (const { candidate } of planned) {
    const approval = input.approveWrite
      ? await input.approveWrite(candidate.path)
      : { allow: true };
    if (!approval.allow) {
      return rejected(
        'denied',
        approval.reason ?? `write to ${candidate.path} denied by approval gate`,
      );
    }
  }

  const global = await compareBundleBaseline(projectDir, baselines);
  if (global.kind === 'conflict') {
    return rejected('baseline-conflict', `${global.path}: ${global.error}`);
  }

  const applied: AppliedFile[] = [];
  const stopped = (
    code: 'io-failure' | 'write-uncertain' | 'baseline-conflict' | 'cancelled',
    error: string,
    failedPath: string,
  ): BundleApplyResult => {
    const untouched = untouchedPaths(baselines, noops, applied);
    const provenance = { callId, candidatePaths };
    if (applied.length === 0) {
      if (code === 'io-failure' || code === 'write-uncertain') {
        return {
          ...provenance,
          status: 'failed',
          code,
          error,
          failedPath,
          applied: [],
          noops,
          untouched,
        };
      }
      return { ...provenance, status: 'rejected', code, error, applied: [], noops, untouched };
    }
    return { ...provenance, status: 'partial', code, error, failedPath, applied, noops, untouched };
  };

  for (const { baseline, candidate } of planned) {
    if (signal?.aborted === true) {
      return stopped('cancelled', `cancelled before writing ${candidate.path}`, candidate.path);
    }
    const recheck = await compareBundleBaseline(projectDir, [baseline]);
    if (recheck.kind === 'conflict') {
      return stopped('baseline-conflict', `${recheck.path}: ${recheck.error}`, recheck.path);
    }

    const outcome = await writeCandidate(projectDir, baseline, candidate);
    if (outcome.kind === 'failed') {
      return stopped(outcome.code, outcome.error, candidate.path);
    }
    applied.push(appliedFile(baseline, candidate, outcome.afterSha256));
  }

  return {
    callId,
    candidatePaths,
    status: 'applied',
    applied,
    noops,
    untouched: untouchedPaths(baselines, noops, applied),
  };
}
