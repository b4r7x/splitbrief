import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { error } from '../../utils/error.js';
import { gitBinary } from './client.js';

type EntryMergeResult =
  | { kind: 'clean'; bytes: Buffer }
  | { kind: 'conflict'; bytes: Buffer; count: number }
  | { kind: 'unmergeable' };

/** Merge exact captured entries without touching a repository or its index. */
export async function mergeFileEntries(input: {
  base: Buffer;
  ours: Buffer;
  theirs: Buffer;
}): Promise<EntryMergeResult> {
  const { base, ours, theirs } = input;
  if (base.includes(0) || ours.includes(0) || theirs.includes(0)) return { kind: 'unmergeable' };
  const root = await mkdtemp(join(tmpdir(), 'splitbrief-entry-merge-'));
  try {
    await writeFile(join(root, 'ours'), ours, { mode: 0o600 });
    await writeFile(join(root, 'base'), base, { mode: 0o600 });
    await writeFile(join(root, 'theirs'), theirs, { mode: 0o600 });
    return await new Promise<EntryMergeResult>((resolve, reject) => {
      const child = spawn(
        gitBinary(),
        [
          'merge-file',
          '-p',
          '--diff3',
          '-L',
          'ours',
          '-L',
          'base',
          '-L',
          'theirs',
          'ours',
          'base',
          'theirs',
        ],
        { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === null) {
          reject(error('entry-merge-failed', 'Could not merge captured entries'));
        } else if (code >= 128) {
          resolve({ kind: 'unmergeable' });
        } else {
          const bytes = Buffer.concat(chunks);
          resolve(code === 0 ? { kind: 'clean', bytes } : { kind: 'conflict', bytes, count: code });
        }
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
