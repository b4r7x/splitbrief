import { afterEach, expect, it } from 'vitest';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readSession } from '../../../src/core/sessions/io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  escapingImplementerScript,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  resetWorkflow();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

it('ends after skipping the only brief and keeps Skip brief as one Recovery row', async () => {
  fixture = createStopContinueFixture(escapingImplementerScript);
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, halted.stderr).toBe(1);
  const sessionId = readActive(fixture.projectDir);
  if (sessionId === null) throw new Error('The halted run saved no session');
  expect(readState(fixture, sessionId).pendingRecovery?.reason).toBe('checkout-changed');

  const skipped = await cli(fixture, ['continue', sessionId, '--action', 'skip']);
  expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);

  const ref = { projectDir: fixture.projectDir, sessionId };
  const notice = 'All briefs were skipped, so nothing was built. The run ended without changes.';
  expect.soft(`${skipped.stdout}\n${skipped.stderr}`).toContain(notice);
  expect.soft(readSession(ref)?.status).toBe('ended');
  expect.soft(readState(fixture, sessionId).closed).toMatchObject({ as: 'ended' });
  expect.soft(readActive(ref.projectDir)).toBeNull();
  const { events } = await readRunEvents(ref);
  expect.soft(events.some((event) => event.phase === 'final-review')).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'info', message: notice }));
  expect(events.find((event) => event.type === 'recovery_resolved')).toMatchObject({
    outcome: 'skipped-current-task',
  });
  const transcript = transcriptText(events);
  expect.soft(transcript).toContain('All briefs were skipped, so nothing was built.');
  expect(transcript.match(/Recovery {2}/g)).toHaveLength(1);
  expect(transcript.split('\n').find((line) => line.includes('Recovery  Skip brief'))).toContain(
    'skipped',
  );
});
