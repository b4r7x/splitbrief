import { confinedFileIdentity } from '../../lib/confined-fs.js';
import { assertModelWritablePathConfined } from '../../lib/path-confinement.js';
import type { Task } from '../../core/schemas/task.js';
import { readConfinedEntry } from '../orchestrator/approval/file-snapshots/entry.js';
import { FILE_BUNDLE_MAX_FILES, type BundleBaseline } from './file-bundle.js';
import { unsafePathReason } from './parse-file-bundle.js';

export interface CaptureBundleBaselineInput {
  projectDir: string;
  /** The brief's anchor, its declared targets and the action the anchor claims. */
  task: Pick<Task, 'suggestedFiles' | 'action'>;
  /**
   * Paths this same task is conclusively recorded to have created in an earlier
   * attempt. Only the anchor needs it: a non-anchor operation is derived.
   */
  createdByThisTask?: readonly string[] | undefined;
}

export type CaptureBundleBaselineResult =
  | { kind: 'captured'; baselines: BundleBaseline[] }
  | {
      kind: 'rejected';
      code: 'unsafe-target' | 'baseline-conflict' | 'output-limit';
      path: string;
      error: string;
    };

export type CompareBundleBaselineResult =
  | { kind: 'match' }
  | { kind: 'conflict'; path: string; error: string };

/** Strict: an invalid sequence throws instead of decoding to U+FFFD, and a BOM stays content. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function byPath(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function rejected(
  code: 'unsafe-target' | 'baseline-conflict' | 'output-limit',
  path: string,
  error: string,
): CaptureBundleBaselineResult {
  return { kind: 'rejected', code, path, error };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ObservedTarget =
  | { kind: 'missing' }
  | { kind: 'text'; content: string; sha256: string; mode: number }
  | { kind: 'unsupported'; error: string };

/**
 * One declared target as the confined filesystem holds it right now. A symlink,
 * directory, special file, binary payload or invalid UTF-8 is `unsupported` —
 * it is a failure, never `missing`.
 */
async function observeTarget(projectDir: string, path: string): Promise<ObservedTarget> {
  let entry: Awaited<ReturnType<typeof readConfinedEntry>>;
  try {
    assertModelWritablePathConfined(path, projectDir);
    entry = await readConfinedEntry(projectDir, path);
  } catch (err) {
    return { kind: 'unsupported', error: message(err) };
  }
  if (entry.kind === 'absent') return { kind: 'missing' };
  if (entry.bytes.includes(0)) return { kind: 'unsupported', error: 'binary content (NUL byte)' };
  try {
    return {
      kind: 'text',
      content: utf8.decode(entry.bytes),
      sha256: entry.sha256,
      mode: entry.mode,
    };
  } catch {
    return { kind: 'unsupported', error: 'content is not valid UTF-8' };
  }
}

export function declaredPathProblem(path: string, earlier: readonly string[]): string | undefined {
  if (path.includes('*')) return 'glob is not an explicit target';
  const unsafe = unsafePathReason(path);
  if (unsafe !== undefined) return unsafe;
  for (const other of earlier) {
    if (other === path) return 'duplicate declared target';
    if (path.startsWith(`${other}/`) || other.startsWith(`${path}/`)) {
      return `collides with declared target ${other}`;
    }
  }
  return undefined;
}

/**
 * The §5 baseline for every declared target of a brief, taken from the confined
 * filesystem immediately before generation — never from a stale `currentCode`.
 * Every target is captured before any is trusted: one unreadable, aliased or
 * action-contradicting target rejects the whole brief.
 */
export async function captureBundleBaseline(
  input: CaptureBundleBaselineInput,
): Promise<CaptureBundleBaselineResult> {
  const { projectDir, task } = input;
  const paths = [...task.suggestedFiles].sort(byPath);
  if (paths.length > FILE_BUNDLE_MAX_FILES) {
    return rejected(
      'output-limit',
      task.suggestedFiles[0],
      `${paths.length} declared targets exceeds the ${FILE_BUNDLE_MAX_FILES}-target limit`,
    );
  }

  const baselines: BundleBaseline[] = [];
  const identities = new Map<string, string>();
  const captured: string[] = [];
  for (const path of paths) {
    const problem = declaredPathProblem(path, captured);
    if (problem !== undefined) return rejected('unsafe-target', path, problem);
    captured.push(path);

    const observed = await observeTarget(projectDir, path);
    if (observed.kind === 'unsupported') return rejected('unsafe-target', path, observed.error);

    if (observed.kind === 'text') {
      const identity = await confinedFileIdentity(projectDir, path);
      const key = identity === null ? path : `${identity.dev}:${identity.ino}`;
      const alias = identities.get(key);
      if (alias !== undefined) {
        return rejected('unsafe-target', path, `names the same file as declared target ${alias}`);
      }
      identities.set(key, path);
    }

    const disagreement = anchorDisagreement(path, observed.kind, input);
    if (disagreement !== undefined) return rejected('baseline-conflict', path, disagreement);

    baselines.push(
      observed.kind === 'text'
        ? {
            path,
            operation: 'modify',
            kind: 'text',
            content: observed.content,
            sha256: observed.sha256,
            mode: observed.mode,
          }
        : { path, operation: 'create', kind: 'missing' },
    );
  }
  return { kind: 'captured', baselines };
}

/**
 * Every operation is derived from what the confined filesystem holds: present is
 * `modify`, absent is `create`. The anchor additionally has to agree with the
 * action its brief was dispatched with (`refreshCurrentCode` derives it), so an
 * anchor that changed since dispatch is refused rather than silently
 * reinterpreted. The one exception is a retry after this same task created the
 * anchor: the recorded creation makes `create` mean modify against the freshly
 * captured content. A non-anchor target makes no claim and needs no exception.
 */
function anchorDisagreement(
  path: string,
  observed: 'missing' | 'text',
  input: CaptureBundleBaselineInput,
): string | undefined {
  if (path !== input.task.suggestedFiles[0]) return undefined;
  const { action } = input.task;
  if (action === 'create' && observed === 'text') {
    if (input.createdByThisTask?.includes(path) === true) return undefined;
    return 'the brief says create but the anchor already exists';
  }
  if (action === 'modify' && observed === 'missing') {
    return 'the brief says modify but the anchor is missing';
  }
  return undefined;
}

/**
 * Re-reads each captured target and reports the first that moved. Callers run it
 * over the whole set after approvals and before the first mutation, and again
 * over the single target immediately before its own write.
 */
export async function compareBundleBaseline(
  projectDir: string,
  baselines: readonly BundleBaseline[],
): Promise<CompareBundleBaselineResult> {
  for (const baseline of [...baselines].sort((left, right) => byPath(left.path, right.path))) {
    const observed = await observeTarget(projectDir, baseline.path);
    if (observed.kind === 'unsupported') {
      return { kind: 'conflict', path: baseline.path, error: observed.error };
    }
    if (baseline.kind === 'missing') {
      if (observed.kind !== 'missing') {
        return { kind: 'conflict', path: baseline.path, error: 'target now exists' };
      }
      continue;
    }
    if (observed.kind === 'missing') {
      return { kind: 'conflict', path: baseline.path, error: 'target no longer exists' };
    }
    if (observed.sha256 !== baseline.sha256) {
      return { kind: 'conflict', path: baseline.path, error: 'target content changed' };
    }
    if ((observed.mode & 0o777) !== (baseline.mode & 0o777)) {
      return { kind: 'conflict', path: baseline.path, error: 'target file mode changed' };
    }
  }
  return { kind: 'match' };
}
