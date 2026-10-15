import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import { haltActions } from './actions.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { ApplyConflictKind } from '../../apply/merge.js';
import type { ApplyBackupReconciliation } from '../../apply/restore.js';
import { compactFacts, createRecoveryIssue } from './issue.js';

/** A file Apply found changed while it ran: in your checkout, or in the run workspace. */
export type ApplyChangedSide = 'checkout-changed' | 'workspace-changed';

const CONFLICT_WORDS: Record<ApplyConflictKind | ApplyChangedSide, string> = {
  text: 'both sides changed the same lines',
  binary: 'both sides changed a binary file',
  'delete-modify': 'deleted on one side, changed on the other',
  'add-add': 'added on both sides with different content',
  mode: 'file mode differs between the sides',
  symlink: 'both sides changed this symlink differently',
  'unsupported-entry': 'a directory, or a symlink that points outside the project, is in the way',
  'checkout-changed': 'changed in your checkout during Apply',
  'workspace-changed': 'changed in the run workspace during Apply',
};

export function buildApplyConflictRecoveryIssue(input: {
  conflicts: { path: string; kind: ApplyConflictKind | ApplyChangedSide }[];
  workspacePath: string;
  createdAt: string;
}): RecoveryIssue {
  const { conflicts, workspacePath, createdAt } = input;
  const ordered = [
    ...new Map(conflicts.map((conflict) => [conflict.path, conflict])).values(),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const files = ordered.map((conflict) => conflict.path);
  const issue = createRecoveryIssue({
    reason: 'apply-conflict',
    phase: 'complete',
    files,
    affectedTaskIds: [],
    message: '',
    details: [
      `Resolve each file in ${workspacePath}: keep the run's version, copy your checkout's version over it, or edit it; then choose Re-run Apply.`,
      ...ordered.map(({ path, kind }) => `${path} · ${CONFLICT_WORDS[kind]}`),
    ],
    facts: compactFacts({ workspacePath }),
    availableActions: haltActions('apply-conflict', ['retry-same-worker', 'end-run']),
    recommendedAction: 'retry-same-worker',
    createdAt,
  });
  return { ...issue, message: formatRecoveryHeadline(issue) };
}

export function buildApplyPartialRecoveryIssue(
  input: {
    backupId: string;
    backupDir: string;
    createdAt: string;
  } & (
    | { written: string[]; files: string[]; failedFile: string; cause: string }
    | { reconciliation: ApplyBackupReconciliation }
  ),
): RecoveryIssue {
  const { backupId, backupDir, createdAt } = input;
  let files: string[];
  let details: string[];
  let written: number;
  let total: number;
  if ('reconciliation' in input) {
    const reconciliation = input.reconciliation;
    written = reconciliation.written.length;
    total = written + reconciliation.pending.length + reconciliation.ambiguous.length;
    files = [...reconciliation.pending, ...reconciliation.ambiguous].sort();
    const descriptions = new Map([
      ...reconciliation.written.map((path) => [path, 'written'] as const),
      ...reconciliation.pending.map((path) => [path, 'not written'] as const),
      ...reconciliation.ambiguous.map(
        (path) =>
          [
            path,
            'matches neither the backup nor what Apply wrote (restore leaves it as it is)',
          ] as const,
      ),
    ]);
    details = [
      `Apply was cut off: wrote ${written} of ${total} files`,
      ...[...descriptions]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, description]) => `${path} · ${description}`),
    ];
  } else {
    written = input.written.length;
    total = input.files.length;
    const writtenFiles = new Set(input.written);
    files = input.files.filter((path) => !writtenFiles.has(path)).sort();
    details = [`Wrote ${written} of ${total} files; ${input.failedFile} failed: ${input.cause}`];
  }
  const issue = createRecoveryIssue({
    reason: 'apply-partial',
    phase: 'complete',
    files,
    affectedTaskIds: [],
    message: '',
    details: [...details, `Backup of the replaced files: ${backupDir}`],
    facts: compactFacts({ backupId, written, total }),
    availableActions: haltActions('apply-partial', [
      'retry-same-worker',
      'restore-backup',
      'end-run',
    ]),
    recommendedAction: 'retry-same-worker',
    createdAt,
  });
  return { ...issue, message: formatRecoveryHeadline(issue) };
}
