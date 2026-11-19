import { readEntryAtRef } from '../../../lib/git/refs.js';
import { error, matches } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { checkoutWriterRevision, expectedForeignCheckoutWrites } from '../../checkout-writers.js';
import { checkoutSandboxRef } from '../../runners/sandbox/env.js';
import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import {
  ABSENT_CHECKOUT_ENTRY,
  checkoutFingerprint,
  readCheckoutFingerprint,
} from '../isolation/checkout-entries.js';

type PlanningMutationBaseline = ChangedFilesBaseline & {
  checkoutRevision: number;
  checkoutEntries: ReadonlyMap<string, string | undefined>;
  sessionId: string | undefined;
};

export const planningMutationError = {
  unexpectedMutations: (files: string[]) =>
    error(
      'planning-unexpected-mutations',
      `CLI planner produced unexpected filesystem mutations: ${files.join(', ')}`,
      { files },
    ),
  isUnexpectedMutations: matches('planning-unexpected-mutations'),
} as const;

export async function capturePlanningMutationBaseline(
  projectDir: string,
): Promise<PlanningMutationBaseline> {
  const sessionId = checkoutSandboxRef(projectDir)?.sessionId;
  const checkoutRevision = checkoutWriterRevision(projectDir);
  const baseline = await captureChangedFilesBaseline(projectDir);
  const checkoutEntries = new Map(
    await Promise.all(
      [...baseline.fingerprints.keys()].map(
        async (file) => [file, await readCheckoutFingerprint(projectDir, file)] as const,
      ),
    ),
  );
  return { ...baseline, checkoutRevision, checkoutEntries, sessionId };
}

// internalStatePaths are the tool's catalog-declared per-project state prefixes (e.g. OpenCode
// regenerates its `.opencode/package-lock.json` on startup); churn there is tool-internal
// housekeeping, not planner-authored content. No artifact basename or session path is exempt:
// the guard reports mutations and never selects a candidate artifact.
export async function findUnexpectedPlanningMutations(opts: {
  projectDir: string;
  baseline: PlanningMutationBaseline;
  internalStatePaths?: readonly string[] | undefined;
}): Promise<string[]> {
  const { projectDir, baseline, internalStatePaths = [] } = opts;
  const changed = await changedFilesSinceBaseline(projectDir, baseline);
  const unexpected = changed.filter(
    (file) =>
      !internalStatePaths.some((path) =>
        path.endsWith('/') ? file.startsWith(path) : file === path,
      ),
  );
  if (unexpected.length === 0 || checkoutWriterRevision(projectDir) === baseline.checkoutRevision) {
    return unexpected;
  }

  const before = new Map<string, string>();
  await Promise.all(
    unexpected.map(async (file) => {
      const fingerprint = baseline.checkoutEntries.has(file)
        ? baseline.checkoutEntries.get(file)
        : await committedCheckoutFingerprint(projectDir, baseline.head, file);
      if (fingerprint !== undefined) before.set(file, fingerprint);
    }),
  );
  const proven = expectedForeignCheckoutWrites(
    { projectDir, sessionId: baseline.sessionId },
    baseline.checkoutRevision,
    before,
  );
  const attributed = await Promise.all(
    unexpected.map(async (file) => {
      const expected = proven.get(file);
      return (
        expected !== undefined && expected === (await readCheckoutFingerprint(projectDir, file))
      );
    }),
  );
  return unexpected.filter((_, index) => !attributed[index]);
}

async function committedCheckoutFingerprint(
  projectDir: string,
  head: string | null,
  file: string,
): Promise<string | undefined> {
  if (head === null) return ABSENT_CHECKOUT_ENTRY;
  try {
    const entry = await readEntryAtRef(projectDir, head, file);
    if (entry === null) return ABSENT_CHECKOUT_ENTRY;
    return checkoutFingerprint(
      entry.kind === 'symlink' ? entry : { ...entry, sha256: sha256Hex(entry.bytes) },
    );
  } catch {
    // A gitlink or unavailable tree entry cannot prove who changed the checkout.
    return undefined;
  }
}
