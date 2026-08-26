import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKPOINT_RESTORE_SAFETY } from '../../../snapshots/checkpoint-summary.js';
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

    expect(checkpoints.safety).toEqual(CHECKPOINT_RESTORE_SAFETY);
    expect(checkpoints.safety.excludedPaths).not.toBe(CHECKPOINT_RESTORE_SAFETY.excludedPaths);
    expect(missing).toContain('snapshots/run-ledger.json');
  });
});
