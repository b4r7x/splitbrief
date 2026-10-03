import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKPOINT_RESTORE_SAFETY } from '../../../snapshots/checkpoint-summary.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readBriefQuality, readCheckpoints } from './artifacts.js';

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

describe('readBriefQuality', () => {
  it('reads a run without brief-quality.json as having nothing missing', () => {
    const missing: string[] = [];

    expect(readBriefQuality(tmp, 'sess-01', missing)).toBeNull();
    expect(missing).toEqual([]);
  });

  it("names an old run's malformed brief-quality.json as missing", () => {
    const dir = join(tmp, '.splitbrief', 'sessions', 'sess-01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'brief-quality.json'), '{"version":1}');
    const missing: string[] = [];

    expect(readBriefQuality(tmp, 'sess-01', missing)).toBeNull();
    expect(missing).toEqual(['brief-quality.json']);
  });
});
