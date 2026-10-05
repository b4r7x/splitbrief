import { afterEach, describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  makeBusRecorder,
  makeCallbacks,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner, makeConfig } from '#testing/helpers/validation-fixtures.js';
import type { ReviewVerdict, TriageResult } from '../../core/schemas/review.js';
import { taskId } from '../../core/schemas/task.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import type { ReviewRecord, WorkflowState } from '../../core/schemas/workflow.js';
import type { Planner, TypedCallContext } from '../planners/types.js';
import type { TypedSeatCall } from '../runners/typed-output.js';
import { requestTriage, runTriage, triageContractErrors, type TriageContext } from './triage.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

const FAILING_FINDING = {
  id: 'F1',
  kind: 'defect' as const,
  severity: 'blocking' as const,
  taskId: 'T001',
  file: 'src/shared/widget.ts',
  line: 3,
  text: 'src/shared/widget.ts drops the error',
  acceptance: 'The error is rethrown',
  checkIds: null,
  criterionId: null,
};

const FAIL_VERDICT: ReviewVerdict = {
  tasks: [{ id: taskId('T001'), plan: 'met', note: '' }],
  criteria: [{ id: 'C1', status: 'pass', evidence: '' }],
  findings: [FAILING_FINDING],
};

function reviewRecord(): ReviewRecord {
  return {
    cycle: 0,
    verdict: FAIL_VERDICT,
    outcome: 'fail',
    verification: [
      { id: 'finding:F1', status: 'fail', output: 'K1: fail — the widget swallowed it' },
    ],
    at: '2026-10-04T10:00:00.000Z',
  };
}

function triageState(): WorkflowState {
  return {
    ...transition(createInitialState('Greet people'), { type: 'START' }),
    phase: 'final-review',
    tasks: [makeTask({ id: 'T001', status: 'done', batch: 1 })],
    currentTaskIndex: 1,
    fixCycles: { used: 0, allowance: 2, notes: [] },
    plan: {
      summary: 'Greet people by name',
      decisions: [{ text: 'Keep the greeting in one shared module', taskId: null }],
      criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] }],
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
      validation: null,
    },
    review: reviewRecord(),
  };
}

function fixTaskSpec(): TriageResult['fixTasks'][number] {
  return {
    ...makeTaskSpec({ id: 'T002', suggestedFiles: ['src/shared/widget.ts'] }),
    findingIds: ['F1'],
  };
}

function fixResult(): TriageResult {
  return { fixTasks: [fixTaskSpec()], rejected: [], verify: [], ask: null };
}

function triagePlanner(script: string[]): {
  planner: Pick<Planner, 'capabilities' | 'typedCall'>;
  prompts: string[];
} {
  const prompts: string[] = [];
  const typedCall = (ctx: TypedCallContext): TypedSeatCall => ({
    seat: ctx.seat,
    typedOutput: 'fallback',
    canResume: false,
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      const next = script.shift();
      if (next === undefined) throw new Error('the planner was asked once too often');
      return makeRunnerCallResult({
        status: 'completed',
        text: next,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  });
  return {
    planner: {
      capabilities: {
        supportsConversationalPlanning: false,
        supportsSessionResume: false,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      typedCall,
    },
    prompts,
  };
}

function contextFor(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  planner: Pick<Planner, 'capabilities' | 'typedCall'>,
  overrides: Partial<TriageContext> = {},
): { ctx: TriageContext; states: WorkflowState[] } {
  const { bus } = makeBusRecorder();
  const states: WorkflowState[] = [];
  return {
    ctx: {
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      config: makeConfig({}),
      planner,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_SINKS,
      state,
      onStateChange: (next) => states.push(next),
      ...overrides,
    },
    states,
  };
}

describe('requestTriage', () => {
  it('supplies the decisions, reviewed results and completed task checks', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    state.tasks[0]!.checks = [{ id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true }];
    state.tasks[0]!.checkResults = [{ id: 'K2', passed: false }];
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([JSON.stringify(fixResult())]);
    const { ctx } = contextFor(projectDir, sessionId, state, planner.planner);
    await requestTriage(ctx, { review: state.review!, inputs: [] });
    expect(planner.prompts[0]).toContain('Keep the greeting in one shared module');
    expect(planner.prompts[0]).toContain('"plan": "met"');
    expect(planner.prompts[0]).toContain('"status": "pass"');
    expect(planner.prompts[0]).toContain('K2');
    expect(planner.prompts[0]).toContain('"passed": false');
  });

  it('verifies a rewritten task check through the current run registry', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    state.tasks[0]!.checks = [{ id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true }];
    saveState({ projectDir, sessionId }, state);
    const runCommand = makeCommandRunner({ stdout: 'current task check', stderr: '', code: 0 });
    const planner = triagePlanner([
      JSON.stringify({
        fixTasks: [],
        rejected: [],
        verify: [{ findingId: 'F1', checkIds: ['K2'] }],
        ask: null,
      }),
    ]);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner, {
      runCommand,
    });
    expect(await requestTriage(ctx, { review: state.review!, inputs: [] })).toHaveProperty(
      'result',
    );
    expect(runCommand.calls).toHaveLength(1);
    expect(states.at(-1)?.triage?.[0]?.verification?.[0]?.output).toContain('current task check');
  });
  it('records the triage, counts the planner call and spends the usage', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([JSON.stringify(fixResult())]);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner);

    const result = await requestTriage(ctx, { review: state.review!, inputs: [] });

    expect('result' in result).toBe(true);
    const current = states.at(-1)!;
    expect(current.triage).toEqual([
      {
        cycle: 1,
        at: expect.any(String),
        reviewAt: state.review!.at,
        inputIds: ['F1'],
        result: fixResult(),
      },
    ]);
    expect(current.plannerCalls?.used).toBe(1);
    expect(current.tokenUsage.plannerInput).toBe(10);
    expect(loadState({ projectDir, sessionId })?.triage?.[0]?.cycle).toBe(1);
    expect(planner.prompts[0]).toContain('# Review triage');
    expect(planner.prompts[0]).toContain('**F1**');
    expect(planner.prompts[0]).toContain('src/shared/widget.ts drops the error');
    expect(planner.prompts[0]).toContain('Acceptance: The error is rethrown');
    expect(planner.prompts[0]).toContain('This triage starts fix cycle 1');
  });

  it('runs the verify entries through the plan checks and records them', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const runCommand = makeCommandRunner({ stdout: 'ok', stderr: '', code: 0 });
    const planner = triagePlanner([
      JSON.stringify({
        fixTasks: [],
        rejected: [],
        verify: [{ findingId: 'F1', checkIds: ['K1'] }],
        ask: null,
      } satisfies TriageResult),
    ]);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner, {
      runCommand,
    });

    const result = await requestTriage(ctx, { review: state.review!, inputs: [] });

    expect('result' in result).toBe(true);
    expect(runCommand.calls.map((call) => call.cmd)).toEqual(['tsc']);
    expect(states.at(-1)?.triage?.[0]?.verification).toEqual([
      { id: 'finding:F1', status: 'pass', output: 'K1: pass — ok' },
    ]);
  });

  it('returns a protocol error without recording a triage', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner(['not the triage shape', 'still not the triage shape']);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner);

    const result = await requestTriage(ctx, { review: state.review!, inputs: [] });

    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('expected a seat-protocol error');
    expect(result.error.kind).toBe('seat-protocol-error');
    expect(planner.prompts).toHaveLength(2);
    expect(states.at(-1)?.triage).toBeUndefined();
    expect(states.at(-1)?.plannerCalls?.used ?? 0).toBe(0);
  });

  it('repairs a coverage violation once and takes the fixed answer', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([
      JSON.stringify({ fixTasks: [], rejected: [], verify: [], ask: null }),
      JSON.stringify(fixResult()),
    ]);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner);

    const result = await requestTriage(ctx, { review: state.review!, inputs: [] });

    expect('result' in result).toBe(true);
    expect(planner.prompts).toHaveLength(2);
    expect(planner.prompts[1]).toContain('Blocking finding F1 is not fixed, rejected or verified.');
    expect(states.at(-1)?.triage).toHaveLength(1);
  });
});

describe('triageContractErrors', () => {
  it('accepts provisional ids reused across cycles and dependencies on completed tasks', () => {
    const previous = [
      makeTask({ id: 'T001', status: 'done', batch: 1 }),
      makeTask({ id: 'T002', status: 'done', batch: 2 }),
    ];
    const result = {
      ...fixResult(),
      fixTasks: [{ ...fixTaskSpec(), dependsOn: [taskId('T001')] }],
    };
    expect(triageContractErrors(result, plan, findings, [], previous)).toEqual([]);
  });

  const findings = [FAILING_FINDING];
  const plan = triageState().plan!;

  it.each([
    { ...FAILING_FINDING, kind: 'unverified' as const },
    { ...FAILING_FINDING, severity: 'minor' as const },
  ])('refuses implementation work for verification-only or minor findings', (finding) => {
    expect(triageContractErrors(fixResult(), plan, [finding], [])).toContain(
      'Finding F1 cannot be assigned to a fix task.',
    );
  });

  it('rejects duplicate proposed ids and unknown dependencies before insertion', () => {
    const duplicate = {
      ...fixResult(),
      fixTasks: [fixTaskSpec(), { ...fixTaskSpec(), findingIds: ['U1'] }],
    };
    expect(
      triageContractErrors(duplicate, plan, findings, [
        { id: 'U1', kind: 'defect', source: 'user', text: 'other', file: null },
      ]),
    ).toContain('Task id T002 is used twice.');
    const unknown = {
      ...fixResult(),
      fixTasks: [{ ...fixTaskSpec(), dependsOn: [taskId('T999')] }],
    };
    expect(triageContractErrors(unknown, plan, findings, [])).toContain(
      'Task T002 depends on unknown task T999.',
    );
  });

  it('refuses a fix task naming a criterion the plan does not carry', () => {
    const result: TriageResult = {
      fixTasks: [{ ...fixTaskSpec(), criteria: ['C9'] }],
      rejected: [],
      verify: [],
      ask: null,
    };

    expect(triageContractErrors(result, plan, findings, [])).toEqual([
      'Fix task T002 names unknown criterion C9.',
    ]);
  });

  it('refuses a verify naming a check the plan does not carry', () => {
    const result: TriageResult = {
      fixTasks: [],
      rejected: [],
      verify: [{ findingId: 'F1', checkIds: ['K404'] }],
      ask: null,
    };

    expect(triageContractErrors(result, plan, findings, [])).toEqual([
      'Verify for F1 names unknown check K404.',
    ]);
  });

  it('refuses an answer that covers a finding twice and an id that names nothing', () => {
    const result: TriageResult = {
      fixTasks: [fixTaskSpec()],
      rejected: [{ findingId: 'F1', reason: 'no work' }],
      verify: [],
      ask: null,
    };

    expect(triageContractErrors(result, plan, findings, [])).toEqual([
      'Blocking finding F1 is answered more than once.',
    ]);
  });

  it('waives the coverage rule for an ask but keeps the known-id rules', () => {
    const ask: TriageResult = {
      fixTasks: [{ ...fixTaskSpec(), criteria: ['C9'] }],
      rejected: [],
      verify: [],
      ask: { question: 'Which wording?', whyOnlyUserCanAnswer: 'It changes the product' },
    };

    expect(triageContractErrors(ask, plan, findings, [])).toEqual([
      'Fix task T002 names unknown criterion C9.',
    ]);
  });
});

describe('runTriage', () => {
  it('resumes a saved question before spending another planner turn', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const question = {
      question: 'Saved product question?',
      whyOnlyUserCanAnswer: 'Product choice',
    };
    const state = { ...triageState(), pendingTriage: { inputs: [], question } };
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([
      JSON.stringify({
        ...fixResult(),
        rejected: [{ findingId: 'A1', reason: 'The reply guides the fix' }],
      }),
    ]);
    const asked: string[] = [];
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner, {
      callbacks: makeCallbacks({
        onPlannerReply: async (reply) => {
          asked.push(reply.text);
          return 'Keep hello';
        },
      }).callbacks,
    });
    expect(await runTriage(ctx, { review: state.review!, inputs: [] })).toMatchObject({
      kind: 'triaged',
    });
    expect(asked).toEqual(['Saved product question?']);
    expect(planner.prompts).toHaveLength(1);
    expect(planner.prompts[0]).toContain('Keep hello');
    expect(states.at(-1)?.userAnswers).toEqual([
      { reply: 'Saved product question?', answer: 'Keep hello' },
    ]);
  });

  it('retains user answers after a fix cycle clears the pending triage', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([
      JSON.stringify({
        fixTasks: [],
        rejected: [],
        verify: [],
        ask: { question: 'Which wording?', whyOnlyUserCanAnswer: 'Product choice' },
      }),
      JSON.stringify({ ...fixResult(), rejected: [{ findingId: 'A1', reason: 'Guides the fix' }] }),
    ]);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner, {
      callbacks: makeCallbacks({ onPlannerReply: async () => 'Keep hello' }).callbacks,
    });
    await runTriage(ctx, { review: state.review!, inputs: [] });
    const next = transition(states.at(-1)!, { type: 'START_FIX_CYCLE' });
    expect(next.pendingTriage).toBeUndefined();
    expect(next.userAnswers).toEqual([{ reply: 'Which wording?', answer: 'Keep hello' }]);
  });

  it('halts before a second ask turn spends the run allowance and keeps its answer', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = { ...triageState(), plannerCalls: { used: 9, allowance: 10 } };
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([
      JSON.stringify({
        fixTasks: [],
        rejected: [],
        verify: [],
        ask: { question: 'Which wording?', whyOnlyUserCanAnswer: 'Product choice' },
      }),
      JSON.stringify(fixResult()),
    ]);
    const callbacks = makeCallbacks({ onPlannerReply: async () => 'Keep hello' }).callbacks;
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner, {
      callbacks,
    });
    expect(await runTriage(ctx, { review: state.review!, inputs: [] })).toEqual({
      kind: 'bound-spent',
    });
    expect(planner.prompts).toHaveLength(1);
    expect(states.at(-1)?.plannerCalls).toEqual({ used: 10, allowance: 10 });
    expect(states.at(-1)?.pendingTriage?.inputs).toContainEqual({
      id: 'A1',
      kind: 'answer',
      source: 'user',
      text: 'Keep hello',
      file: null,
    });
  });
  it('appends the fix tasks with their cycle, batch and verbatim findings', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([JSON.stringify(fixResult())]);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner);

    const result = await runTriage(ctx, { review: state.review!, inputs: [] });

    expect(result).toMatchObject({ kind: 'triaged' });
    const current = states.at(-1)!;
    expect(current.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
    const fixed = current.tasks[1]!;
    expect(fixed.batch).toBe(2);
    expect(fixed.fix).toEqual({
      cycle: 1,
      findings: [
        {
          id: 'F1',
          text: 'src/shared/widget.ts drops the error',
          acceptance: 'The error is rethrown',
        },
      ],
    });
    expect(fixed.description).toContain('src/shared/widget.ts drops the error');
    expect(fixed.description).toContain('Acceptance: The error is rethrown');
    expect(fixed.description).toContain(
      'Evidence, ledger, review and session files are not your job; SPLITBRIEF records them. You may edit any ordinary project file the fix needs.',
    );
    expect(fixed.description).toContain(
      'If no finding needs a code change, change nothing and report that.',
    );
    // The completed brief is untouched: fix work is an appended task, never a reopen.
    expect(current.tasks[0]).toEqual(state.tasks[0]);
    expect(loadState({ projectDir, sessionId })?.tasks[1]?.fix?.cycle).toBe(1);
  });

  it('puts an ask to the user, queues the answer and triages again', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const asked: string[] = [];
    const callbacks = makeCallbacks({
      onPlannerReply: async (reply) => {
        asked.push(reply.questions[0]?.text ?? '');
        return 'Use the shared widget helper.';
      },
    }).callbacks;
    const planner = triagePlanner([
      JSON.stringify({
        fixTasks: [],
        rejected: [],
        verify: [],
        ask: {
          question: 'Should the greeting keep the comma?',
          whyOnlyUserCanAnswer: 'It changes the product wording',
        },
      } satisfies TriageResult),
      JSON.stringify({
        ...fixResult(),
        rejected: [{ findingId: 'A1', reason: 'The answer guides the fix task' }],
      } satisfies TriageResult),
    ]);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner, {
      callbacks,
    });

    const result = await runTriage(ctx, { review: state.review!, inputs: [] });

    expect(result).toMatchObject({ kind: 'triaged' });
    expect(asked).toEqual(['Should the greeting keep the comma?']);
    const current = states.at(-1)!;
    expect(current.triage).toHaveLength(2);
    expect(current.triage?.[1]?.result.rejected).toEqual([
      { findingId: 'A1', reason: 'The answer guides the fix task' },
    ]);
    expect(current.tasks[1]?.fix?.cycle).toBe(1);
    expect(planner.prompts[1]).toContain('Use the shared widget helper.');
    expect(planner.prompts[1]).toContain('**A1**');
  });

  it('reports an unanswered ask when the run has no reply surface', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([
      JSON.stringify({
        fixTasks: [],
        rejected: [],
        verify: [],
        ask: { question: 'Which wording?', whyOnlyUserCanAnswer: 'It changes the product' },
      } satisfies TriageResult),
    ]);
    const { ctx } = contextFor(projectDir, sessionId, state, planner.planner);

    const result = await runTriage(ctx, { review: state.review!, inputs: [] });

    expect(result).toEqual({ kind: 'unanswered' });
  });

  it('answers an operator input with a fix task that carries the input text', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = triageState();
    saveState({ projectDir, sessionId }, state);
    const planner = triagePlanner([
      JSON.stringify({
        fixTasks: [{ ...fixTaskSpec(), findingIds: ['U1', 'F1'] }],
        rejected: [],
        verify: [],
        ask: null,
      } satisfies TriageResult),
    ]);
    const { ctx, states } = contextFor(projectDir, sessionId, state, planner.planner);

    await runTriage(ctx, {
      review: state.review!,
      inputs: [
        {
          id: 'U1',
          kind: 'defect',
          source: 'user',
          text: 'log the error, then rethrow it',
          file: null,
        },
      ],
    });

    const fixed = states.at(-1)?.tasks[1];
    expect(fixed?.fix?.findings).toEqual([
      { id: 'U1', text: 'log the error, then rethrow it', acceptance: null },
      {
        id: 'F1',
        text: 'src/shared/widget.ts drops the error',
        acceptance: 'The error is rethrown',
      },
    ]);
  });
});
