import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewPacketJsonPath, reviewPacketMarkdownPath } from '../../../src/core/paths.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review/packet.js';
import { readSessionSummary } from '../../../src/core/sessions/run/record-io.js';
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

async function haltOnFailedConsult(planned = plan, options?: { retryBeforeHalt?: boolean }) {
  ({ fixture, restorePath } = consultFailureHaltFixture(planned, options));
  return { target: fixture, sessionId: await startToHalt(fixture) };
}

describe('e2e: Skip on a planner-call halt', () => {
  it('leaves no brief file behind, so the review and the record do not carry it', async () => {
    const { target, sessionId } = await haltOnFailedConsult(plan, { retryBeforeHalt: true });
    const halted = readState(target, sessionId);
    expect(halted.pendingRecovery).toMatchObject({ reason: 'planner-call-failed', taskId: 'T001' });
    const workspaceDir = halted.workspace?.path ?? target.projectDir;
    // The ladder halt after a failed check keeps the brief's file; Skip takes it back.
    expect(existsSync(join(workspaceDir, ALPHA_FILE))).toBe(true);

    const skipped = await cli(target, ['continue', sessionId, '--plain', '--action', 'skip']);

    expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);
    const ref = { projectDir: target.projectDir, sessionId };
    expect(readState(target, sessionId).tasks[0]?.status).toBe('skipped');
    expect(existsSync(join(workspaceDir, ALPHA_FILE))).toBe(false);
    const summary = readSessionSummary(ref);
    expect(summary).toBeDefined();
    expect(summary?.changedFiles).not.toContain(ALPHA_FILE);
    expect
      .soft(summary?.taskBreakdown)
      .toMatchObject([{ taskId: 'T001', method: 'skipped', retryCount: 1 }]);
    const { events } = await readRunEvents(ref);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringMatching(
          /^Restored 1 change of the failing brief to its start: src\/alpha\.mjs/,
        ),
      }),
    );
    const lines = transcriptText(events).split('\n');
    const recoveryRows = lines.filter((line) => line.includes('Recovery  '));
    // No row comes between the halt and Skip, so one Recovery row names both.
    expect(recoveryRows).toHaveLength(1);
    expect(recoveryRows[0]).toMatch(/Planner call failed.*Skip task.*skipped\s*$/);
    const restoredAt = lines.findIndex((line) =>
      line.includes('Restored 1 change of the failing brief'),
    );
    expect(restoredAt).toBeGreaterThan(lines.indexOf(recoveryRows[0] ?? ''));
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
    const ref = { projectDir: target.projectDir, sessionId };
    const { events } = await readRunEvents(ref);
    const lines = transcriptText(events).split('\n');
    const recoveryRows = lines.filter((line) => line.includes('Recovery  '));
    expect(recoveryRows).toHaveLength(2);
    expect(recoveryRows[0]).toMatch(/Planner call failed.*Skip task.*skipped\s*$/);
    expect(recoveryRows[1]).toMatch(/Dependency blocked.*Skip task.*skipped\s*$/);
    const settledT002 = lines.findIndex((line) => /T002 Add the beta value .*skipped/.test(line));
    expect(settledT002).toBeGreaterThan(lines.indexOf(recoveryRows[0] ?? ''));
    expect(lines.indexOf(recoveryRows[1] ?? '')).toBeGreaterThan(settledT002);

    const packet = ReviewPacketSchema.parse(
      JSON.parse(readFileSync(reviewPacketJsonPath(ref), 'utf8')),
    );
    expect
      .soft(packet.routing.taskRouting)
      .toMatchObject([
        { taskId: 'T001', method: 'skipped', tool: 'agent', kind: 'agent', retryCount: 0 },
      ]);
    const markdown = readFileSync(reviewPacketMarkdownPath(ref), 'utf8');
    const routing = markdown.split('## Routing\n')[1]?.split('\n## ')[0];
    expect.soft(routing).toContain('- Per-task routing entries: 1');
    expect.soft(routing).toMatch(/^- T001: Agent · Fixture\b/m);
    expect(routing).not.toMatch(/^- T002:/m);
  });
});
