import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  endImplementerHold,
  MARKER_FILE,
  MARKER_SOURCE,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(async () => {
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

describe('e2e: End run after a checkout run process died inside a brief', {
  timeout: 240_000,
}, () => {
  it('books the files the brief left in the checkout', async () => {
    fixture = createStopContinueFixture(undefined, { isolation: 'none' });
    const target = fixture;

    const killed = await startAndSignal(target, 'SIGKILL', target.projectDir);

    expect(killed.exitCode).toBeNull();
    expect(readFileSync(target.markerPath, 'utf-8')).toBe(MARKER_SOURCE);
    const ref = { projectDir: target.projectDir, sessionId: killed.sessionId };

    const ended = await cli(target, ['continue', killed.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, `${ended.stdout}\n${ended.stderr}`).toBe(0);
    expect(loadState(ref)?.closed?.as).toBe('ended');
    expect(readFileSync(target.markerPath, 'utf-8')).toBe(MARKER_SOURCE);
    expect(readEvidenceLedger(ref)?.tasks.find((task) => task.id === 'T001')).toMatchObject({
      status: 'in_progress',
      changedFiles: [MARKER_FILE],
    });
    const view = deriveSummaryView({ record: readRunRecord(ref) });
    if (view === null) throw new Error('the ended run left no closed view');
    expect(view.files.changed).toEqual([MARKER_FILE]);
  });
});
