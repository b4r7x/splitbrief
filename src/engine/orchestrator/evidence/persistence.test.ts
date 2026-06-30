import { describe, expect, it } from 'vitest';
import {
  createEvidenceLedger,
  writeEvidenceLedger,
  readEvidenceLedger,
} from '../../../core/evidence/ledger.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { setupEvidenceTmpDir } from '#testing/helpers/evidence-test-setup.js';

const tmpDir = setupEvidenceTmpDir();

describe('write / read EvidenceLedger', () => {
  it('round-trips through filesystem', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' }, ledger);
    const read = readEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'sess-1' });
    expect(read).not.toBeNull();
    expect(read?.sessionId).toBe('sess-1');
  });

  it('returns null for missing file', () => {
    expect(readEvidenceLedger({ projectDir: tmpDir.get(), sessionId: 'nonexistent' })).toBeNull();
  });
});
