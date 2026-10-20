import { afterEach, expect, it } from 'vitest';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { factSpans, runRows } from '../../../src/features/workflow/closed/copy.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

/** The whole seconds a closed row spells, as `formatTime` writes them (`1h 2m 3s`, `2m 10s`, `9s`). */
function shownSeconds(text: string): number {
  const units = { h: 3600, m: 60, s: 1 } as const;
  return [...text.matchAll(/(\d+)([hms])/g)].reduce(
    (sum, [, value, unit]) => sum + Number(value) * units[unit as keyof typeof units],
    0,
  );
}

afterEach(async () => {
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

it('counts planning and the whole brief in the closed Phases row after a stop and a Continue, and its parts add up to Ran', {
  timeout: 240_000,
}, async () => {
  fixture = createStopContinueFixture(undefined, { isolation: 'none' });
  const target = fixture;
  const stopped = await startAndSignal(target, 'SIGINT', target.projectDir);
  expect(stopped.exitCode).toBe(0);
  const continued = await continueRun(target);
  expect(continued.exitCode, continued.stderr).toBe(0);

  const ref = { projectDir: target.projectDir, sessionId: stopped.sessionId };
  const record = readRunRecord(ref);
  const view = deriveSummaryView({ record });
  if (view === null) throw new Error(`The run did not close: ${record.status.kind}`);
  const phases = runRows(view).find((row) => row.label === 'Phases');
  const rowText = phases?.segments.flatMap((fact) => factSpans(fact).map((span) => span.text));
  expect(rowText?.[0]).toMatch(/^planning /);
  const ran = runRows(view).find((row) => row.label === 'Ran');
  const ranText = ran?.segments.flatMap((fact) => factSpans(fact).map((span) => span.text)) ?? [];
  const parts = (rowText ?? []).map((text) => shownSeconds(text.replace(/^\S+ /, '')));
  expect(parts.reduce((sum, value) => sum + value, 0)).toBe(shownSeconds(ranText.join('')));

  const { events } = await readRunEvents(ref);
  const completed = events.find((event) => event.type === 'task_completed');
  if (completed?.type !== 'task_completed') throw new Error('The brief never completed');
  const timings = record.summary?.phaseTimings ?? {};
  expect(timings.implementing).toBeGreaterThanOrEqual(completed.duration);
  expect(timings.review).toBeGreaterThan(0);
  const phaseSum = Object.values(timings).reduce((sum, ms) => sum + ms, 0);
  expect(phaseSum).toBe(record.summary?.activeTime);
});
