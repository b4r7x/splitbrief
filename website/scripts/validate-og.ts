import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PATH } from './site.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const OG_WIDTH = 1_200;
export const OG_HEIGHT = 630;
export const MIN_OG_BYTES = 1_024;

export function validateOgPng(image: Buffer): void {
  if (image.length < MIN_OG_BYTES) {
    throw new Error(`public/og.png must be nonempty (at least ${MIN_OG_BYTES} bytes).`);
  }

  if (
    !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    image.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('public/og.png must be a valid PNG with an IHDR header.');
  }

  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width !== OG_WIDTH || height !== OG_HEIGHT) {
    throw new Error(`public/og.png must be ${OG_WIDTH}x${OG_HEIGHT}; received ${width}x${height}.`);
  }
}

export async function validateOgFile(path = resolve(PUBLIC_PATH, 'og.png')): Promise<void> {
  validateOgPng(await readFile(path));
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  await validateOgFile();
  process.stdout.write(`OG: public/og.png verified (${OG_WIDTH}x${OG_HEIGHT})\n`);
}
