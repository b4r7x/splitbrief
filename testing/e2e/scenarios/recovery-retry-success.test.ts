import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { evaluateTsArtifact } from '../helpers/artifact-assertions.js';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';
import {
  cli,
  createStopContinueFixture,
  escapingImplementerScript,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const scenario = {
  name: 'recovery - task fails then retries successfully',
  cassetteName: 'recovery-retry-success',
  feature: 'add validation to form handler',
  config: makeE2eScenarioConfig(),
};

describe('e2e: recovery retry success', () => {
  const ctx = setupE2eScenario(scenario);

  it('retries failed task and eventually completes', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const retryEvents = ctx.events.filter((event) => event.type === 'task_retry');
    const taskCompleted = ctx.events.filter((event) => event.type === 'task_completed');

    expect(retryEvents.length).toBeGreaterThan(0);
    expect(taskCompleted.length).toBeGreaterThan(0);
    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
    const validationPath = join(ctx.projectDir, 'src/form-validation.ts');
    expect(
      evaluateTsArtifact(validationPath, "mod.validateForm({ email: 'ada@example.com' })"),
    ).toEqual({ valid: true, errors: [] });
    expect(evaluateTsArtifact(validationPath, "mod.validateForm({ email: 'broken' }).valid")).toBe(
      false,
    );
  });
});

describe('e2e: recorded recovery headline', () => {
  let fixture: StopContinueFixture | undefined;

  afterEach(() => {
    if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
    fixture = undefined;
  });

  it('records the recovery headline in session.jsonl before a successful retry', async () => {
    const target = createStopContinueFixture(escapingImplementerScript);
    fixture = target;
    const halted = await cli(target, ['start', 'smoke']);
    expect(halted.exitCode, halted.stderr).toBe(1);
    const sessionId = readActive(fixture.projectDir);
    if (sessionId === null) throw new Error('The halted run saved no session');
    const issue = readState(fixture, sessionId).pendingRecovery;
    expect(issue?.reason).toBe('checkout-changed');
    expect(issue?.seat).toBe('build');

    const { events } = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
    const prompted = events.filter((event) => event.type === 'recovery_prompted');
    expect(prompted).toHaveLength(1);
    expect(prompted[0]).toMatchObject({
      issueId: issue?.id,
      reason: 'checkout-changed',
      headlineSpans: [{ text: expect.stringContaining('Repository changed under T001') }],
    });
    expect(prompted[0]).not.toHaveProperty('seat');
    expect(prompted[0]?.headlineSpans?.map((part) => part.text).join('')).toBe(
      prompted[0]?.headline,
    );

    const continued = await cli(target, ['continue', sessionId, '--action', 'retry']);
    expect(continued.exitCode, continued.stderr).toBe(0);
    expect(continued.stdout).toContain('task T001: done');
  });
});
