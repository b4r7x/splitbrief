import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';

/** The stdin reads of a CLI run with `SPLITBRIEF_DEBUG_KEYS=1`, one line of its key log for each read. */
function stdinReads(projectDir: string): string[] {
  const dir = join(projectDir, SPLITBRIEF_DIR, 'debug');
  return readdirSync(dir).flatMap((name) =>
    readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('RAW ')),
  );
}

/** The key log line of one stdin read of `bytes`, with each control byte written as `\xNN`. */
function rawReadLine(bytes: string): string {
  const escaped = bytes.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the key log writes control bytes as hex.
    /[\x00-\x1f\x7f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
  return `RAW  bytes=${Buffer.byteLength(bytes)} ${escaped}`;
}

/** Waits until the key log of the CLI in `projectDir` shows that it got `bytes` in one stdin read. */
export function waitForStdinRead(projectDir: string, bytes: string): Promise<void> {
  return vi.waitFor(() => expect(stdinReads(projectDir)).toContain(rawReadLine(bytes)), {
    timeout: 10_000,
  });
}

/** Waits until the last stdin reads of the CLI in `projectDir` are `reads`, in order, one read each. */
export function waitForLastStdinReads(projectDir: string, reads: readonly string[]): Promise<void> {
  return vi.waitFor(
    () => expect(stdinReads(projectDir).slice(-reads.length)).toEqual(reads.map(rawReadLine)),
    { timeout: 10_000 },
  );
}
