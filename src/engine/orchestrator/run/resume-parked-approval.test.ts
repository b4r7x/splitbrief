import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import { makeCallbacks, makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { resumeParkedApproval } from './resume-parked-approval.js';

let projectDir = '';
afterEach(() => cleanupTempDir(projectDir));

it('rechecks an edited parked spec before generating its plan or briefs', async () => {
  projectDir = createTempDir('parked-spec-approval');
  const sessionId = 'sess-parked-spec';
  ensureSessionDir(projectDir, sessionId);
  const dir = sessionDir(projectDir, sessionId);
  mkdirSync(join(projectDir, '.specify', 'memory'), { recursive: true });
  writeFileSync(join(projectDir, '.specify', 'memory', 'constitution.md'), '# One slice only\n');
  for (const file of [RESEARCH_FILE, SPEC_FILE, CLARIFICATIONS_FILE, PLAN_FILE, TASKS_FILE]) {
    writeFileSync(join(dir, file), '# Old artifact\n');
  }
  writeFileSync(join(dir, CONSTITUTION_CHECK_FILE), '{"passed":true,"violations":[]}');
  const calls: string[] = [];
  const reviews: string[] = [];
  const planner = makePlanner({
    runPhase: async ({ call }) => {
      calls.push(call);
      return makePhaseCallResult({ call });
    },
    review: async (prompt) => {
      reviews.push(prompt);
      return {
        text: JSON.stringify({
          passed: false,
          violations: [{ principle: 'one-slice', reason: 'too broad', severity: 'hard' }],
        }),
        usage: null,
      };
    },
  });
  let approvals = 0;
  const state: WorkflowState = {
    ...createInitialState('feature'),
    phase: 'reviewing-spec',
    mode: 'speckit',
    approve: 'spec',
  };
  let tracked = state;
  const result = await resumeParkedApproval({
    wctx: makeWctx({
      projectDir,
      sessionId,
      planner,
      config: makeConfig({ workflow: { mode: 'speckit', approve: 'spec' } }),
      callbacks: makeCallbacks({
        onApprovalNeeded: async () => {
          approvals += 1;
          writeFileSync(join(dir, SPEC_FILE), '# Revised spec\n\nRequirement B\n');
          return { approved: true };
        },
      }).callbacks,
    }),
    state,
    setTrackedState: (next) => {
      tracked = next;
    },
    phaseTimings: {},
    startTime: Date.now(),
  });

  expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
  expect(tracked.phase).toBe('constitution-check');
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toContain('Requirement B');
  expect(calls).toEqual([]);
  expect(approvals).toBe(1);
  expect(readFileSync(join(dir, SPEC_FILE), 'utf8')).toContain('Requirement B');
  expect(JSON.parse(readFileSync(join(dir, CONSTITUTION_CHECK_FILE), 'utf8'))).toMatchObject({
    passed: false,
  });
  expect(existsSync(join(dir, PLAN_FILE))).toBe(false);
  expect(existsSync(join(dir, TASKS_FILE))).toBe(false);
});
