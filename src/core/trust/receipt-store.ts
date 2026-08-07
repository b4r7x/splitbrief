import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isENOENT } from '../../lib/process/errors.js';
import { sha256Hex } from '../../utils/sha256.js';
import { SPLITBRIEF_DIR } from '../paths.js';

const TRUST_DIRECTORY = 'trust';
const TRUST_STORE_MAX_BYTES = 256 * 1024;

export const TRUST_STORE_MAX_RECEIPTS = 512;

export type TrustStoreRead<T> =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'value'; value: T }>
  | Readonly<{ kind: 'invalid' }>;

/**
 * Consent receipts live on the machine that granted them, never in the project
 * a receipt authorizes. A repository can therefore neither ship nor forge one:
 * a committed receipt lands in a file this store never reads.
 */
export function resolveTrustStorePath(fileName: string, stateDir?: string): string {
  return join(stateDir ?? join(homedir(), SPLITBRIEF_DIR, TRUST_DIRECTORY), fileName);
}

/**
 * Binds a receipt to one checkout. A second clone, a copy, or a move resolves
 * to a different canonical path and so cannot reuse the grant. Unresolvable
 * paths yield `null` so callers fail closed.
 */
export function trustedProjectIdentity(projectDir: string): string | null {
  try {
    return `sha256:${sha256Hex(realpathSync(projectDir))}`;
  } catch {
    return null;
  }
}

/**
 * Reads owner-only receipt state. Anything a hostile writer could arrange —
 * a symlink into another file, group/world access, an oversized or malformed
 * document — reads as `invalid`, which every caller treats as no grant.
 */
export function readTrustStore<T>(
  path: string,
  parse: (value: unknown) => T | null,
): TrustStoreRead<T> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) ||
      !Number.isSafeInteger(stats.size) ||
      stats.size < 0 ||
      stats.size > TRUST_STORE_MAX_BYTES
    ) {
      return { kind: 'invalid' };
    }
    const parsed = parse(JSON.parse(readFileSync(fd, 'utf8')));
    return parsed === null ? { kind: 'invalid' } : { kind: 'value', value: parsed };
  } catch (cause) {
    return isENOENT(cause) ? { kind: 'missing' } : { kind: 'invalid' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
