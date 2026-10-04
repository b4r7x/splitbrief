import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readEvidenceLedger,
  writeEvidenceLedger,
} from '../../../src/core/evidence/ledger-storage.js';
import { captureBundleBaseline } from '../../../src/engine/implementers/bundle-baseline.js';
import { applyFileBundle } from '../../../src/engine/implementers/apply-file-bundle.js';
import {
  recordPromotedFilesEvidence,
  recordedTargetOutput,
} from '../../../src/engine/orchestrator/evidence/task.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import {
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  freezeDir,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  thawDir,
  writeApiReceipt,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('direct API receipt limits', () => {
  it('records a real partial API prefix and keeps the failed target unowned', async () => {
    const { projectDir, task: initial } = createTargetWriteProject();
    const second = 'src/nested/later.ts';
    const task = { ...initial, files: [TARGET_WRITE_FILE, second] };
    mkdirSync(join(projectDir, 'src', 'nested'), { recursive: true });
    writeFileSync(join(projectDir, second), 'unchanged');
    const captured = await captureBundleBaseline({ projectDir, task });
    if (captured.kind !== 'captured') throw new Error(captured.error);
    // The second target's directory refuses the write the way a full disk does.
    freezeDir(join(projectDir, 'src', 'nested'));
    let result: Awaited<ReturnType<typeof applyFileBundle>>;
    try {
      result = await applyFileBundle({
        projectDir,
        callId: 'partial-f3',
        baselines: captured.baselines,
        candidates: [
          { path: TARGET_WRITE_FILE, action: 'modify', content: 'worker' },
          { path: second, action: 'modify', content: 'later-worker' },
        ],
        noops: [],
      });
    } finally {
      thawDir(join(projectDir, 'src', 'nested'));
    }
    expect(result.status).toBe('partial');
    writeApiReceipt({ projectDir, task, result });
    expect(
      recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, task).files,
    ).toEqual([{ path: TARGET_WRITE_FILE, sha256: sha256Hex('worker'), mode: 0o644 }]);
    expect(readFileSync(join(projectDir, second), 'utf8')).toBe('unchanged');
  });

  it('does not revive untouched receipts when a revised brief writes another file', () => {
    const { projectDir, task } = createTargetWriteProject();
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    const revised = { ...task, description: 'New brief definition' };
    const ledger = readEvidenceLedger({ projectDir, sessionId: TARGET_WRITE_SESSION_ID });
    if (ledger === null) throw new Error('missing ledger');
    writeEvidenceLedger(
      { projectDir, sessionId: TARGET_WRITE_SESSION_ID },
      recordPromotedFilesEvidence({
        ledger,
        task: revised,
        files: [{ path: 'src/other.ts', sha256: sha256Hex('new-worker'), mode: 0o644 }],
      }),
    );
    expect(
      recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, revised).files.map(
        (file) => file.path,
      ),
    ).toEqual(['src/other.ts']);
  });
});
