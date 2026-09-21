import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  readClipboardImageData,
  type ClipboardImageReadFailureReason,
} from '../../lib/clipboard/image.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE } from '../../lib/fs.js';
import { assertWritablePathConfined } from '../../lib/path-confinement.js';
import { SPLITBRIEF_DIR } from '../paths.js';
import { MAX_ATTACHMENT_BYTES } from '../schemas/attachment.js';

export type ClipboardImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: ClipboardImageReadFailureReason };

async function saveImage(bytes: Buffer, signal: AbortSignal): Promise<string> {
  const root = homedir();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const relativePath = join(SPLITBRIEF_DIR, 'clipboard', `${digest}.png`);
  const path = join(root, relativePath);
  assertWritablePathConfined(relativePath, root);
  await mkdir(dirname(path), { recursive: true, mode: SECURE_DIR_MODE });
  assertWritablePathConfined(relativePath, root);
  signal.throwIfAborted();
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      SECURE_FILE_MODE,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'EEXIST' &&
      (await readFile(path)).equals(bytes)
    ) {
      return path;
    }
    throw error;
  }
  try {
    await file.writeFile(bytes);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await file.close();
  }
  return path;
}

/** Images remain beside input history so their references also work after a new process starts. */
export async function readClipboardImage({
  signal,
  matchingText,
}: {
  signal: AbortSignal;
  /** A terminal text paste may represent an image only while its clipboard text still matches. */
  matchingText?: string | undefined;
}): Promise<ClipboardImageResult> {
  const result = await readClipboardImageData({
    signal,
    matchingText,
    maxBytes: MAX_ATTACHMENT_BYTES,
  });
  if (!result.ok) return result;
  try {
    const path = await saveImage(result.bytes, signal);
    return signal.aborted ? { ok: false, reason: 'cancelled' } : { ok: true, path };
  } catch {
    return { ok: false, reason: signal.aborted ? 'cancelled' : 'unavailable' };
  }
}
