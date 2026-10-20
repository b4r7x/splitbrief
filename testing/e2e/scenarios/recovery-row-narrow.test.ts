import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  decisionConfirmHaltFixture,
  dependentPlan,
  startToHalt,
} from '../helpers/decision-confirm-halt.js';
import { cli, readState, type StopContinueFixture } from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

beforeEach(() => resetAllStores());

afterEach(() => {
  resetAllStores();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

it('keeps the arrow and the outcome of a Skip task Recovery row together at 60 columns', async () => {
  ({ fixture, restorePath } = decisionConfirmHaltFixture(dependentPlan));
  const sessionId = await startToHalt(fixture);
  const firstSkip = await cli(fixture, ['continue', sessionId, '--plain', '--action', 'skip']);
  expect(firstSkip.exitCode, `${firstSkip.stdout}\n${firstSkip.stderr}`).toBe(1);
  expect(readState(fixture, sessionId).pendingRecovery?.reason).toBe('dependency-blocked');

  const secondSkip = await cli(fixture, ['continue', sessionId, '--plain', '--action', 'skip']);

  expect(secondSkip.exitCode, `${secondSkip.stdout}\n${secondSkip.stderr}`).toBe(0);
  const { events } = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
  const lines = transcriptText(events, 60)
    .split('\n')
    .map((line) => line.trimEnd());
  const recoveryAt = lines.findIndex((line) => line.includes('Recovery  Dependency blocked'));
  expect(recoveryAt).toBeGreaterThan(-1);
  expect(lines[recoveryAt]).toMatch(/Skip task$/);
  expect(lines[recoveryAt + 1]?.trim()).toMatch(/^\S+ skipped$/);
});
