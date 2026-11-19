import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { readRunRecord } from '../../../src/core/sessions/run/record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  endImplementerHold,
  GREET_FILE,
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
  it('preserves and names files whose writer cannot be established after the crash', async () => {
    fixture = createStopContinueFixture(undefined, { isolation: 'none' });
    const target = fixture;

    const killed = await startAndSignal(target, 'SIGKILL', target.projectDir);

    expect(killed.exitCode).toBeNull();
    expect(readFileSync(target.markerPath, 'utf-8')).toBe(MARKER_SOURCE);
    const ref = { projectDir: target.projectDir, sessionId: killed.sessionId };
    writeFileSync(target.greetPath, 'user edits after the crash\n');

    const ended = await cli(target, ['continue', killed.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, `${ended.stdout}\n${ended.stderr}`).toBe(0);
    expect(loadState(ref)?.closed?.as).toBe('ended');
    expect(readFileSync(target.markerPath, 'utf-8')).toBe(MARKER_SOURCE);
    expect(readFileSync(target.greetPath, 'utf-8')).toBe('user edits after the crash\n');
    expect(ended.stderr).toContain(GREET_FILE);
    expect(ended.stderr).toContain(MARKER_FILE);
    expect(
      readEvidenceLedger(ref)?.tasks.find((task) => task.id === 'T001')?.changedFiles ?? [],
    ).toEqual([]);
    const view = deriveSummaryView({ record: readRunRecord(ref, false) });
    if (view === null) throw new Error('the ended run left no closed view');
    expect(view.files.changed).toEqual([]);
  });
});
