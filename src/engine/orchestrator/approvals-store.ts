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
  } catch {
    return { ...EMPTY_STORE, grants: [] };
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
