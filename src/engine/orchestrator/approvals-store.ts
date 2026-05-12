import { existsSync } from 'node:fs';
import type { ApprovalsStore, ApprovalGrant } from '../../core/schemas/approval-store.js';
import { ApprovalsStoreSchema } from '../../core/schemas/approval-store.js';
import { approvalsFile } from '../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../lib/fs.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const EMPTY_STORE: ApprovalsStore = { version: 1, grants: [] };

export function readApprovalsStore(projectDir: string): ApprovalsStore {
  const filePath = approvalsFile(projectDir);
  if (!existsSync(filePath)) return { ...EMPTY_STORE, grants: [] };
  const raw = readJsonSafe(filePath);
  if (raw === null) {
    throw new Error('approval store is corrupt and cannot be read: failed to parse JSON');
  }
  try {
    return ApprovalsStoreSchema.parse(raw);
  } catch (err) {
    throw new Error(
      `approval store is corrupt and cannot be read: ${toErrorMessage(err)}`,
    );
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
    scope === 'all'
      ? []
      : store.grants.filter((g) => g.scope !== scope);
  return { ...store, grants };
}
