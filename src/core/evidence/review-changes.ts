import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { sessionDir } from '../paths.js';
import { assertSessionConfinement, assertSessionDirConfined } from '../sessions/confinement.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  ReviewChangesSchema,
  type ReviewChange,
  type ReviewChanges,
} from '../schemas/review-changes.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { writeSecureFile } from '../../lib/fs.js';
import { lockSibling, withFileLock } from '../../lib/file-lock.js';
import { isENOENT } from '../../lib/process/errors.js';
import { sha256Hex } from '../../utils/sha256.js';
import { error } from '../../utils/error.js';

export const REVIEW_CHANGES_FILE = 'review-changes.json';

function artifact(ref: SessionRef): string {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  return join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_CHANGES_FILE);
}

export function readReviewChanges(ref: SessionRef): ReviewChanges | null {
  const path = artifact(ref);
  let text: string;
  try {
    assertExistingPathConfined(relative(ref.projectDir, path), ref.projectDir);
    assertSessionConfinement(path, dirname(path));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink > 1) {
      throw error('review-changes-invalid', 'Review changes must be a regular file with one link.');
    }
    // Nonblocking so a FIFO substituted between the lstat and the open cannot
    // stall the read; fstat then gates the read on a regular single-link file.
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink > 1) {
        throw error(
          'review-changes-invalid',
          'Review changes must be a regular file with one link.',
        );
      }
      text = readFileSync(descriptor, 'utf8');
    } finally {
      closeSync(descriptor);
    }
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  const result = ReviewChangesSchema.parse(JSON.parse(text));
  if (result.sessionId !== ref.sessionId) {
    throw error('review-changes-invalid', 'Review changes belong to another session.');
  }
  for (const change of result.changes) {
    if (change.kind !== 'captured') continue;
    for (const entry of [change.before, change.after]) {
      if (entry !== null && sha256Hex(Buffer.from(entry.base64, 'base64')) !== entry.sha256) {
        throw error('review-changes-invalid', 'Review change bytes do not match their digest.');
      }
    }
  }
  return result;
}

export function appendReviewChanges(ref: SessionRef, changes: ReviewChange[]): void {
  if (changes.length === 0) return;
  const path = artifact(ref);
  assertWritablePathConfined(relative(ref.projectDir, path), ref.projectDir);
  assertSessionConfinement(path, dirname(path));
  withFileLock(
    lockSibling(path),
    () => error('review-changes-lock', 'Review changes are locked.'),
    () => {
      const previous = readReviewChanges(ref);
      writeSecureFile(
        path,
        `${JSON.stringify({
          version: 1,
          sessionId: ref.sessionId,
          changes: [...(previous?.changes ?? []), ...changes],
        } satisfies ReviewChanges)}\n`,
      );
    },
  );
}
