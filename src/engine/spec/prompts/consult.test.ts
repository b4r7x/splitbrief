import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Plan } from '../../../core/schemas/plan.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import type { ConsultRecord } from '../../../core/schemas/workflow.js';
import { buildConsultPrompt, type ConsultPromptInput } from './consult.js';
import { TASK_CMD_CHECK_RULE } from './plan-session.js';

const plan: Plan = {
  summary: 'Add greeting support',
  decisions: [],
  criteria: [
    { id: 'C1', text: 'A greeting is returned', checkIds: ['K1'] },
    { id: 'C2', text: 'An empty name is refused', checkIds: ['K2'] },
  ],
  checks: [
    { id: 'K1', kind: 'test', value: 'src/greet.test.ts', required: true },
    { id: 'K2', kind: 'cmd', value: 'npm run lint', required: false },
  ],
  validation: null,
};

const TASK = makeTask({
  id: 'T003',
  title: 'Greet by name',
  status: 'failed',
  revision: 2,
  criteria: ['C1', 'C2'],
  checks: [
    { id: 'K1', kind: 'test', value: 'src/greet.test.ts', required: true },
    { id: 'K2', kind: 'cmd', value: 'npm run lint', required: false },
  ],
});

const REVISION = makeTask({
  id: 'T003',
  title: 'Greet at all',
  revision: 1,
  criteria: ['C1', 'C2'],
});

const EARLIER_CONSULT: ConsultRecord = {
  reason: 'failed',
  action: 'guidance',
  diagnosis: 'The named export is missing.',
  at: '2026-10-02T10:00:00.000Z',
  taskId: taskId('T003'),
  revision: 1,
  answer: {
    answer: {
      action: 'guidance',
      diagnosis: 'The named export is missing.',
      instructions: 'Fix the import to the named export.',
      context: null,
    },
  },
};

function consultInput(overrides: Partial<ConsultPromptInput> = {}): ConsultPromptInput {
  return {
    workspaceDir: '/tmp/run-workspace',
    seat: 'plan',
    reason: 'failed',
    plan,
    task: TASK,
    revisions: [REVISION],
    diff: '+export function greet(name: string) { return name; }',
    failingOutput: 'Error: expected "hello" but received "hi"',
    report: {
      status: 'done',
      filesChanged: ['src/greet.ts'],
      touchedNotSuggested: [],
      notes: null,
      decisions: [],
    },
    earlierConsults: [EARLIER_CONSULT],
    otherTasks: [
      makeTask({ id: 'T001', title: 'Scaffold the module', status: 'done' }),
      makeTask({ id: 'T004', title: 'Document the greeting' }),
    ],
    operatorInstructions: [],
    ...overrides,
  };
}

describe('buildConsultPrompt', () => {
  it.each([false, true])('directs code reads to the workspace, resumed=%s', (resumed) => {
    const prompt = buildConsultPrompt(consultInput({ resumed }));

    expect(prompt).toContain('The run workspace is `/tmp/run-workspace`.');
    expect(prompt).toContain('Read project files from this directory');
  });

  it('carries the plan, the task and its revisions, the attempt, the lineage and the reason', () => {
    const prompt = buildConsultPrompt(consultInput());

    expect(prompt).toContain('## Plan');
    expect(prompt).toContain('**C1**: A greeting is returned — checks: K1');
    expect(prompt).toContain('`K2` (cmd `npm run lint`, optional)');
    expect(prompt).toContain('## Task T003 (revision 2)');
    expect(prompt).toContain('**Title**: Greet by name');
    expect(prompt).toContain('## Revision 1 · Greet at all');
    expect(prompt).toContain('## Attempt Diff');
    expect(prompt).toContain('+export function greet(name: string) { return name; }');
    expect(prompt).toContain('## Failing Output');
    expect(prompt).toContain('Error: expected "hello" but received "hi"');
    expect(prompt).toContain('## Implementer Report');
    expect(prompt).toContain('Files changed: src/greet.ts');
    expect(prompt).toContain('## Earlier Consults on This Lineage');
    expect(prompt).toContain('Fix the import to the named export.');
    expect(prompt).toContain('## Other Tasks');
    expect(prompt).toContain('- **T001** (done) — Scaffold the module');
    expect(prompt).toContain('- **T004** (pending) — Document the greeting');
    expect(prompt).toContain('## Reason');
    expect(prompt).toContain('failed — The task failed');
  });

  it('bounds the failing output at 4000 characters', () => {
    const prompt = buildConsultPrompt(consultInput({ failingOutput: 'x'.repeat(5000) }));

    expect(prompt).toContain('x'.repeat(BOUNDS.consultFailingOutputChars - 1));
    expect(prompt).not.toContain('x'.repeat(BOUNDS.consultFailingOutputChars));
  });

  it('states the action contract, the criteria rule and the read-only call', () => {
    const prompt = buildConsultPrompt(consultInput());

    for (const action of ['guidance', 'rewrite-task', 'split-task', 'verify', 'ask-user']) {
      expect(prompt).toContain(`\`${action}\``);
    }
    expect(prompt).toContain(
      'a rewrite or a split never drops a criterion id; a split never splits a subtask',
    );
    expect(prompt).toContain('No action undoes one of them.');
    expect(prompt).toContain('This call is read-only');
    expect(prompt).toContain(TASK_CMD_CHECK_RULE);
  });

  it('lets only guidance or a rewrite answer a stale consult', () => {
    const prompt = buildConsultPrompt(consultInput({ reason: 'stale' }));

    expect(prompt).toContain('stale — The task went stale');
    expect(prompt).toContain('Only guidance or a rewritten task can answer this reason.');
  });

  it.each([false, true])(
    'shows only the decision-confirm contract and attempt evidence, resumed=%s',
    (resumed) => {
      const prompt = buildConsultPrompt(
        consultInput({
          resumed,
          reason: 'deviation',
          plan: {
            ...plan,
            decisions: [{ text: 'Use node:crypto', taskId: taskId('T003') }],
          },
          report: {
            status: 'done',
            filesChanged: ['src/greet.ts'],
            touchedNotSuggested: [],
            notes: null,
            decisions: [{ what: 'Used node:crypto', why: 'The dependency is standard' }],
          },
        }),
      );

      expect(prompt).toContain('deviation — The implementer reported new decisions');
      expect(prompt).toContain('### Decisions');
      expect(prompt).toContain('- Use node:crypto (T003)');
      expect(prompt).toContain('`confirm`');
      expect(prompt).toContain('Any other change of what is built is `ask-user`');
      expect(prompt).toContain('## Plan');
      expect(prompt).toContain('**C1**: A greeting is returned');
      expect(prompt).toContain('## Task T003');
      expect(prompt).toContain('## Attempt Diff');
      expect(prompt).toContain('## Implementer Report');
      expect(prompt).toContain('Validation runs after a `confirm` answer');
      expect(prompt).toContain('its default keeps it');
      for (const action of ['guidance', 'rewrite-task', 'split-task', 'verify']) {
        expect(prompt).not.toContain(`\`${action}\``);
      }
      for (const section of ['Failing Output', 'Earlier Consults', 'Other Tasks']) {
        expect(prompt).not.toContain(`## ${section}`);
      }
    },
  );

  it.each([false, true])(
    'offers a decision confirm guidance only once the user answered (%s)',
    (answered) => {
      const prompt = buildConsultPrompt(consultInput({ reason: 'deviation', answered }));

      expect(prompt.includes('- `guidance` with `instructions`')).toBe(answered);
      expect(prompt.includes('The user answered your question')).toBe(answered);
      expect(prompt.includes('SPLITBRIEF asks you again with the answer')).toBe(!answered);
    },
  );

  it.each([
    ['failed', false],
    ['failed', true],
    ['stale', false],
    ['deviation', false],
    ['deviation', true],
  ] as const)(
    "shows the brief's operator instructions to a %s consult, resumed=%s",
    (reason, resumed) => {
      const prompt = buildConsultPrompt(
        consultInput({
          reason,
          resumed,
          operatorInstructions: [
            'also export a default from src/greet.ts',
            'Question: Keep the default export?\nAnswer: Yes, keep it',
          ],
        }),
      );

      expect(prompt).toContain('## Operator Instructions');
      expect(prompt).toContain('```\nalso export a default from src/greet.ts\n```');
      expect(prompt).toContain(
        '```\nQuestion: Keep the default export?\nAnswer: Yes, keep it\n```',
      );
    },
  );

  it('shows no operator instructions section when the brief has none', () => {
    expect(buildConsultPrompt(consultInput())).not.toContain('## Operator Instructions');
  });

  it('names the planner when the planner answers a plan task', () => {
    const prompt = buildConsultPrompt(consultInput());

    expect(prompt).toContain("You are the run's planner. SPLITBRIEF asks you");
    expect(prompt).not.toContain('### Fix findings');
  });

  it('names the reviewer and lists the fix findings keys on a fix task', () => {
    const fixTask: Task = {
      ...TASK,
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'F1',
            text: 'The greeting test is red',
            acceptance: null,
            failureKeys: { V1: ['greet > hello', 'greet > empty'] },
            redKeys: { V1: ['greet > name'] },
          },
          { id: 'F2', text: 'A typo in the docs', acceptance: null },
        ],
      },
    };
    const prompt = buildConsultPrompt(consultInput({ seat: 'review', task: fixTask }));

    expect(prompt).toContain(
      "You are the run's reviewer: you wrote this fix task at the review, and you decide its repair. SPLITBRIEF asks you",
    );
    expect(prompt).not.toContain("You are the run's planner.");
    expect(prompt).toContain('### Fix findings');
    expect(prompt).toContain(
      '- **F1** failure keys: V1: greet > hello, greet > empty; red keys: V1: greet > name',
    );
    expect(prompt).not.toContain('- **F2**');
  });

  it('sends the short resumed turn without the static context', () => {
    const full = buildConsultPrompt(consultInput());
    const resumed = buildConsultPrompt(consultInput({ resumed: true }));

    expect(resumed).toContain('# Consult continued');
    expect(resumed).not.toContain('## Plan');
    expect(resumed).not.toContain('## Earlier Consults on This Lineage');
    expect(resumed).not.toContain('## Other Tasks');
    expect(resumed).toContain('## Failing Output');
    expect(resumed).toContain('Error: expected "hello" but received "hi"');
    expect(resumed).toContain('a rewrite or a split never drops a criterion id');
    expect(resumed.length).toBeLessThan(full.length);
  });
});
