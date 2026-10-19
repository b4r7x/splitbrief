import { afterEach, expect, it } from 'vitest';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
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

it('shows Skip task on the last brief as one Recovery row with its outcome', async () => {
  fixture = createStopContinueFixture(escapingImplementerScript);
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, halted.stderr).toBe(1);
  const sessionId = readActive(fixture.projectDir);
  if (sessionId === null) throw new Error('The halted run saved no session');
  expect(readState(fixture, sessionId).pendingRecovery?.reason).toBe('checkout-changed');

  const skipped = await cli(fixture, ['continue', sessionId, '--action', 'skip']);
  expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);

  const { events } = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
  expect(events.find((event) => event.type === 'recovery_resolved')).toMatchObject({
    outcome: 'skipped-current-task',
  });
  const transcript = transcriptText(events);
  expect(transcript.match(/Recovery {2}/g)).toHaveLength(1);
  expect(transcript.split('\n').find((line) => line.includes('Recovery  Skip task'))).toContain(
    'skipped',
  );
});
