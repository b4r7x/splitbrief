import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionSummary } from '../../../src/core/sessions/run-record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  ALPHA_FILE,
  consultFailureHaltFixture,
  dependentPlan,
  plan,
  startToHalt,
} from '../helpers/consult-failure-halt.js';
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

async function haltOnFailedConsult(planned = plan) {
  ({ fixture, restorePath } = consultFailureHaltFixture(planned));
  return { target: fixture, sessionId: await startToHalt(fixture) };
}

describe('e2e: Skip on a planner-call halt', () => {
  it('leaves no brief file behind, so the review and the record do not carry it', async () => {
    const { target, sessionId } = await haltOnFailedConsult();
    const halted = readState(target, sessionId);
    expect(halted.pendingRecovery).toMatchObject({ reason: 'planner-call-failed', taskId: 'T001' });
    const workspaceDir = halted.workspace?.path ?? target.projectDir;
    // The ladder halt after a failed check takes the brief's file back at once.
    expect(existsSync(join(workspaceDir, ALPHA_FILE))).toBe(false);

    const skipped = await cli(target, ['continue', sessionId, '--plain', '--action', 'skip']);

    expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);
    const ref = { projectDir: target.projectDir, sessionId };
    expect(readState(target, sessionId).tasks[0]?.status).toBe('skipped');
    expect(existsSync(join(workspaceDir, ALPHA_FILE))).toBe(false);
    const summary = readSessionSummary(ref);
    expect(summary).toBeDefined();
    expect(summary?.changedFiles).not.toContain(ALPHA_FILE);
    const { events } = await readRunEvents(ref);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringMatching(
          /^Restored 1 failing task change to the pre-task state: src\/alpha\.mjs/,
        ),
      }),
    );
    const lines = transcriptText(events).split('\n');
    const recoveryRows = lines.filter((line) => line.includes('Recovery  '));
    expect(recoveryRows).toHaveLength(2);
    expect(recoveryRows[0]).toMatch(/Planner call failed\s*$/);
    expect(recoveryRows[1]).toMatch(/Skip task.*skipped\s*$/);
    const restoredAt = lines.findIndex((line) => line.includes('Restored 1 failing task change'));
    expect(restoredAt).toBeGreaterThan(lines.indexOf(recoveryRows[0] ?? ''));
    expect(lines.indexOf(recoveryRows[1] ?? '')).toBeGreaterThan(restoredAt);
  });

  it('shows Skip task on the dependency halt of the next brief as one Recovery row', async () => {
    const { target, sessionId } = await haltOnFailedConsult(dependentPlan);
    const firstSkip = await cli(target, ['continue', sessionId, '--plain', '--action', 'skip']);
    expect(firstSkip.exitCode, `${firstSkip.stdout}\n${firstSkip.stderr}`).toBe(1);
    expect(readState(target, sessionId).pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
    });

    const secondSkip = await cli(target, ['continue', sessionId, '--plain', '--action', 'skip']);

    expect(secondSkip.exitCode, `${secondSkip.stdout}\n${secondSkip.stderr}`).toBe(0);
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    const lines = transcriptText(events).split('\n');
    const recoveryRows = lines.filter((line) => line.includes('Recovery  '));
    expect(recoveryRows).toHaveLength(3);
    expect(recoveryRows[2]).toMatch(/Dependency blocked.*Skip task.*skipped\s*$/);
    const settledT002 = lines.findIndex((line) => /T002 Add the beta value .*skipped/.test(line));
    expect(settledT002).toBeGreaterThan(lines.indexOf(recoveryRows[1] ?? ''));
    expect(lines.indexOf(recoveryRows[2] ?? '')).toBeGreaterThan(settledT002);
  });
});
