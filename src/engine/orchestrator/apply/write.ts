import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { checkoutWriterAdvanced, withCheckoutWriteLock } from '../../checkout-write.js';
import { beginCheckoutWriter, type CheckoutWrite } from '../../checkout-writers.js';
import { promoteStagedChanges } from '../approval/staged-project/promote.js';
import { checkoutFingerprint } from '../isolation/checkout-entries.js';
import { transitionAndSave } from '../state-ops/transition.js';
import type { WorkflowPersistenceContext } from '../types.js';
import { applyBackupDir, backupSideEntry, writeApplyBackup } from './backup.js';
import { readApplyEntry } from './entry-read.js';
import { candidateOf, sameSideEntry, type ApplyStates, type SideEntry } from './states.js';

type WriteApplyResult =
  | {
      kind: 'changed';
      side: 'checkout-changed' | 'workspace-changed';
      state: WorkflowState;
      files: string[];
    }
  | {
      kind: 'partial';
      state: WorkflowState;
      backupId: string;
      written: string[];
      failedFile: string;
      cause: string;
      files: string[];
    }
  | { kind: 'applied'; state: WorkflowState; files: string[] };

async function changedEntries(
  dir: string,
  paths: string[],
  expected: ReadonlyMap<string, SideEntry>,
): Promise<string[]> {
  const changed: string[] = [];
  for (const path of paths) {
    const current = await readApplyEntry(dir, path);
    if (current === null || !sameSideEntry(current, expected.get(path) ?? { kind: 'absent' })) {
      changed.push(path);
    }
  }
  return changed;
}

export async function writeApply(input: {
  scope: WorkflowPersistenceContext;
  state: WorkflowState;
  states: ApplyStates;
  files: string[];
  checkoutRevision: number;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}): Promise<WriteApplyResult | undefined> {
  const { scope, states, files, checkoutRevision, setTrackedState } = input;
  let { state } = input;
  const backupId =
    state.applying?.backupId ?? `apply-${Date.now()}-${randomBytes(8).toString('hex')}`;
  const backup = await writeApplyBackup({
    projectDir: states.projectDir,
    sessionId: scope.sessionId,
    backupId,
    workspaceDir: states.workspaceDir,
    files,
    theirs: states.theirs,
    checkoutRevision,
  });
  const checkoutAdvanced = () => checkoutWriterAdvanced(scope, checkoutRevision);
  if (backup.kind === 'changed') {
    if (state.applying === undefined && checkoutAdvanced()) return undefined;
    return { kind: 'changed', side: 'checkout-changed', state, files: backup.files };
  }

  const targetLinks = new Map(
    [...states.theirs].flatMap(([path, entry]) =>
      entry.kind === 'symlink' ? [[path, entry.target] as const] : [],
    ),
  );
  const pending = new Set(files);
  const settled = Object.keys(candidateOf(states)).filter((path) => !pending.has(path));
  const result = await withCheckoutWriteLock(
    states.projectDir,
    async (): Promise<WriteApplyResult | undefined> => {
      const advanced = checkoutAdvanced();
      const changedSettled = await changedEntries(states.projectDir, settled, states.theirs);
      const [firstChangedSettled] = changedSettled;
      if (firstChangedSettled !== undefined) {
        if (state.applying !== undefined) {
          return {
            kind: 'partial',
            state,
            backupId,
            written: [],
            failedFile: firstChangedSettled,
            cause: 'changed in your checkout during Apply',
            files: [...files, ...changedSettled],
          };
        }
        if (advanced) return undefined;
        return { kind: 'changed', side: 'checkout-changed', state, files: changedSettled };
      }
      if (advanced) {
        if (
          state.applying === undefined &&
          (await changedEntries(states.projectDir, files, states.theirs)).length > 0
        ) {
          return undefined;
        }
        const expected = new Map(
          backup.backup.expected.map((entry) => [entry.path, backupSideEntry(entry)]),
        );
        const changed = await changedEntries(backup.candidateDir, files, expected);
        if (changed.length > 0) {
          return { kind: 'changed', side: 'workspace-changed', state, files: changed };
        }
      }

      state = transitionAndSave(scope, state, { type: 'APPLY_START', backupId });
      setTrackedState?.(state);
      const writer = beginCheckoutWriter(scope);
      const receipts: CheckoutWrite[] = [];
      let completed = false;
      try {
        const promoted = await promoteStagedChanges({
          targetProjectDir: states.projectDir,
          stagedProjectDir: backup.candidateDir,
          files,
          targetBaseline: states.theirsBaseline,
          targetLinks,
          onWrite: (path, entry) =>
            receipts.push([
              path,
              {
                before: checkoutFingerprint(states.theirs.get(path) ?? { kind: 'absent' }),
                after: checkoutFingerprint(entry),
                proven: true,
              },
            ]),
        });
        const failedFile = promoted.failure?.failedFile ?? promoted.conflictedFiles[0];
        if (failedFile !== undefined) {
          return {
            kind: 'partial',
            state,
            backupId,
            written: promoted.promotedFiles,
            failedFile,
            cause:
              promoted.failure === undefined
                ? 'changed in your checkout during Apply'
                : toErrorMessage(promoted.failure.error),
            files,
          };
        }
        state = transitionAndSave(scope, state, {
          type: 'APPLY_DONE',
          files: promoted.promotedFiles,
        });
        setTrackedState?.(state);
        completed = true;
        return { kind: 'applied', state, files: promoted.promotedFiles };
      } finally {
        writer.finish(completed ? receipts : files.map((path) => [path, null]));
      }
    },
  );
  if (result === undefined) {
    await rm(applyBackupDir(scope.projectDir, scope.sessionId, backupId), {
      recursive: true,
      force: true,
    });
  }
  return result;
}
