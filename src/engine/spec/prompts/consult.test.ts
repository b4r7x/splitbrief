import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Plan } from '../../../core/schemas/plan.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import type { ConsultRecord } from '../../../core/schemas/workflow.js';
import { buildConsultPrompt, type ConsultPromptInput } from './consult.js';
import { DIRECT_WRITER_TASK_RULE, TASK_CMD_CHECK_RULE } from './plan-session.js';

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
    reason: 'failed',
    plan,
    task: TASK,
    revisions: [REVISION],
    taskDiff: {
      diffs: [
        { path: 'src/greet.ts', diff: '+export function greet(name: string) { return name; }' },
      ],
      otherFiles: [],
    },
    failingOutput: 'Error: expected "hello" but received "hi"',
    failedAttempts: [],
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
    writesFiles: 'extracted-code',
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
    expect(prompt).toContain('## Task Diff');
    expect(prompt).toContain('+export function greet(name: string) { return name; }');
    expect(prompt).toContain('## Failing Output');
    expect(prompt).toContain('Error: expected "hello" but received "hi"');
    expect(prompt).toContain('## Implementer Report');
    expect(prompt).toContain('Files changed: src/greet.ts');
    expect(prompt).toContain('## Brief History');
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

  it.each([
    { form: 'resumed', overrides: { resumed: true } },
    { form: 'full', overrides: {} },
  ] satisfies { form: string; overrides: Partial<ConsultPromptInput> }[])(
    'bounds the attempt diff and names the files it leaves out, $form prompt',
    ({ overrides }) => {
      const small = `diff --git a/src/a.ts b/src/a.ts\n${'+a'.repeat(480)}`;
      const diffs = [
        { path: 'src/a.ts', diff: small },
        { path: 'src/big.json', diff: `+${'y'.repeat(5_000_000)}TAIL-OF-BIG-DIFF` },
        { path: 'src/c.ts', diff: '+C-BODY' },
      ];
      const empty = buildConsultPrompt(
        consultInput({ ...overrides, taskDiff: { diffs: [], otherFiles: [] } }),
      );
      const prompt = buildConsultPrompt(
        consultInput({ ...overrides, taskDiff: { diffs, otherFiles: [] } }),
      );

      expect(prompt.length).toBeLessThan(empty.length + BOUNDS.consultDiffChars + 1_000);
      expect(prompt).toContain(small);
      expect(prompt).toContain('src/big.json');
      expect(prompt).toContain('src/c.ts');
      expect(prompt).not.toContain('TAIL-OF-BIG-DIFF');
      expect(prompt).not.toContain('C-BODY');
    },
  );

  it.each([
    { form: 'resumed', overrides: { resumed: true } },
    { form: 'full', overrides: {} },
  ] satisfies { form: string; overrides: Partial<ConsultPromptInput> }[])(
    'shows the files of an earlier attempt and one line per failed attempt, $form prompt',
    ({ overrides }) => {
      const prompt = buildConsultPrompt(
        consultInput({
          ...overrides,
          taskDiff: {
            diffs: [
              { path: 'lib/cli/cli.js', diff: '+module.exports = run;' },
              { path: 'test/cli.spec.js', diff: "+require('../lib/cli/cli');" },
            ],
            otherFiles: [],
          },
          failedAttempts: [
            {
              attempt: 1,
              taskId: taskId('T003'),
              revision: 1,
              line: 'check K1 did not pass (fail):',
            },
            {
              attempt: 2,
              taskId: taskId('T003'),
              revision: 1,
              line: 'Tool implementer exited without changing any files',
            },
          ],
          failingOutput: 'Tool implementer exited without changing any files',
        }),
      );

      expect(prompt).toContain('## Task Diff');
      expect(prompt).toContain('the changes of all its attempts');
      expect(prompt).toContain('+module.exports = run;');
      expect(prompt).toContain("+require('../lib/cli/cli');");
      expect(prompt).not.toContain('## Attempt Diff');
      expect(prompt).toContain('## Brief History');
      expect(prompt).toContain('- Attempt 1 (T003 revision 1): check K1 did not pass (fail):');
      expect(prompt).toContain(
        '- Attempt 2 (T003 revision 1): Tool implementer exited without changing any files',
      );
      expect(prompt.indexOf('## Brief History')).toBeLessThan(prompt.indexOf('## Failing Output'));
    },
  );

  it.each([
    { form: 'resumed', overrides: { resumed: true } },
    { form: 'full', overrides: {} },
  ] satisfies { form: string; overrides: Partial<ConsultPromptInput> }[])(
    'shows each earlier answer before the attempts that followed it, $form prompt',
    ({ overrides }) => {
      const prompt = buildConsultPrompt(
        consultInput({
          ...overrides,
          failedAttempts: [
            { attempt: 1, taskId: taskId('T003'), revision: 1, line: 'first failure' },
            { attempt: 2, taskId: taskId('T003'), revision: 1, line: 'second failure' },
          ],
          earlierConsults: [{ ...EARLIER_CONSULT, afterAttempt: 1 }],
        }),
      );

      const answer =
        '- Planner answer (failed · guidance · revision 1): The named export is missing. — Fix the import to the named export.';
      expect(prompt).toContain(answer);
      expect(prompt).toContain('Nothing counts your answers');
      expect(prompt.indexOf('first failure')).toBeLessThan(prompt.indexOf(answer));
      expect(prompt.indexOf(answer)).toBeLessThan(prompt.indexOf('second failure'));
    },
  );

  it("names the reviewer on an older run's fix-task answer", () => {
    const prompt = buildConsultPrompt(
      consultInput({ earlierConsults: [{ ...EARLIER_CONSULT, seat: 'review' }] }),
    );

    expect(prompt).toContain(
      '- Reviewer answer (failed · guidance · revision 1): The named export is missing.',
    );
  });

  it('shows an older answer that recorded no attempt after the failed attempts', () => {
    const prompt = buildConsultPrompt(
      consultInput({
        failedAttempts: [
          { attempt: 1, taskId: taskId('T003'), revision: 1, line: 'first failure' },
        ],
      }),
    );

    expect(prompt.indexOf('first failure')).toBeLessThan(
      prompt.indexOf('The named export is missing.'),
    );
  });

  it("names the parent's attempts and the subtask's own on a split subtask", () => {
    const subtask = makeTask({ id: 'T005', parentId: taskId('T003'), status: 'failed' });
    const prompt = buildConsultPrompt(
      consultInput({
        task: subtask,
        failedAttempts: [
          {
            attempt: 1,
            taskId: taskId('T003'),
            revision: 2,
            line: 'check K1 did not pass (fail):',
          },
          {
            attempt: 2,
            taskId: taskId('T005'),
            revision: 1,
            line: 'check K2 did not pass (fail):',
          },
        ],
      }),
    );

    expect(prompt).toContain('- Attempt 1 (T003 revision 2): check K1 did not pass (fail):');
    expect(prompt).toContain('- Attempt 2 (T005 revision 1): check K2 did not pass (fail):');
  });

  it('says plainly when the task changed no file and when no task start was recorded', () => {
    const unchanged = buildConsultPrompt(consultInput({ taskDiff: { diffs: [], otherFiles: [] } }));
    const unrecorded = buildConsultPrompt(consultInput({ taskDiff: null }));

    expect(unchanged).toContain('This task has changed no file since it started.');
    expect(unrecorded).toContain(
      'No diff of this task is available. Read the files in the run workspace.',
    );
    expect(unrecorded).not.toContain('```diff');
  });

  it('shows the diff of the brief files whole and only names the other changed files', () => {
    const otherFiles = Array.from(
      { length: 300 },
      (_, index) => `data/fixtures/item-${String(index).padStart(3, '0')}.txt`,
    );
    const prompt = buildConsultPrompt(
      consultInput({
        taskDiff: {
          diffs: [{ path: 'scripts/gen-fixtures.js', diff: '+GEN-FIXTURES-BODY' }],
          otherFiles,
        },
      }),
    );

    expect(prompt).toContain('for the files of this brief');
    expect(prompt).toContain('+GEN-FIXTURES-BODY');
    expect(prompt).not.toContain('The diff stops');
    expect(prompt).toContain(
      'This task also changed other files, not shown here: `data/fixtures/item-000.txt`',
    );
    expect(prompt).toContain('`data/fixtures/item-019.txt`, and 280 more.');
    expect(prompt).not.toContain('data/fixtures/item-020.txt');
    expect(prompt).toContain('Read these files in the run workspace.');
  });

  it('says in one line that the brief files did not change and still names the others', () => {
    const prompt = buildConsultPrompt(
      consultInput({ taskDiff: { diffs: [], otherFiles: ['data/a.txt', 'data/b.txt'] } }),
    );

    expect(prompt).toContain('The files of this brief have no change since this task started.');
    expect(prompt).toContain(
      'This task also changed other files, not shown here: `data/a.txt`, `data/b.txt`. Read these files in the run workspace.',
    );
    expect(prompt).not.toContain('```diff');
    expect(prompt).not.toContain('This task has changed no file since it started.');
  });

  it('caps the names of the files it leaves out with a count', () => {
    const diffs = Array.from({ length: 2002 }, (_, index) => ({
      path: `src/generated/file-${index}.json`,
      diff: `diff --git a/src/generated/file-${index}.json b/src/generated/file-${index}.json\n+${'z'.repeat(1_000)}`,
    }));

    const prompt = buildConsultPrompt(consultInput({ taskDiff: { diffs, otherFiles: [] } }));

    expect(prompt).toContain('src/generated/file-0.json');
    expect(prompt).not.toContain('src/generated/file-2001.json');
    expect(prompt).toMatch(/and [\d,]+ more/);
    expect(prompt.length).toBeLessThan(BOUNDS.consultDiffChars + 20_000);
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
    expect(prompt).not.toContain(DIRECT_WRITER_TASK_RULE);
  });

  it.each([
    ['a plan task', TASK],
    [
      'a fix task',
      {
        ...TASK,
        fix: { cycle: 1, findings: [{ id: 'F1', text: 'A red test', acceptance: null }] },
      },
    ],
  ])(
    'writes a rewrite or a split of %s for a coding agent under its task rule',
    (_, task: Task) => {
      const prompt = buildConsultPrompt(consultInput({ task, writesFiles: 'direct' }));

      expect(prompt).toContain(`${TASK_CMD_CHECK_RULE} ${DIRECT_WRITER_TASK_RULE}`);
      expect(prompt.split(DIRECT_WRITER_TASK_RULE)).toHaveLength(2);
    },
  );

  it.each([false, true])(
    'tells the planner (resumed=%s) that an answer only instructs the next attempt, and to answer cannot',
    (resumed) => {
      const prompt = buildConsultPrompt(consultInput({ resumed }));

      expect(prompt).toContain('Offer only choices that the next attempt can carry out.');
      expect(prompt).toContain('answer `cannot`');
      if (!resumed) {
        expect(prompt).toContain(
          "SPLITBRIEF gives the user's answer to an `ask-user` question to the same implementer, as an instruction for its next attempt.",
        );
        expect(prompt).toContain(
          "An answer cannot change a seat's tool or model, buy credits, or wait for a limit to reset.",
        );
        expect(prompt).toContain(
          'When the implementer cannot do the task at all, answer `cannot` and name the reason, for example a seat the user must change with `/crew`.',
        );
      }
    },
  );

  it('shows the decisions of a done report with and without a reason', () => {
    const prompt = buildConsultPrompt(
      consultInput({
        report: {
          status: 'done',
          filesChanged: ['src/greet.ts'],
          touchedNotSuggested: [],
          notes: null,
          decisions: [
            { what: 'Used node:crypto', why: 'The dependency is standard' },
            { what: 'Kept the old name', why: null },
          ],
        },
      }),
    );

    expect(prompt).toContain('## Implementer Report');
    expect(prompt).toContain(
      'Decisions: Used node:crypto — The dependency is standard; Kept the old name\n',
    );
  });

  it.each([
    ['failed', false],
    ['failed', true],
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

  it("tells the planner to name the next step of a cannot and that a request to decide is the user's consent", () => {
    const prompt = buildConsultPrompt(consultInput());

    expect(prompt).toContain('`skip-brief` when the run can go on without this task');
    expect(prompt).toContain(
      "An answer or an instruction of the user that asks you to decide is the user's consent to decide that matter yourself.",
    );
  });

  it('tells the planner the review wrote the fix task and lists its findings keys', () => {
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
    const prompt = buildConsultPrompt(consultInput({ task: fixTask }));

    expect(prompt).toContain(
      "You are the run's planner. The review wrote this fix task for its findings, and you decide its repair. SPLITBRIEF asks you",
    );
    expect(prompt).toContain('### Fix findings');
    expect(prompt).toContain(
      [
        '### Fix findings',
        "Other failures are not this brief's job: their fix tasks or the next review answer them. Do not send the implementer after them.",
        "- **F1** this brief's failures: V1: greet > hello, greet > empty; the whole red: V1: greet > name",
      ].join('\n'),
    );
    expect(prompt).not.toContain('- **F2**');
  });

  it('sends the short resumed turn without the static context', () => {
    const full = buildConsultPrompt(consultInput());
    const resumed = buildConsultPrompt(consultInput({ resumed: true }));

    expect(resumed).toContain('# Consult continued');
    expect(resumed).not.toContain('## Plan');
    expect(resumed).not.toContain('## Other Tasks');
    expect(resumed).toContain('## Failing Output');
    expect(resumed).toContain('Error: expected "hello" but received "hi"');
    expect(resumed).toContain('a rewrite or a split never drops a criterion id');
    expect(resumed.length).toBeLessThan(full.length);
  });

  it('names the decision ledger Decisions in the resumed turn', () => {
    const resumed = buildConsultPrompt(
      consultInput({
        resumed: true,
        plan: { ...plan, decisions: [{ text: 'Used node:crypto', taskId: taskId('T003') }] },
      }),
    );

    expect(resumed).toContain('## Decisions\n');
    expect(resumed).toContain('- Used node:crypto (T003)');
    expect(resumed).not.toContain('Confirmed Decisions');
  });
});
