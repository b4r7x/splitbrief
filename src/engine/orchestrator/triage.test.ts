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
import { taskId } from '../../core/schemas/task.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import type { ReviewRecord, WorkflowState } from '../../core/schemas/workflow.js';
import { applyTriage, runTriageVerification, triageContractErrors } from './triage.js';

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

    expect(triageContractErrors(ask, plan, findings, [])).toEqual([
      'Fix task T002 names unknown criterion C9.',
    ]);
  });
});

describe('review fix work', () => {
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
      findings: [{ id: 'F1', text: FAILING_FINDING.text, acceptance: FAILING_FINDING.acceptance }],
    });
    expect(loadState(ref)?.tasks[1]?.fix?.cycle).toBe(1);
    const tasksMarkdown = readSpecFile(ref, TASKS_FILE) ?? '';
    expect(tasksMarkdown).toContain('planner: claude-code');
    for (const task of applied.state.tasks) expect(tasksMarkdown).toContain(task.id);
  });
});
