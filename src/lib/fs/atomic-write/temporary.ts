import { unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isENOENT } from '../../../utils/errno.js';
import { fsError } from '../secure.js';
import { assertAtomicDirectoryIdentity, assertAtomicDirectoryIdentitySync } from './target.js';
import type { AtomicTarget } from './types.js';

export async function removeTemporaryFile(path: string, target?: AtomicTarget): Promise<void> {
  if (target !== undefined) {
    try {
      await assertAtomicDirectoryIdentity(target);
    } catch (err) {
      if (fsError.isInvalidId(err) || fsError.isSymlinkWrite(err) || isENOENT(err)) return;
      throw err;
    }
  }
  try {
    await unlink(path);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}

export function temporaryPath(target: AtomicTarget): string {
  return join(target.directory, `.${basename(target.path)}.tmp.${randomBytes(16).toString('hex')}`);
}

export function removeTemporaryFileSync(path: string, target?: AtomicTarget): void {
  if (target !== undefined) {
    try {
      assertAtomicDirectoryIdentitySync(target);
    } catch (err) {
      if (fsError.isInvalidId(err) || fsError.isSymlinkWrite(err) || isENOENT(err)) return;
      throw err;
    }
  }
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}
