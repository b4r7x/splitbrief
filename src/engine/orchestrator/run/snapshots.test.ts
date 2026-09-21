import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { readRunSnapshotLedger } from '../../snapshots/run/ledger.js';
import { acceptRunSnapshot, rejectRunSnapshot } from '../../snapshots/run/lifecycle.js';
import { listSnapshots } from '../../snapshots/manifest.js';
import { ensureRunBaselineSnapshot, recordRunSnapshotForRun } from './snapshots.js';

const sessionId = 'sess-run-snapshots';
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'splitbrief-run-snapshots-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function captureBaseline(): Promise<void> {
  const { bus } = makeBusRecorder();
  await ensureRunBaselineSnapshot({ projectDir: tmp, sessionId, bus, phase: 'implementing' });
}

async function recordRun(): Promise<void> {
  const { bus } = makeBusRecorder();
  await recordRunSnapshotForRun({ projectDir: tmp, sessionId, bus, phase: 'final-review' });
}

describe('ensureRunBaselineSnapshot', () => {
  it('captures the baseline once per run', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'baseline');
    const first = makeBusRecorder();
    await ensureRunBaselineSnapshot({
      projectDir: tmp,
      sessionId,
      bus: first.bus,
      phase: 'implementing',
    });
    expect(first.events.filter((event) => event.type === 'snapshot_created')).toHaveLength(1);

    await writeFile(join(tmp, 'feature.ts'), 'implementer wrote this');
    const second = makeBusRecorder();
    await ensureRunBaselineSnapshot({
      projectDir: tmp,
      sessionId,
      bus: second.bus,
      phase: 'implementing',
    });

    // Re-entry (resume, rewind) must not re-baseline onto the implementer's work.
    expect(second.events.filter((event) => event.type === 'snapshot_created')).toHaveLength(0);
    expect((await listSnapshots(tmp, sessionId)).manifests).toHaveLength(0);
  });

  it('warns instead of failing the run when the snapshot cannot be written', async () => {
    await writeFile(join(tmp, 'blocker'), 'a file where the project dir should be');
    const { bus, events } = makeBusRecorder();

    await expect(
      ensureRunBaselineSnapshot({
        projectDir: join(tmp, 'blocker'),
        sessionId,
        bus,
        phase: 'implementing',
      }),
    ).resolves.toBeUndefined();

    const warning = events.find((event) => event.type === 'warning');
    expect(warning?.type === 'warning' && warning.message).toContain('snapshot (run-baseline)');
  });
});

describe('recordRunSnapshotForRun', () => {
  it('records exactly one non-accepted run snapshot in the ledger', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'baseline');
    await captureBaseline();
    await writeFile(join(tmp, 'feature.ts'), 'implementer wrote this');

    await recordRun();

    const ledger = await readRunSnapshotLedger(tmp, sessionId);
    expect(ledger?.runSnapshotIds).toHaveLength(1);
    expect(ledger?.accepted).toBe(false);
    expect(ledger?.rejected).toBe(false);
    const recordedId = ledger?.runSnapshotIds[0] ?? '';
    expect(ledger?.runSnapshotKinds?.[recordedId]).toBe('pre-final-review');
  });

  it('lets /run reject restore the baseline the run started from', async () => {
    await writeFile(join(tmp, 'kept.ts'), 'kept');
    await writeFile(join(tmp, 'edited.ts'), 'baseline');
    await captureBaseline();

    await writeFile(join(tmp, 'edited.ts'), 'implementer wrote this');
    await writeFile(join(tmp, 'created.ts'), 'implementer created this');
    await recordRun();

    const result = await rejectRunSnapshot(tmp, sessionId);

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.restoredPaths).toEqual(['edited.ts']);
    expect(result.deletedPaths).toEqual(['created.ts']);
    expect(result.conflictedPaths).toEqual([]);
    expect(result.missingSnapshotFiles).toEqual([]);
    await expect(readFile(join(tmp, 'edited.ts'), 'utf-8')).resolves.toBe('baseline');
    await expect(readFile(join(tmp, 'kept.ts'), 'utf-8')).resolves.toBe('kept');
  });

  it('leaves an accepted run sealed against rejection', async () => {
    await writeFile(join(tmp, 'edited.ts'), 'baseline');
    await captureBaseline();
    await writeFile(join(tmp, 'edited.ts'), 'implementer wrote this');
    await recordRun();

    await acceptRunSnapshot(tmp, sessionId);
    const result = await rejectRunSnapshot(tmp, sessionId);

    expect(result.status).toBe('accepted');
    await expect(readFile(join(tmp, 'edited.ts'), 'utf-8')).resolves.toBe('implementer wrote this');
  });
});
