import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readReviewChanges } from '../../../src/core/evidence/review-changes.js';
import { SESSIONS_DIR, SPLITBRIEF_DIR, sessionDir } from '../../../src/core/paths.js';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';
import { cli } from '../helpers/stop-continue-fixture.js';

const DoctorRecordSchema = z.object({
  type: z.literal('readiness_report'),
  report: z.object({
    checks: z.array(z.object({ id: z.string(), details: z.array(z.string()).optional() })),
  }),
});

// The trivial-edit exchange, run in the checkout itself: the planner and the
// implementer answer exactly as they do in a worktree run.
const scenario = {
  name: 'checkout mode - trivial edit in the checkout',
  cassetteName: 'quick-trivial-edit',
  feature: 'fix typo in README',
  config: makeE2eScenarioConfig({ workflow: { isolation: 'none' } }),
};
const FIXED = '# SPLITBRIEF\n\nA small fixture project for e2e replay.';

describe('e2e: the checkout mode edits the checkout and closes on its passing review', () => {
  const ctx = setupE2eScenario(scenario);

  it('changes the checkout during the run and closes with no Apply step', async () => {
    writeFileSync(
      join(ctx.projectDir, 'README'),
      '# SPLITBRIEF\n\nA small fixure project for e2e replay.\n',
      'utf-8',
    );
    const doctor = await cli(
      { projectDir: ctx.projectDir, stateHome: join(homedir(), 'state') },
      ['doctor'],
      { json: true, timeoutMs: 30_000 },
    );
    expect(doctor.stdout, doctor.stderr).not.toBe('');
    const readiness = DoctorRecordSchema.parse(JSON.parse(doctor.stdout.trim()));
    expect(
      readiness.report.checks.find((check) => check.id === 'runners.implementer.default')?.details,
    ).toEqual(['SPLITBRIEF applies the edits BUILD returns to this checkout.']);
    let readmeAtTaskCompleted: string | undefined;

    const summary = await runE2eWorkflow(ctx, scenario, (event) => {
      if (event.type === 'task_completed') {
        readmeAtTaskCompleted = readFileSync(join(ctx.projectDir, 'README.md'), 'utf-8');
      }
    });

    expect(summary.totalTasks).toBe(1);
    expect(readmeAtTaskCompleted).toBe(FIXED);
    expect(readFileSync(join(ctx.projectDir, 'README.md'), 'utf-8')).toBe(FIXED);
    expect(ctx.events.some((event) => event.type === 'workflow_complete')).toBe(true);

    const [sessionId = ''] = readdirSync(join(ctx.projectDir, SPLITBRIEF_DIR, SESSIONS_DIR), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const state = loadState({ projectDir: ctx.projectDir, sessionId });
    expect(state?.workspace?.kind).toBe('checkout');
    expect(state?.applied).toBeUndefined();
    expect(state && deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
      kind: 'closed',
      as: 'complete',
    });
    expect(existsSync(join(sessionDir(ctx.projectDir, sessionId), 'run.patch'))).toBe(false);
    // The accepted brief is on the review record, read from the checkout it edited.
    expect(
      readReviewChanges({ projectDir: ctx.projectDir, sessionId })?.changes.map(
        (change) => change.path,
      ),
    ).toContain('README.md');
  });
});
