import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { SPLITBRIEF_DIR } from '../core/paths.js';
import type { SessionRef } from '../core/types/session-ref.js';
import { tryClaimDatabaseLock } from '../lib/fs/ownership-lock.js';
import { checkoutWriterRevision, hasOtherLiveCheckoutRun } from './checkout-writers.js';

const checkoutLock = join(SPLITBRIEF_DIR, 'checkout-write.db');

export async function withCheckoutWriteLock<T>(
  projectDir: string,
  write: () => Promise<T>,
): Promise<T> {
  let release = tryClaimDatabaseLock(projectDir, checkoutLock);
  while (release === null) {
    await setTimeout(10);
    release = tryClaimDatabaseLock(projectDir, checkoutLock);
  }
  try {
    return await write();
  } finally {
    release();
  }
}

export function checkoutWriterAdvanced(ref: SessionRef, revision: number): boolean {
  return checkoutWriterRevision(ref.projectDir) !== revision || hasOtherLiveCheckoutRun(ref);
}
