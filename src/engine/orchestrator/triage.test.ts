import { afterEach, describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCommandRunner, makeConfig } from '#testing/helpers/validation-fixtures.js';
import { readSpecFile } from '../../core/paths-io.js';
import { TASKS_FILE } from '../../core/paths.js';
import type { ReviewVerdict, TriageResult } from '../../core/schemas/review.js';
import type { ReviewScope } from '../../core/review/verdict.js';
import { taskId } from '../../core/schemas/task.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import type {
  ReviewChecksRecord,
  ReviewRecord,
  WorkflowState,
} from '../../core/schemas/workflow.js';
import { applyTriage, runTriageVerification, triageContractErrors } from './triage.js';
import { enabledReviewChecks } from './validation/run-checks.js';
import { processError } from '../../lib/process/errors.js';

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

const FINAL_SCOPE: ReviewScope = { kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] };
const TASK_SCOPE: ReviewScope = {
  kind: 'task',
  taskIds: ['T001', 'T002', 'T003', 'T004'],
  criterionIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'],
};

function reviewRecord(): ReviewRecord {
  return {
    cycle: 0,
    verdict: FAIL_VERDICT,
    outcome: 'fail',
    verification: [
      {
        id: 'finding:F1',
        status: 'fail',
        output: 'check K1 did not pass (fail): the widget swallowed it',
      },
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

const REVIEW_CHECKS: ReviewChecksRecord = {
  scope: 'final',
  cycle: 0,
  plan: {
    commands: [
      { id: 'V1', command: 'node --version', reason: 'the runtime answers' },
      { id: 'V2', command: 'npm test', reason: 'the tests pass' },
    ],
    declined: [],
    reason: null,
  },
  at: '2026-10-04T09:00:00.000Z',
};

const VERIFY_V1: TriageResult = {
  fixTasks: [],
  rejected: [],
  verify: [{ findingId: 'F1', checkIds: ['V1'] }],
  ask: null,
};

function fixTaskSpec(): TriageResult['fixTasks'][number] {
  return {
    ...makeTaskSpec({ id: 'T002', suggestedFiles: ['src/shared/widget.ts'] }),
    findingIds: ['F1'],
  };
}

function fixResult(): TriageResult {
  return { fixTasks: [fixTaskSpec()], rejected: [], verify: [], ask: null };
}

describe('triageContractErrors', () => {
  it('refuses fix work for a finding outside the task review scope', () => {
    const outside = { ...FAILING_FINDING, taskId: null, criterionId: null };
    const scoped = { ...FAILING_FINDING, id: 'F2', taskId: 'T004', criterionId: 'C6' };
    const scopedPlan = {
      ...plan,
      criteria: [
        { id: 'C6', text: 'Time-zone tests cover offsets', checkIds: ['K1'] },
        { id: 'C10', text: 'The pending feature works', checkIds: ['K1'] },
      ],
    };
    const result: TriageResult = {
      ...fixResult(),
      fixTasks: [{ ...fixTaskSpec(), id: taskId('T900'), criteria: [] }],
    };
    expect(
      triageContractErrors(result, scopedPlan, [outside], [], [], undefined, TASK_SCOPE),
    ).toEqual([
      'Finding F1 is outside the task review scope and cannot be assigned to a fix task.',
    ]);
    const ask = {
      ...result,
      ask: { question: 'Which wording?', whyOnlyUserCanAnswer: 'It changes the product' },
    };
    expect(triageContractErrors(ask, scopedPlan, [outside], [], [], undefined, TASK_SCOPE)).toEqual(
      ['Finding F1 is outside the task review scope and cannot be assigned to a fix task.'],
    );
    const scopedFix = {
      ...result,
      fixTasks: [{ ...fixTaskSpec(), id: taskId('T900'), findingIds: ['F2'], criteria: ['C6'] }],
    };
    expect(
      triageContractErrors(scopedFix, scopedPlan, [outside, scoped], [], [], undefined, TASK_SCOPE),
    ).toEqual([]);
    expect(
      triageContractErrors(
        { fixTasks: [], rejected: [], verify: [], ask: null },
        scopedPlan,
        [outside],
        [],
        [],
        undefined,
        TASK_SCOPE,
      ),
    ).toEqual([]);
  });

  it('refuses a fix task criterion outside the task review scope', () => {
    const scoped = { ...FAILING_FINDING, id: 'F2', taskId: 'T004', criterionId: 'C6' };
    const scopedPlan = {
      ...plan,
      criteria: [
        { id: 'C6', text: 'Time-zone tests cover offsets', checkIds: ['K1'] },
        { id: 'C10', text: 'The pending feature works', checkIds: ['K1'] },
      ],
    };
    const result = {
      ...fixResult(),
      fixTasks: [{ ...fixTaskSpec(), id: taskId('T900'), findingIds: ['F2'], criteria: ['C10'] }],
    };
    expect(
      triageContractErrors(result, scopedPlan, [scoped], [], [], undefined, TASK_SCOPE),
    ).toEqual(['Fix task T900 names criterion C10 outside the task review scope.']);
    expect(
      triageContractErrors(result, scopedPlan, [scoped], [], [], undefined, FINAL_SCOPE),
    ).toEqual([]);
  });

  it('keeps pending inputs and empty-criteria fixes admissible', () => {
    const empty: TriageResult = { fixTasks: [], rejected: [], verify: [], ask: null };
    for (const source of ['user', 'apply', 'check'] as const) {
      const input = {
        id: 'P1',
        kind: 'defect' as const,
        source,
        text: 'Fix the error',
        file: null,
      };
      expect(triageContractErrors(empty, plan, [], [input], [], undefined, TASK_SCOPE)).toEqual([
        'Pending input P1 is not fixed, rejected or verified.',
      ]);
      const fixed = {
        ...empty,
        fixTasks: [{ ...fixTaskSpec(), criteria: [], findingIds: ['P1'] }],
      };
      const rejected = { ...empty, rejected: [{ findingId: 'P1', reason: 'Already correct' }] };
      const verified = { ...empty, verify: [{ findingId: 'P1', checkIds: ['K1'] }] };
      for (const answer of [fixed, rejected, verified]) {
        expect(triageContractErrors(answer, plan, [], [input], [], undefined, TASK_SCOPE)).toEqual(
          [],
        );
      }
      expect(
        triageContractErrors(
          { ...fixed, rejected: rejected.rejected },
          plan,
          [],
          [input],
          [],
          undefined,
          TASK_SCOPE,
        ),
      ).toEqual(['Pending input P1 is answered more than once.']);
    }
    const result = {
      ...fixResult(),
      fixTasks: [{ ...fixTaskSpec(), criteria: [] }],
    };
    expect(triageContractErrors(result, plan, findings, [], [], undefined, TASK_SCOPE)).toEqual([]);
    const unnamed = [{ ...FAILING_FINDING, taskId: null, criterionId: null }];
    expect(triageContractErrors(result, plan, unnamed, [], [], undefined, FINAL_SCOPE)).toEqual([]);
    expect(triageContractErrors(empty, plan, unnamed, [], [], undefined, FINAL_SCOPE)).toEqual([
      'Blocking finding F1 is not fixed, rejected or verified.',
    ]);
  });

  it('accepts provisional ids reused across cycles and dependencies on completed tasks', () => {
    const previous = [
      makeTask({ id: 'T001', status: 'done', batch: 1 }),
      makeTask({ id: 'T002', status: 'done', batch: 2 }),
    ];
    const result = {
      ...fixResult(),
      fixTasks: [{ ...fixTaskSpec(), dependsOn: [taskId('T001')] }],
    };
    expect(
      triageContractErrors(result, plan, findings, [], previous, undefined, FINAL_SCOPE),
    ).toEqual([]);
  });

  const findings = [FAILING_FINDING];
  const plan = triageState().plan!;

  it.each([
    { ...FAILING_FINDING, kind: 'unverified' as const },
    { ...FAILING_FINDING, severity: 'minor' as const },
  ])('refuses implementation work for verification-only or minor findings', (finding) => {
    expect(
      triageContractErrors(fixResult(), plan, [finding], [], [], undefined, FINAL_SCOPE),
    ).toContain('Finding F1 cannot be assigned to a fix task.');
  });

  it('rejects duplicate proposed ids and unknown dependencies before insertion', () => {
    const duplicate = {
      ...fixResult(),
      fixTasks: [fixTaskSpec(), { ...fixTaskSpec(), findingIds: ['U1'] }],
    };
    expect(
      triageContractErrors(
        duplicate,
        plan,
        findings,
        [{ id: 'U1', kind: 'defect', source: 'user', text: 'other', file: null }],
        [],
        undefined,
        FINAL_SCOPE,
      ),
    ).toContain('Task id T002 is used twice.');
    const unknown = {
      ...fixResult(),
      fixTasks: [{ ...fixTaskSpec(), dependsOn: [taskId('T999')] }],
    };
    expect(triageContractErrors(unknown, plan, findings, [], [], undefined, FINAL_SCOPE)).toContain(
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

    expect(triageContractErrors(result, plan, findings, [], [], undefined, FINAL_SCOPE)).toEqual([
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

    expect(triageContractErrors(result, plan, findings, [], [], undefined, FINAL_SCOPE)).toEqual([
      'Verify for F1 names unknown check K404.',
    ]);
  });

  it('refuses a fix for a verdict finding that names an unknown reviewer check', () => {
    const reviewChecks = enabledReviewChecks(makeConfig({}), REVIEW_CHECKS);
    expect(
      triageContractErrors(
        fixResult(),
        plan,
        [{ ...FAILING_FINDING, checkIds: ['V1', 'V3'] }],
        [],
        triageState().tasks,
        reviewChecks,
        FINAL_SCOPE,
      ),
    ).toEqual(['Finding F1 names unknown check V3.']);
  });

  it('accepts a verify naming a reviewer check only while End-of-run checks are on', () => {
    const tasks = triageState().tasks;
    const on = enabledReviewChecks(makeConfig({}), REVIEW_CHECKS);
    const off = enabledReviewChecks(makeConfig({ endChecks: false }), REVIEW_CHECKS);

    expect(triageContractErrors(VERIFY_V1, plan, findings, [], tasks, on, FINAL_SCOPE)).toEqual([]);
    for (const reviewChecks of [undefined, off]) {
      expect(
        triageContractErrors(VERIFY_V1, plan, findings, [], tasks, reviewChecks, FINAL_SCOPE),
      ).toEqual(['Verify for F1 names unknown check V1.']);
    }
  });

  it('refuses an answer that covers a finding twice and an id that names nothing', () => {
    const result: TriageResult = {
      fixTasks: [fixTaskSpec()],
      rejected: [{ findingId: 'F1', reason: 'no work' }],
      verify: [],
      ask: null,
    };

    expect(triageContractErrors(result, plan, findings, [], [], undefined, FINAL_SCOPE)).toEqual([
      'Blocking finding F1 is answered more than once.',
      'Rejected F1 is not a pending input.',
    ]);
  });

  it('waives the coverage rule for an ask but keeps the known-id rules', () => {
    const ask: TriageResult = {
      fixTasks: [{ ...fixTaskSpec(), criteria: ['C9'] }],
      rejected: [],
      verify: [],
      ask: { question: 'Which wording?', whyOnlyUserCanAnswer: 'It changes the product' },
    };

    expect(triageContractErrors(ask, plan, findings, [], [], undefined, FINAL_SCOPE)).toEqual([
      'Fix task T002 names unknown criterion C9.',
    ]);
  });
});

describe('review fix work', () => {
  it('leads a red verification with the failing test and assertion before a noise tail', async () => {
    const ref = setupProject(dirs);
    const noise = 'runner event\n'.repeat(500);
    const runCommand = makeCommandRunner(
      processError.exitCode({
        command: 'npm test',
        code: 1,
        stderr: '',
        output: ` FAIL  src/a.test.ts > adds\nAssertionError: expected 1 to be 2\n${noise}`,
      }),
    );
    const verification = await runTriageVerification(
      {
        ...ref,
        workspaceDir: ref.projectDir,
        config: makeConfig({}),
        bus: makeBusRecorder().bus,
        runCommand,
      },
      { ...triageState(), reviewChecks: REVIEW_CHECKS },
      { fixTasks: [], rejected: [], verify: [{ findingId: 'F1', checkIds: ['V2'] }], ask: null },
    );

    expect(verification[0]?.status).toBe('fail');
    expect(verification[0]?.output).toMatch(/^check V2 did not pass \(fail\): 1 failure\n/);
    expect(verification[0]?.output).toContain(
      'Failures:\n- src/a.test.ts::adds\n  AssertionError: expected 1 to be 2\nOutput tail:\n',
    );
    expect(verification[0]?.output.split('Output tail:')[1]).not.toContain('AssertionError');
  });

  it('verifies the named registered checks without a seat call', async () => {
    const ref = setupProject(dirs);
    const state = triageState();
    const runCommand = makeCommandRunner({ stdout: 'ok', stderr: '', code: 0 });
    const verification = await runTriageVerification(
      {
        ...ref,
        workspaceDir: ref.projectDir,
        config: makeConfig({}),
        bus: makeBusRecorder().bus,
        runCommand,
      },
      state,
      { fixTasks: [], rejected: [], verify: [{ findingId: 'F1', checkIds: ['K1'] }], ask: null },
    );
    expect(runCommand.calls.map((call) => call.cmd)).toEqual(['tsc']);
    expect(verification).toEqual([{ id: 'finding:F1', status: 'pass', output: 'K1: pass — ok' }]);
  });

  it('runs a reviewer check a verify names only while End-of-run checks are on', async () => {
    const ref = setupProject(dirs);
    const state = { ...triageState(), reviewChecks: REVIEW_CHECKS };
    const verify = async (endChecks: boolean) => {
      const runCommand = makeCommandRunner({ stdout: 'ok', stderr: '', code: 0 });
      const verification = await runTriageVerification(
        {
          ...ref,
          workspaceDir: ref.projectDir,
          config: makeConfig({ endChecks }),
          bus: makeBusRecorder().bus,
          runCommand,
        },
        state,
        VERIFY_V1,
      );
      return { verification, commands: runCommand.calls.map((call) => call.cmd) };
    };

    expect(await verify(true)).toEqual({
      verification: [{ id: 'finding:F1', status: 'pass', output: 'V1: pass — ok' }],
      commands: ['node'],
    });
    const off = await verify(false);
    expect(off.commands).toEqual([]);
    expect(off.verification[0]?.status).not.toBe('pass');
    expect(off.verification[0]?.output).toContain('no check V1');
  });

  it('appends fix tasks with verbatim findings, keeps completed tasks done and rewrites tasks.md', () => {
    const ref = setupProject(dirs);
    const state = triageState();
    saveState(ref, state);
    const applied = applyTriage(
      {
        ...ref,
        workspaceDir: ref.projectDir,
        metadata: { plannerTool: 'claude-code', implementerTool: 'codex' },
      },
      state,
      state.review,
      [],
      fixResult(),
    );
    expect(applied.state.tasks[0]).toEqual(state.tasks[0]);
    expect(applied.tasks[0]?.fix).toEqual({
      cycle: 1,
      findings: [
        {
          id: 'F1',
          text: FAILING_FINDING.text,
          acceptance: FAILING_FINDING.acceptance,
          file: FAILING_FINDING.file,
        },
      ],
    });
    expect(loadState(ref)?.tasks[1]?.fix?.cycle).toBe(1);
    const tasksMarkdown = readSpecFile(ref, TASKS_FILE) ?? '';
    expect(tasksMarkdown).toContain('planner: claude-code');
    for (const task of applied.state.tasks) expect(tasksMarkdown).toContain(task.id);
  });

  it.each([
    { checkIds: ['V1'], commands: { V1: 'node --version' } },
    { checkIds: ['V1', 'V2'], commands: { V1: 'node --version', V2: 'npm test' } },
  ])(
    'carries every reviewer command a finding names onto its fix: $checkIds',
    ({ checkIds, commands }) => {
      const ref = setupProject(dirs);
      const base = triageState();
      const review = reviewRecord();
      const state: WorkflowState = {
        ...base,
        reviewChecks: REVIEW_CHECKS,
        review: {
          ...review,
          verdict: { ...review.verdict, findings: [{ ...FAILING_FINDING, checkIds }] },
        },
      };
      saveState(ref, state);
      const applied = applyTriage(
        {
          ...ref,
          workspaceDir: ref.projectDir,
          metadata: { plannerTool: 'claude-code', implementerTool: 'codex' },
        },
        state,
        state.review,
        [],
        fixResult(),
      );
      expect(applied.tasks[0]?.fix?.findings).toEqual([
        {
          id: 'F1',
          text: FAILING_FINDING.text,
          acceptance: FAILING_FINDING.acceptance,
          file: FAILING_FINDING.file,
          checkIds,
          commands,
        },
      ]);
    },
  );

  it('carries the red check an input answers onto the fix task and its brief', () => {
    const ref = setupProject(dirs);
    const state = triageState();
    saveState(ref, state);
    const inputs = [
      {
        id: 'V1.1',
        kind: 'defect' as const,
        source: 'check' as const,
        file: 'src/shared/widget.test.ts',
        text: 'Reviewer check V1 (npm test) failed with new failures. Last changed by T001.',
        checkIds: ['V1'],
        command: 'npm test',
        output: 'FAIL src/shared/widget.test.ts > rethrows',
        failureKeys: ['src/shared/widget.test.ts::rethrows'],
        redKeys: ['src/shared/widget.test.ts::rethrows', 'src/other.test.ts::fails'],
      },
      {
        id: 'P2',
        kind: 'defect' as const,
        source: 'check' as const,
        file: null,
        text: 'No task changed it.\nRequired check K1 did not pass (fail): broken',
        checkIds: ['K1'],
        output: 'broken',
      },
    ];
    const applied = applyTriage(
      {
        ...ref,
        workspaceDir: ref.projectDir,
        metadata: { plannerTool: 'claude-code', implementerTool: 'codex' },
      },
      state,
      state.review,
      inputs,
      { ...fixResult(), fixTasks: [{ ...fixTaskSpec(), findingIds: ['V1.1', 'P2'] }] },
    );
    expect(applied.tasks[0]?.fix?.findings).toEqual([
      {
        id: 'V1.1',
        text: inputs[0]?.text,
        acceptance: null,
        file: 'src/shared/widget.test.ts',
        checkIds: ['V1'],
        commands: { V1: 'npm test' },
        output: 'FAIL src/shared/widget.test.ts > rethrows',
        failureKeys: { V1: ['src/shared/widget.test.ts::rethrows'] },
        redKeys: { V1: ['src/shared/widget.test.ts::rethrows', 'src/other.test.ts::fails'] },
      },
      { id: 'P2', text: inputs[1]?.text, acceptance: null, checkIds: ['K1'], output: 'broken' },
    ]);
    expect(applied.tasks[0]?.description).toContain(
      `**V1.1**: ${inputs[0]?.text}\nCommand V1: npm test`,
    );
    expect(applied.tasks[0]?.description).toContain(
      'Failing output:\n```\nFAIL src/shared/widget.test.ts > rethrows\n```',
    );
    expect(applied.tasks[0]?.description).toContain('Failing output:\n```\nbroken\n```');
    expect(loadState(ref)?.tasks[1]?.fix?.findings).toEqual(applied.tasks[0]?.fix?.findings);
  });
  // Live run 2026-10-09: the reviewer's own findings cited V1 and carried none of its failures.
  it('gives a verdict finding the failure keys of the pending inputs of its check and file', () => {
    const ref = setupProject(dirs);
    const base = triageState();
    const review = reviewRecord();
    const state: WorkflowState = {
      ...base,
      reviewChecks: REVIEW_CHECKS,
      review: {
        ...review,
        verdict: { ...review.verdict, findings: [{ ...FAILING_FINDING, checkIds: ['V1', 'K1'] }] },
      },
    };
    saveState(ref, state);
    const input = (id: string, file: string, keys: string[]) => ({
      id,
      kind: 'defect' as const,
      source: 'check' as const,
      file,
      text: `Reviewer check V1 (node --version) failed: ${keys.join('; ')}.`,
      checkIds: ['V1'],
      command: 'node --version',
      output: keys.join('\n'),
      failureKeys: keys,
      redKeys: keys,
    });
    const applied = applyTriage(
      {
        ...ref,
        workspaceDir: ref.projectDir,
        metadata: { plannerTool: 'claude-code', implementerTool: 'codex' },
      },
      state,
      state.review,
      [
        input('V1.1', FAILING_FINDING.file, ['src/shared/widget.ts(3,1)']),
        input('V1.2', 'src/other.ts', ['src/other.ts(9,9)']),
      ],
      fixResult(),
    );
    expect(applied.tasks[0]?.fix?.findings[0]?.failureKeys).toEqual({
      V1: ['src/shared/widget.ts(3,1)'],
    });
    expect(applied.tasks[0]?.fix?.findings[0]?.redKeys).toEqual({
      V1: ['src/shared/widget.ts(3,1)', 'src/other.ts(9,9)'],
    });
  });
});
