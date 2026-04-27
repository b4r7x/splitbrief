import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApprovalsStore, ApprovalGrant } from '../../core/schemas/approval-store.js';
import { ApprovalsStoreSchema } from '../../core/schemas/approval-store.js';
import { approvalsFile } from '../../core/paths.js';
import { ensureSecureDir, SECURE_FILE_MODE } from '../../lib/fs.js';

const EMPTY_STORE: ApprovalsStore = { version: 1, grants: [] };

export function readApprovalsStore(projectDir: string): ApprovalsStore {
  const filePath = approvalsFile(projectDir);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return ApprovalsStoreSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_STORE, grants: [] };
    }
    throw new Error(
      `approval store is corrupt and cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Like `readApprovalsStore` but throws when the store file exists and is corrupt,
 * rather than silently returning an empty store. Use for CLI/user-facing paths.
 */
export function readApprovalsStoreStrict(projectDir: string): ApprovalsStore {
  const filePath = approvalsFile(projectDir);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return ApprovalsStoreSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_STORE, grants: [] };
    }
    throw new Error(
      `approval store is corrupt and cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function writeApprovalsStore(projectDir: string, store: ApprovalsStore): void {
  const filePath = approvalsFile(projectDir);
  ensureSecureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(store, null, 2), { mode: SECURE_FILE_MODE });
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
