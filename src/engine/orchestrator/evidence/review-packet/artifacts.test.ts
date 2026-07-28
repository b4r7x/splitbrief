import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCheckpoints } from './artifacts.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'review-packet-artifacts-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('readCheckpoints', () => {
  it('surfaces checkpoint restore safety metadata on the review packet', async () => {
    const missing: string[] = [];
    const checkpoints = await readCheckpoints(tmp, 'sess-01', missing);

    expect(checkpoints.safety).toMatchObject({
      hashGuarded: true,
      conflictsSkippedByDefault: true,
      forceOverwritesConflicts: true,
      partialRestoreExpected: true,
    });
    expect(checkpoints.safety.excludedPaths).toEqual([
      '.git/',
      '.splitbrief/',
      'node_modules/',
      '.trees/',
    ]);
    expect(checkpoints.safety.text.hashGuarded).toContain('hash-guarded');
    expect(checkpoints.safety.text.conflictsSkippedByDefault).toContain('skipped by default');
    expect(checkpoints.safety.text.forceOverwritesConflicts).toContain('--force is destructive');
    expect(checkpoints.safety.text.forceOverwritesConflicts).toContain('overwrites conflicts');
    expect(checkpoints.safety.text.partialRestoreExpected).toContain('Partial restore is expected');
    expect(checkpoints.safety.text.excludedPaths).toContain('.splitbrief/');
  });
});
