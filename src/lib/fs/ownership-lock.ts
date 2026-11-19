import Database from 'better-sqlite3';
import { closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasErrnoCode } from '../../utils/errno.js';
import { confinedEnsureDir } from './confined.js';
import { assertWritablePathConfined } from './confinement.js';
import { rejectSymlinkTarget, SECURE_FILE_MODE } from './secure.js';

/** Holds an exclusive writer transaction without changing the database. Keep the file in place. */
export function tryClaimDatabaseLock(
  projectDir: string,
  relativePath: string,
  timeoutMs = 0,
): (() => void) | null {
  confinedEnsureDir(projectDir, dirname(relativePath));
  assertWritablePathConfined(relativePath, projectDir);
  const path = join(projectDir, relativePath);
  try {
    closeSync(openSync(path, 'wx', SECURE_FILE_MODE));
  } catch (err) {
    if (!hasErrnoCode(err, 'EEXIST')) throw err;
  }
  rejectSymlinkTarget(path);
  const db = new Database(path, { timeout: timeoutMs, fileMustExist: true });
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    db.close();
    if (hasErrnoCode(err, 'SQLITE_BUSY')) return null;
    throw err;
  }
  return () => {
    if (db.open) db.close();
  };
}
