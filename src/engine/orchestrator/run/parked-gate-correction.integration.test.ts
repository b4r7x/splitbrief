import { plainUserMessage } from '../../../core/types/user-input.js';

import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { makeCallbacks, makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import { PLAN_FILE, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { PlanSchema } from '../../../core/schemas/plan.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { writePlanJson } from '../../../core/sessions/plan-file.js';
import type { OrchestratorCallbacks } from '../types.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { readMessages } from '../../../core/sessions/log-reader.js';
import { formatPlanMarkdown } from '../../spec/plan-markdown.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { createContinuationHolder } from '../continuation.js';
import { resumeParkedApproval } from './resume-parked-approval.js';

const CORRECTION = 'Use the cached parser and cover invalid input';
let projectDir = '';
afterEach(() => cleanupTempDir(projectDir));

/** A run parked at its plan card, with the correction the operator typed at it recorded once. */
function setup(steer: string | undefined = CORRECTION) {
  projectDir = createTempDir('parked-gate-correction');
  const sessionId = 'correction';
  const ref = { projectDir, sessionId };
  ensureSessionDir(projectDir, sessionId);
  const proposal = makePlanProposal();
  writePlanJson(ref, proposal);
  writeFileSync(
    join(sessionDir(projectDir, sessionId), PLAN_FILE),
    formatPlanMarkdown(proposal, []),
  );
  const phase = 'reviewing-plan';
  const state: WorkflowState = {
    ...createInitialState('add parsing'),
    phase,
    mode: 'standard',
    approve: 'plan',
    plan: PlanSchema.parse(proposal),
    tasks: proposal.tasks.map((spec) => taskFromSpec(spec, projectDir)),
  };
  if (steer?.trim()) appendMessage(ref, { role: 'user', phase, text: steer.trim() });
  const continuation = createContinuationHolder({
    step: { kind: 'gate', gate: 'plan' },
    steer: steer === undefined ? undefined : plainUserMessage(steer),
  });
  const typed = scriptedTypedCall([
    makePlanProposal({ summary: 'Use the cached parser' }),
    makePlanProposal({ summary: 'Use the cached parser for blank input too' }),
  ]);
  const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>(async () => ({
    approved: false,
    action: 'end-run',
  }));
  const wctx = makeWctx({
    ...ref,
    config: makeConfig({
      codebase: { enabled: false, tokenBudget: 4000 },
      workflow: { approve: 'plan' },
    }),
    planner: makePlanner({ typedCall: typed.typedCall }),
    callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
    continuation,
  });
  const run = () =>
    resumeParkedApproval({
      wctx,
      state,
      setTrackedState: () => {},
      phaseTimings: {},
      startTime: Date.now(),
    });
  return { ref, wctx, run, prompts: typed.prompts, onApprovalNeeded, continuation };
}

async function userMessages(ref: { projectDir: string; sessionId: string }): Promise<string[]> {
  const texts: string[] = [];
  for await (const message of readMessages(ref)) {
    if (message.role === 'user') texts.push(message.text);
  }
  return texts;
}

it('applies a parked plan correction before reopening the card and records it once', async () => {
  const fixture = setup();
  await fixture.run();
  expect(fixture.prompts).toHaveLength(1);
  expect(fixture.prompts[0]).toContain(CORRECTION);
  expect(fixture.onApprovalNeeded).toHaveBeenCalledTimes(1);
  expect(fixture.onApprovalNeeded.mock.calls[0]?.[0]).toBe('plan');
  expect(fixture.continuation.take({ kind: 'gate', gate: 'plan' })).toBeUndefined();
  expect(await userMessages(fixture.ref)).toEqual([CORRECTION]);
});

it.each([undefined, '', '   '])(
  'a bare continuation reopens the card without a planner call (%s)',
  async (steer) => {
    const fixture = setup('');
    fixture.wctx.continuation = createContinuationHolder({
      step: { kind: 'gate', gate: 'plan' },
      steer: steer === undefined ? undefined : plainUserMessage(steer),
    });
    await fixture.run();
    expect(fixture.prompts).toEqual([]);
    expect(fixture.onApprovalNeeded).toHaveBeenCalledTimes(1);
  },
);

it('consumes the correction once, then records a later live revision normally', async () => {
  const fixture = setup();
  fixture.onApprovalNeeded.mockResolvedValueOnce({
    approved: false,
    action: 'revise',
    message: plainUserMessage('Also cover blank input'),
  });
  await fixture.run();
  expect(fixture.prompts).toHaveLength(2);
  expect(fixture.prompts[0]).toContain(CORRECTION);
  expect(fixture.prompts[1]).toContain('Also cover blank input');
  expect(await userMessages(fixture.ref)).toEqual([CORRECTION, 'Also cover blank input']);
});

it('does not consume a correction owned by another step', async () => {
  const fixture = setup('');
  fixture.wctx.continuation = createContinuationHolder({
    step: { kind: 'gate', gate: 'briefs' },
    steer: plainUserMessage(CORRECTION),
  });
  await fixture.run();
  expect(fixture.prompts).toEqual([]);
  expect(fixture.wctx.continuation.take({ kind: 'gate', gate: 'briefs' })).toEqual({
    steer: plainUserMessage(CORRECTION),
  });
});
