import { existsSync } from 'node:fs';
import type { ApprovalsStore, ApprovalGrant } from '../schemas/approval-store.js';
import { ApprovalsStoreSchema } from '../schemas/approval-store.js';
import { approvalsFile } from '../paths.js';
import { readJsonSafe, writeSecureFile } from '../../lib/fs.js';
import { error } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const EMPTY_STORE: ApprovalsStore = { version: 1, grants: [] };

export const approvalsStoreError = {
  corrupt: (reason: string, cause?: unknown) =>
    error(
      'approval-store-corrupt',
      `approval store is corrupt and cannot be read: ${reason}`,
      { reason },
      cause,
    ),
} as const;

export function readApprovalsStore(projectDir: string): ApprovalsStore {
  const filePath = approvalsFile(projectDir);
  if (!existsSync(filePath)) return { ...EMPTY_STORE, grants: [] };
  const raw = readJsonSafe(filePath);
  if (raw === null) {
    throw approvalsStoreError.corrupt('failed to parse JSON');
  }
  try {
    return ApprovalsStoreSchema.parse(raw);
  } catch (err) {
    throw approvalsStoreError.corrupt(toErrorMessage(err), err);
  }
}

export function writeApprovalsStore(projectDir: string, store: ApprovalsStore): void {
  writeSecureFile(approvalsFile(projectDir), JSON.stringify(store, null, 2));
}

export function clearGrantsByScope(
  store: ApprovalsStore,
  scope: 'session' | 'always' | 'all',
): ApprovalsStore {
  const grants: ApprovalGrant[] =
    scope === 'all' ? [] : store.grants.filter((g) => g.scope !== scope);
  return { ...store, grants };
}
