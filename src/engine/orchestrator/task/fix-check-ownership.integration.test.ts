import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { saveState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import { taskId, type Check, type Task } from '../../../core/schemas/task.js';
import type { TriageInput } from '../../../core/schemas/review.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { fullSuiteSegments } from '../../../features/workflow/conversation-rows/event-format.js';
import { processError } from '../../../lib/process/errors.js';
import { createStdoutTextSink } from '../../events/sinks/stdout-text.js';
import type { EngineEventOf } from '../../events/types.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { applyTriage } from '../triage.js';
import { runBriefGate } from './brief-gate.js';

const FILES = {
  'package.json': JSON.stringify({
    scripts: {
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
      'test:integration': 'vitest run --project integration',
    },
  }),
  'src/a.ts': 'export const a = 1;\n',
  'src/a.test.ts': "import { it } from 'vitest';\nit('adds', () => {});\n",
  'src/b.test.ts': "import { it } from 'vitest';\nit('subtracts', () => {});\n",
};

type Name = 'own' | 'second' | 'shared' | 'other' | 'fresh';
type Kind = 'reviewer' | 'plan' | 'test';

/** One fix check of each kind: its id, its registered check, and how its red names a failure. */
const KINDS: Record<
  Kind,
  { id: string; check: Check | null; command: string; key: (name: Name) => string }
> = {
  reviewer: {
    id: 'V2',
    check: null,
    command: 'npm run typecheck',
    key: (name) =>
      `src/${name}.ts(1,14): error TS2322: Type number is not assignable to type string.`,
  },
  plan: {
    id: 'chk-types',
    check: { id: 'chk-types', kind: 'cmd', value: 'tsc --noEmit', required: true },
    command: 'tsc --noEmit',
    key: (name) =>
      `src/${name}.ts(1,14): error TS2322: Type number is not assignable to type string.`,
  },
  test: {
    id: 'chk-a',
    check: { id: 'chk-a', kind: 'test', value: 'src/a.test.ts', required: true },
    command: 'npm test -- src/a.test.ts',
    key: (name) => `src/a.test.ts::${name}`,
  },
};

function output(kind: Kind, names: readonly Name[]): string {
  return kind === 'test'
    ? names
        .map((name) => ` FAIL  src/a.test.ts > ${name}\nAssertionError: expected 1 to be 2`)
        .join('\n')
    : names.map(KINDS[kind].key).join('\n');
}

type Sibling = { status: Task['status']; own: string[]; cycle?: number };

function fixTask(
  id: string,
  checkId: string,
  command: string,
  keys: { own: string[] | null; red?: string[] | undefined },
  extra: Partial<Task> = {},
): Task {
  return makeTask({
    id,
    suggestedFiles: ['src/a.ts'],
    fix: {
      cycle: 1,
      findings: [
        {
          id: `${id}.F1`,
          text: `Check ${checkId} (${command}) failed.`,
          acceptance: null,
          file: 'src/a.ts',
          checkIds: [checkId],
          commands: { [checkId]: command },
          ...(keys.own !== null && {
            failureKeys: { [checkId]: keys.own },
            redKeys: { [checkId]: keys.red ?? keys.own },
          }),
        },
      ],
    },
    ...extra,
  });
}

function sibling(checkId: string, command: string, spec: Sibling): Task {
  const task = fixTask('T025', checkId, command, { own: spec.own }, { status: spec.status });
  const fix = task.fix;
  return fix === undefined ? task : { ...task, fix: { ...fix, cycle: spec.cycle ?? 1 } };
}

/**
 * Runs the brief gate of `task` on a real run workspace. Every command but `node` fails with
 * `red` (a pass when null); `node --version` stands for a check that passes.
 */
async function gate(
  run: ApplyRun,
  input: {
    task: Task;
    others?: Task[];
    checks?: Check[];
    red: string | null;
    config?: ReturnType<typeof makeConfig>;
  },
) {
  const state = makeImplState([input.task, ...(input.others ?? [])], {
    workspace: run.workspace,
    plan: {
      summary: 's',
      decisions: [],
      criteria: [],
      checks: input.checks ?? [],
      validation: null,
    },
  });
  const ref = { projectDir: run.dir, sessionId: run.sessionId };
  saveState(ref, state);
  const commands: string[] = [];
  const runCommand: ValidationCommandRunner = async (cmd, args) => {
    commands.push([cmd, ...args].join(' '));
    if (input.red === null || cmd === 'node') return { stdout: 'ok', stderr: '', code: 0 };
    throw processError.exitCode({ command: cmd, code: 1, stderr: '', output: input.red });
  };
  const { bus, events } = makeBusRecorder();
  const result = await runBriefGate({
    wctx: makeWctx({
      ...ref,
      workspaceDir: run.ws,
      bus,
      config: input.config ?? makeConfig(),
      validator: { formatChangedFiles: vi.fn().mockResolvedValue(undefined) },
    }),
    state,
    task: input.task,
    changedFiles: ['src/a.ts'],
    taskStartSnapshot: null,
    runCommand,
  });
  const rows = events.filter(
    (event): event is EngineEventOf<'full_suite'> =>
      event.type === 'full_suite' && event.status === 'done' && event.moment === 'brief',
  );
  return { result, commands, rows };
}

type Row = {
  name: string;
  own: Name[];
  red: Name[];
  rerun: Name[] | null;
  sibling?: { status: Task['status']; own: Name[]; cycle?: number };
  accepted: boolean;
  /** The fix check row's counts when it settles, or the first error line when it rejects. */
  verdict?: Record<string, unknown> | string;
};

const OTHERS =
  'other\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review';

const ROWS: Row[] = [
  {
    name: '1 the command passes: settles (unchanged)',
    own: ['own'],
    red: ['own', 'other'],
    rerun: null,
    accepted: true,
  },
  {
    name: '2 own gone, an original other failure shows: settles (unchanged)',
    own: ['own'],
    red: ['own', 'other'],
    rerun: ['other'],
    accepted: true,
    verdict: { own: 1, ownLeft: 0, deferred: 0, others: 1 },
  },
  {
    name: '3 own gone, original others gone with a done sibling, a new failure no brief owns: settles',
    own: ['own'],
    red: ['own', 'other'],
    rerun: ['fresh'],
    sibling: { status: 'done', own: ['other'] },
    accepted: true,
    verdict: { own: 1, ownLeft: 0, deferred: 0, others: 1 },
  },
  {
    name: '4 the red held only own failures, the re-run shows others, sibling pending: settles',
    own: ['own'],
    red: ['own'],
    rerun: ['other'],
    sibling: { status: 'pending', own: ['other'] },
    accepted: true,
  },
  {
    name: '5 a shared failure remains while its sibling is pending: settles and leaves it to the sibling',
    own: ['own', 'shared'],
    red: ['own', 'shared', 'other'],
    rerun: ['shared', 'other'],
    sibling: { status: 'pending', own: ['shared'] },
    accepted: true,
    verdict: { own: 2, ownLeft: 0, deferred: 1, deferredTo: ['T025'], others: 1 },
  },
  ...(['done', 'skipped', 'escalated'] as const).map(
    (status): Row => ({
      name: `6 a shared failure remains and its sibling is ${status}: rejects (unchanged, last carrier)`,
      own: ['own', 'shared'],
      red: ['own', 'shared', 'other'],
      rerun: ['shared', 'other'],
      sibling: { status, own: ['shared'] },
      accepted: false,
      verdict: `1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0remains, 1\u00a0${OTHERS}`,
    }),
  ),
  {
    name: '6 a shared failure remains and its sibling belongs to another cycle: rejects (unchanged)',
    own: ['own', 'shared'],
    red: ['own', 'shared', 'other'],
    rerun: ['shared', 'other'],
    sibling: { status: 'pending', own: ['shared'], cycle: 2 },
    accepted: false,
  },
  {
    name: '7 an own failure remains: rejects (unchanged)',
    own: ['own'],
    red: ['own', 'other'],
    rerun: ['own', 'other'],
    sibling: { status: 'pending', own: ['other'] },
    accepted: false,
    verdict: `your\u00a01\u00a0failure\u00a0remains, 1\u00a0${OTHERS}`,
  },
  {
    name: '12 a placeholder red: rejects (unchanged)',
    own: ['own'],
    red: ['own', 'other'],
    rerun: [],
    accepted: false,
  },
  {
    name: '14 own failure in a later stage, the brief breaks an earlier one, no sibling: settles',
    own: ['own'],
    red: ['own'],
    rerun: ['fresh'],
    accepted: true,
  },
];

describe.each(['reviewer', 'plan', 'test'] as const)(
  'a %s fix check',
  { timeout: 60_000 },
  (kind) => {
    const { id, check, command, key } = KINDS[kind];

    async function runRow(run: ApplyRun, row: Row) {
      const red =
        row.rerun === null
          ? null
          : row.rerun.length === 0
            ? 'Segmentation fault'
            : output(kind, row.rerun);
      return gate(run, {
        task: fixTask('T023', id, command, { own: row.own.map(key), red: row.red.map(key) }),
        others:
          row.sibling === undefined
            ? []
            : [
                sibling(id, command, {
                  status: row.sibling.status,
                  own: row.sibling.own.map(key),
                  ...(row.sibling.cycle !== undefined && { cycle: row.sibling.cycle }),
                }),
              ],
        checks: check === null ? [] : [check],
        red,
      });
    }

    it.each(ROWS)('$name', async (row) => {
      await withApplyRun(FILES, { sessionId: `own-${kind}` }, async (run) => {
        const { result } = await runRow(run, row);

        expect(result.acceptance.accepted).toBe(row.accepted);
        expect(result.state.tasks[0]?.checkResults).toEqual([
          { id, status: row.accepted ? 'pass' : 'fail' },
        ]);
      });
    });

    it.each(ROWS.filter((row) => row.verdict !== undefined))(
      'verdict of row $name',
      async (row) => {
        await withApplyRun(FILES, { sessionId: `own-${kind}-verdict` }, async (run) => {
          const { result, rows } = await runRow(run, row);

          if (typeof row.verdict === 'string') {
            expect(result.error.split('\n')[0]).toBe(
              `check ${id} did not pass (fail): ${row.verdict}`,
            );
          } else {
            expect(rows.at(-1)).toMatchObject({ id, passed: true, ...row.verdict });
            expect(rows.at(-1)).not.toHaveProperty('proven');
          }
        });
      },
    );

    it('10 a check the finding names without own failures, on a finding with failures for another check, does not gate', async () => {
      await withApplyRun(FILES, { sessionId: `own-${kind}-10` }, async (run) => {
        const ok: Check = { id: 'chk-ok', kind: 'cmd', value: 'node --version', required: true };
        const task = makeTask({
          id: 'T023',
          fix: {
            cycle: 1,
            findings: [
              {
                id: 'P1',
                text: 'Required check chk-ok did not pass.',
                acceptance: null,
                checkIds: ['chk-ok', id],
                commands: { 'chk-ok': 'node --version', [id]: command },
                failureKeys: { 'chk-ok': ['src/ok.ts(1,1): error TS1: broken'] },
                redKeys: { 'chk-ok': ['src/ok.ts(1,1): error TS1: broken'] },
              },
            ],
          },
        });
        const { result, rows } = await gate(run, {
          task,
          checks: [ok, ...(check === null ? [] : [check])],
          red: output(kind, ['other']),
        });

        expect(result.acceptance.accepted).toBe(true);
        expect(rows.find((row) => row.id === id)).toMatchObject({
          passed: true,
          own: 0,
          others: 1,
        });
      });
    });

    it('11 a finding saved without failures must pass its command (unchanged)', async () => {
      await withApplyRun(FILES, { sessionId: `own-${kind}-11` }, async (run) => {
        const { result } = await gate(run, {
          task: fixTask('T023', id, command, { own: null }),
          checks: check === null ? [] : [check],
          red: output(kind, ['other']),
        });

        expect(result.acceptance.accepted).toBe(false);
      });
    });
  },
);

describe('13 a fix check that does not run must pass (unchanged)', { timeout: 60_000 }, () => {
  it('a refused reviewer check', async () => {
    await withApplyRun(FILES, { sessionId: 'own-13-refused' }, async (run) => {
      const { result, commands } = await gate(run, {
        task: fixTask('T023', 'V2', 'npm run typecheck; rm -rf src', {
          own: [KINDS.reviewer.key('own')],
        }),
        red: null,
      });

      expect(commands).toEqual([]);
      expect(result.acceptance.accepted).toBe(false);
      expect(result.error).toMatch(/^check V2 did not pass \(refused\)/);
    });
  });

  it('an unknown plan check', async () => {
    await withApplyRun(FILES, { sessionId: 'own-13-unknown' }, async (run) => {
      const { result } = await gate(run, {
        task: fixTask('T023', 'chk-gone', 'tsc --noEmit', { own: [KINDS.plan.key('own')] }),
        red: null,
      });

      expect(result.acceptance.accepted).toBe(false);
      expect(result.error).toMatch(/^check chk-gone did not pass \(unknown\)/);
    });
  });

  it('a not-runnable test check', async () => {
    await withApplyRun(FILES, { sessionId: 'own-13-not-runnable' }, async (run) => {
      const task = fixTask('T023', 'chk-a', 'npm test', { own: [KINDS.test.key('own')] });
      const state = makeImplState([task], {
        workspace: run.workspace,
        plan: {
          summary: 's',
          decisions: [],
          criteria: [],
          checks: [KINDS.test.check].flatMap((check) => (check === null ? [] : [check])),
          validation: null,
        },
      });
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      saveState(ref, state);
      const result = await runBriefGate({
        wctx: makeWctx({
          ...ref,
          workspaceDir: run.ws,
          config: makeConfig(),
          validator: { formatChangedFiles: vi.fn().mockResolvedValue(undefined) },
        }),
        state,
        task,
        changedFiles: ['src/a.ts'],
        taskStartSnapshot: null,
        runCommand: async () => {
          throw Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
        },
      });

      expect(result.acceptance.accepted).toBe(false);
      expect(result.error).toMatch(/^check chk-a did not pass \(not-runnable\)/);
    });
  });
});

describe('the texts of a fix check that leaves failures to others', { timeout: 60_000 }, () => {
  const k = KINDS.reviewer.key;

  it('names the remaining own failure, the sibling a shared one is left to, and the others as not its job', async () => {
    await withApplyRun(FILES, { sessionId: 'own-text' }, async (run) => {
      const { result } = await gate(run, {
        task: fixTask('T023', 'V2', 'npm run typecheck', {
          own: [k('own'), k('shared')],
          red: [k('own'), k('shared'), k('other')],
        }),
        others: [sibling('V2', 'npm run typecheck', { status: 'pending', own: [k('shared')] })],
        red: output('reviewer', ['own', 'shared', 'other', 'fresh']),
      });

      expect(result.acceptance.accepted).toBe(false);
      expect(result.error).toContain(
        [
          'check V2 did not pass (fail): 1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0remains, 1\u00a0left\u00a0to\u00a0T025, 2\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review',
          'Your failures that remain:',
          `- ${k('own')}`,
          'Left to T025:',
          `- ${k('shared')}`,
          "Other failures, not this brief's job:",
          `- ${k('other')}`,
          `- ${k('fresh')}`,
          'Output tail:',
        ].join('\n'),
      );
      expect(result.diagnosis).toBe(
        'check V2 failed: 1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0remains, 1\u00a0left\u00a0to\u00a0T025, 2\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review',
      );
    });
  });

  it('settles with the row naming the sibling and keeps the full command for the next review', async () => {
    await withApplyRun(FILES, { sessionId: 'own-row' }, async (run) => {
      const { result, rows } = await gate(run, {
        task: fixTask('T023', 'V2', 'npm run typecheck', {
          own: [k('own'), k('shared')],
          red: [k('own'), k('shared'), k('other')],
        }),
        others: [sibling('V2', 'npm run typecheck', { status: 'pending', own: [k('shared')] })],
        red: output('reviewer', ['shared', 'other']),
      });

      expect(result.acceptance.accepted).toBe(true);
      expect(rows.at(-1)).toMatchObject({
        id: 'V2',
        command: 'npm run typecheck',
        passed: true,
        own: 2,
        ownLeft: 0,
        deferred: 1,
        deferredTo: ['T025'],
        others: 1,
      });
      expect(result.state.pendingReviewCommands).toEqual(['npm run typecheck']);
    });
  });
});

describe('the triage, split and rewrite shapes (rows 15-18)', { timeout: 60_000 }, () => {
  const k = (name: string) => `src/a.test.ts::${name}`;

  it('15 a pending input the review gives to two fix tasks leaves its remaining failure to the pending one', async () => {
    await withApplyRun(FILES, { sessionId: 'own-15' }, async (run) => {
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      const base = makeImplState([makeTask({ id: 'T001', status: 'done', batch: 1 })], {
        phase: 'final-review',
        currentTaskIndex: 1,
        fixCycles: { used: 0, allowance: 2, notes: [] },
        plan: {
          summary: 's',
          decisions: [],
          criteria: [{ id: 'C1', text: 'c', checkIds: ['chk-unit'] }],
          checks: [{ id: 'chk-unit', kind: 'cmd', value: 'npm test', required: true }],
          validation: null,
        },
      });
      const review = {
        cycle: 0,
        outcome: 'fail' as const,
        verification: [],
        at: '2026-10-25T00:00:00.000Z',
        verdict: {
          tasks: [{ id: taskId('T001'), plan: 'met' as const, note: '' }],
          criteria: [{ id: 'C1', status: 'fail' as const, evidence: '' }],
          findings: [],
        },
      };
      const state: WorkflowState = { ...base, review };
      saveState(ref, state);
      const input = {
        id: 'P1',
        kind: 'defect' as const,
        source: 'check' as const,
        text: 'Required check chk-unit did not pass',
        file: 'src/a.test.ts',
        checkIds: ['chk-unit'],
        command: 'npm test',
        failureKeys: [k('pause'), k('swap')],
        redKeys: [k('pause'), k('swap')],
      };
      const applied = applyTriage(
        {
          ...ref,
          workspaceDir: run.ws,
          metadata: { planner: 'p', implementer: 'i', reviewer: 'r' },
        },
        state,
        review,
        [input],
        {
          fixTasks: [
            {
              ...makeTaskSpec({ id: 'T023', suggestedFiles: ['src/a.test.ts'] }),
              findingIds: ['P1'],
            },
            { ...makeTaskSpec({ id: 'T025', suggestedFiles: ['src/a.ts'] }), findingIds: ['P1'] },
          ],
          rejected: [],
          verify: [],
          ask: null,
        },
      );
      const [t023, t025] = applied.tasks.filter((task) => task.fix !== undefined);
      if (t023 === undefined || t025 === undefined) throw new Error('missing fix tasks');

      const { result } = await gate(run, {
        task: t023,
        others: [t025],
        checks: [{ id: 'chk-unit', kind: 'cmd', value: 'npm test', required: true }],
        red: ' FAIL  src/a.test.ts > swap\nAssertionError: expected 1 to be 2',
      });

      expect(result.acceptance.accepted).toBe(true);
    });
  });

  function parentFix(): Task {
    return fixTask('T023', 'V2', 'npm run typecheck', {
      own: [KINDS.reviewer.key('own'), KINDS.reviewer.key('shared')],
    });
  }

  it('16 consult split children share the parent failures: the first child leaves them to the pending one, the last answers them', async () => {
    await withApplyRun(FILES, { sessionId: 'own-16' }, async (run) => {
      const split = transition(makeImplState([parentFix()]), {
        type: 'INSERT_TASKS',
        parentId: taskId('T023'),
        tasks: [makeTask({ id: 'T029' }), makeTask({ id: 'T030' })],
      });
      const [first, second] = split.tasks;
      if (first === undefined || second === undefined) throw new Error('missing children');
      const red = output('reviewer', ['shared']);

      const early = await gate(run, { task: first, others: [second], red });
      const last = await gate(run, {
        task: second,
        others: [{ ...first, status: 'done' }],
        red,
      });

      expect(early.result.acceptance.accepted).toBe(true);
      expect(last.result.acceptance.accepted).toBe(false);
    });
  });

  it('17 a consult rewrite keeps the failures and the sibling rule', async () => {
    await withApplyRun(FILES, { sessionId: 'own-17' }, async (run) => {
      const k2 = KINDS.reviewer.key;
      const rewritten = transition(
        makeImplState([
          parentFix(),
          sibling('V2', 'npm run typecheck', { status: 'pending', own: [k2('shared')] }),
        ]),
        {
          type: 'REPLACE_TASK',
          taskId: taskId('T023'),
          task: makeTask({ id: 'T023', description: 'Rewritten' }),
        },
      );
      const [task, pending] = rewritten.tasks;
      if (task === undefined || pending === undefined) throw new Error('missing tasks');

      const { result } = await gate(run, {
        task,
        others: [pending],
        red: output('reviewer', ['shared']),
      });

      expect(task.revision).toBe(2);
      expect(result.acceptance.accepted).toBe(true);
    });
  });

  it.each([
    ['pending', true],
    ['done', false],
  ] as const)(
    '18 an unassigned failure both briefs carry, sibling %s: accepted %s',
    async (status, accepted) => {
      await withApplyRun(FILES, { sessionId: `own-18-${status}` }, async (run) => {
        const task = fixTask('T023', 'V1', 'npm test', {
          own: ['src/a.test.ts', 'worker exits'],
        });
        const { result } = await gate(run, {
          task,
          others: [sibling('V1', 'npm test', { status, own: ['src/b.test.ts', 'worker exits'] })],
          red: 'TAP version 13\nnot ok 1 - worker exits\nnot ok 2 - src/b.test.ts\n',
        });

        expect(result.acceptance.accepted).toBe(accepted);
      });
    },
  );
});

describe('a fix check runs only the own test files of a test red (C)', { timeout: 60_000 }, () => {
  const k = (name: string) => `src/a.test.ts::${name}`;
  const testRed = ' FAIL  src/a.test.ts > other\nAssertionError: expected 1 to be 2';
  /** A TypeScript project with no pinned `validation.test_command`: its stack can select files. */
  const config = makeConfig({ validation: { testCommand: undefined } });
  const TS_FILES = { ...FILES, 'tsconfig.json': '{}\n' };

  it('narrows a reviewer test command to the own test files, and leaves the full command to the next review', async () => {
    await withApplyRun(TS_FILES, { sessionId: 'own-c-reviewer' }, async (run) => {
      const { result, commands, rows } = await gate(run, {
        task: fixTask('T023', 'V1', 'npm test', { own: [k('own')], red: [k('own'), k('other')] }),
        red: testRed,
        config,
      });

      expect(commands).toEqual(['npm test -- src/a.test.ts']);
      expect(rows.at(-1)).toMatchObject({ id: 'V1', command: 'npm test -- src/a.test.ts' });
      expect(result.acceptance.accepted).toBe(true);
      expect(result.state.pendingReviewCommands).toEqual(['npm test']);
    });
  });

  it('narrows a plan test command the same way', async () => {
    await withApplyRun(TS_FILES, { sessionId: 'own-c-plan' }, async (run) => {
      const { result, commands } = await gate(run, {
        task: fixTask('T023', 'chk-unit', 'npm test', { own: [k('own')] }),
        checks: [{ id: 'chk-unit', kind: 'cmd', value: 'npm test', required: true }],
        red: testRed,
        config,
      });

      expect(commands).toEqual(['npm test -- src/a.test.ts']);
      expect(result.acceptance.accepted).toBe(true);
    });
  });

  it('keeps the full command of a diagnostic check beside a narrowed test check', async () => {
    await withApplyRun(TS_FILES, { sessionId: 'own-c-mixed' }, async (run) => {
      const diag = KINDS.reviewer.key('own');
      const task = makeTask({
        id: 'T023',
        fix: {
          cycle: 1,
          findings: [
            {
              id: 'P1',
              text: 'Two reds',
              acceptance: null,
              checkIds: ['V1', 'V2'],
              commands: { V1: 'npm test', V2: 'npm run typecheck' },
              failureKeys: { V1: [k('own')], V2: [diag] },
              redKeys: { V1: [k('own')], V2: [diag] },
            },
          ],
        },
      });
      const { commands } = await gate(run, { task, red: null, config });

      expect(commands).toEqual(['npm test -- src/a.test.ts', 'npm run typecheck']);
    });
  });

  it('keeps the full command when the own failures mix tests and diagnostics', async () => {
    await withApplyRun(TS_FILES, { sessionId: 'own-c-mixed-keys' }, async (run) => {
      const { commands } = await gate(run, {
        task: fixTask('T023', 'V1', 'npm test', { own: [k('own'), 'src/a.ts(1,1): error TS1: x'] }),
        red: null,
        config,
      });

      expect(commands).toEqual(['npm test']);
    });
  });

  it('keeps the full command when the red command is not the stack test command', async () => {
    await withApplyRun(TS_FILES, { sessionId: 'own-c-other-script' }, async (run) => {
      const { commands } = await gate(run, {
        task: fixTask('T023', 'V1', 'npm run test:integration', { own: [k('own')] }),
        red: null,
        config,
      });

      expect(commands).toEqual(['npm run test:integration']);
    });
  });

  it('keeps the full command on a stack whose test runner the registry does not know', async () => {
    const files = { Makefile: 'test:\n\t./run-tests\n', 'src/a.test.ts': 'x\n' };
    await withApplyRun(files, { sessionId: 'own-c-unknown-stack' }, async (run) => {
      const { commands } = await gate(run, {
        task: fixTask('T023', 'V1', 'make test', { own: [k('own')] }),
        red: null,
        config,
      });

      expect(commands).toEqual(['make test']);
    });
  });

  it('keeps the full command when validation.test_command pins it', async () => {
    await withApplyRun(TS_FILES, { sessionId: 'own-c-pinned' }, async (run) => {
      const { commands } = await gate(run, {
        task: fixTask('T023', 'V1', 'npm test', { own: [k('own')] }),
        red: null,
        config: makeConfig({ validation: { testCommand: 'npm test' } }),
      });

      expect(commands).toEqual(['npm test']);
    });
  });
});

describe('a failure a sibling carries under another check id', { timeout: 60_000 }, () => {
  const UNIT: Check = { id: 'chk-unit', kind: 'cmd', value: 'npm test', required: true };
  const k = (name: string) => `src/a.test.ts::${name}`;
  const KEYS = [k('pause'), k('swap')];
  const red = (...names: string[]) =>
    names
      .map((name) => ` FAIL  src/a.test.ts > ${name}\nAssertionError: expected 1 to be 2`)
      .join('\n');

  function input(id: string, checkId: string, command: string): TriageInput {
    return {
      id,
      kind: 'defect',
      source: 'check',
      text: `Check ${checkId} (${command}) failed.`,
      file: 'src/a.test.ts',
      checkIds: [checkId],
      command,
      failureKeys: KEYS,
      redKeys: KEYS,
    };
  }

  /** Fix tasks T002 (`a`) and T003 (`b`) of one review, through the public triage. */
  function triage(
    run: ApplyRun,
    assign: { a: string[]; b: string[] },
    options: { v1Command?: string; verdictFinding?: { id: string; checkIds: string[] } } = {},
  ): { a: Task; b: Task } {
    const v1Command = options.v1Command ?? 'npm test';
    const ref = { projectDir: run.dir, sessionId: run.sessionId };
    const state = makeImplState([makeTask({ id: 'T001', status: 'done', batch: 1 })], {
      phase: 'final-review',
      currentTaskIndex: 1,
      fixCycles: { used: 0, allowance: 2, notes: [] },
      plan: { summary: 's', decisions: [], criteria: [], checks: [UNIT], validation: null },
      reviewChecks: {
        scope: 'final',
        cycle: 0,
        plan: {
          commands: [{ id: 'V1', command: v1Command, reason: 'r' }],
          declined: [],
          reason: null,
        },
        at: '2026-10-25T00:00:00.000Z',
      },
    });
    saveState(ref, state);
    const verdict = options.verdictFinding;
    const review =
      verdict === undefined
        ? undefined
        : {
            cycle: 0,
            outcome: 'fail' as const,
            verification: [],
            at: '2026-10-25T00:00:00.000Z',
            verdict: {
              tasks: [{ id: taskId('T001'), plan: 'met' as const, note: '' }],
              criteria: [],
              findings: [
                {
                  id: verdict.id,
                  kind: 'defect' as const,
                  severity: 'blocking' as const,
                  taskId: null,
                  file: 'src/a.test.ts',
                  line: null,
                  text: 'The pause and swap tests fail.',
                  acceptance: 'The tests pass.',
                  checkIds: verdict.checkIds,
                  criterionId: null,
                },
              ],
            },
          };
    const applied = applyTriage(
      { ...ref, workspaceDir: run.ws, metadata: { planner: 'p', implementer: 'i', reviewer: 'r' } },
      state,
      review,
      [input('P1', 'chk-unit', 'npm test'), input('V1.1', 'V1', v1Command)],
      {
        fixTasks: [
          {
            ...makeTaskSpec({ id: 'T002', suggestedFiles: ['src/a.test.ts'] }),
            findingIds: assign.a,
          },
          { ...makeTaskSpec({ id: 'T003', suggestedFiles: ['src/a.ts'] }), findingIds: assign.b },
        ],
        rejected: [],
        verify: [],
        ask: null,
      },
    );
    const [a, b] = applied.tasks;
    if (a === undefined || b === undefined) throw new Error('missing fix tasks');
    return { a, b };
  }

  /** A fix task with one finding per check id; a check without `command` is an older saved red. */
  function carrier(
    id: string,
    checks: Record<string, { command?: string; keys: string[] }>,
    extra: Partial<Task> = {},
  ): Task {
    return makeTask({
      id,
      suggestedFiles: ['src/a.ts'],
      fix: {
        cycle: 1,
        findings: Object.entries(checks).map(([checkId, { command, keys }]) => ({
          id: `${id}.${checkId}`,
          text: `Check ${checkId} failed.`,
          acceptance: null,
          file: 'src/a.test.ts',
          checkIds: [checkId],
          ...(command !== undefined && { commands: { [checkId]: command } }),
          failureKeys: { [checkId]: keys },
          redKeys: { [checkId]: keys },
        })),
      },
      ...extra,
    });
  }

  const verdicts = (rows: EngineEventOf<'full_suite'>[]) =>
    Object.fromEntries(
      rows.map((row) => [row.id, { passed: row.passed, deferredTo: row.deferredTo }]),
    );
  const leftToT003 = { passed: true, deferredTo: ['T003'] };

  it('1 the plan check brief settles when the sibling carries the failure under a reviewer check of the same command', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-1' }, async (run) => {
      const { a, b } = triage(run, { a: ['P1'], b: ['V1.1'] });
      const { result, rows } = await gate(run, {
        task: a,
        others: [b],
        checks: [UNIT],
        red: red('swap'),
      });

      expect(result.acceptance.accepted).toBe(true);
      expect(verdicts(rows)).toEqual({ 'chk-unit': leftToT003 });
    });
  });

  it('1 the reviewer check brief settles when the sibling carries the failure under a plan check of the same command', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-1r' }, async (run) => {
      const { a, b } = triage(run, { a: ['V1.1'], b: ['P1'] });
      const { result, rows } = await gate(run, {
        task: a,
        others: [b],
        checks: [UNIT],
        red: red('swap'),
      });

      expect(result.acceptance.accepted).toBe(true);
      expect(verdicts(rows)).toEqual({ V1: leftToT003 });
    });
  });

  it.each([
    ['2 the sibling carries it under the reviewer id only', ['V1.1']],
    ['3 the sibling carries it under the plan id only', ['P1']],
    ['4 the sibling carries it under both ids (unchanged)', ['P1', 'V1.1']],
  ])('%s: both rows leave it to the sibling', async (_name, b) => {
    await withApplyRun(FILES, { sessionId: 'xid-2' }, async (run) => {
      const tasks = triage(run, { a: ['P1', 'V1.1'], b });
      const { result, rows } = await gate(run, {
        task: tasks.a,
        others: [tasks.b],
        checks: [UNIT],
        red: red('swap'),
      });

      expect(result.acceptance.accepted).toBe(true);
      expect(verdicts(rows)).toEqual({ 'chk-unit': leftToT003, V1: leftToT003 });
    });
  });

  it('5 the last carrier still answers the failure (unchanged)', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-5' }, async (run) => {
      const { a, b } = triage(run, { a: ['P1'], b: ['V1.1'] });
      const { result } = await gate(run, {
        task: b,
        others: [{ ...a, status: 'done' }],
        checks: [UNIT],
        red: red('swap'),
      });

      expect(result.acceptance.accepted).toBe(false);
    });
  });

  it.each([
    ['done', 1],
    ['skipped', 1],
    ['escalated', 1],
    ['pending', 2],
  ] as const)(
    '6 a sibling that is %s in cycle %i is not a carrier (unchanged)',
    async (status, cycle) => {
      await withApplyRun(FILES, { sessionId: `xid-6-${status}` }, async (run) => {
        const { a, b } = triage(run, { a: ['P1'], b: ['V1.1'] });
        const fix = b.fix;
        if (fix === undefined) throw new Error('missing fix');
        const { result } = await gate(run, {
          task: a,
          others: [{ ...b, status, fix: { ...fix, cycle } }],
          checks: [UNIT],
          red: red('swap'),
        });

        expect(result.acceptance.accepted).toBe(false);
      });
    },
  );

  it('7 the same test key under a different command is not shared (unchanged)', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-7' }, async (run) => {
      const { a, b } = triage(
        run,
        { a: ['P1'], b: ['V1.1'] },
        { v1Command: 'npm run test:integration' },
      );
      const { result } = await gate(run, {
        task: a,
        others: [b],
        checks: [UNIT],
        red: red('swap'),
      });

      expect(result.acceptance.accepted).toBe(false);
    });
  });

  it('8 the same diagnostic key under a different command is not shared (unchanged)', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-8' }, async (run) => {
      const diag = KINDS.plan.key('shared');
      const { result } = await gate(run, {
        task: carrier('T002', { 'chk-types': { command: 'tsc --noEmit', keys: [diag] } }),
        others: [carrier('T003', { V1: { command: 'npm run typecheck', keys: [diag] } })],
        checks: KINDS.plan.check === null ? [] : [KINDS.plan.check],
        red: diag,
      });

      expect(result.acceptance.accepted).toBe(false);
    });
  });

  it('9 the own failures gone settles (unchanged)', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-9' }, async (run) => {
      const { a, b } = triage(run, { a: ['P1'], b: ['V1.1'] });
      const { result } = await gate(run, {
        task: a,
        others: [b],
        checks: [UNIT],
        red: red('other'),
      });

      expect(result.acceptance.accepted).toBe(true);
    });
  });

  it('10 a plan test check shares with a reviewer check that ran the same command', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-10' }, async (run) => {
      const command = KINDS.test.command;
      const { result } = await gate(run, {
        task: carrier('T002', { 'chk-a': { command, keys: KEYS } }),
        others: [carrier('T003', { V1: { command, keys: KEYS } })],
        checks: KINDS.test.check === null ? [] : [KINDS.test.check],
        red: red('swap'),
      });

      expect(result.acceptance.accepted).toBe(true);
    });
  });

  it('11 a verdict finding that names the plan check records its command and shares', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-11' }, async (run) => {
      const { a, b } = triage(
        run,
        { a: ['F7'], b: ['V1.1'] },
        { verdictFinding: { id: 'F7', checkIds: ['chk-unit'] } },
      );
      const { result } = await gate(run, {
        task: a,
        others: [b],
        checks: [UNIT],
        red: red('swap'),
      });

      expect(a.fix?.findings[0]?.commands).toEqual({ 'chk-unit': 'npm test' });
      expect(result.acceptance.accepted).toBe(true);
    });
  });

  it.each([
    ['the brief', 'T002'],
    ['the sibling', 'T003'],
  ])(
    '12 %s saved without a red command keeps the same-id rule (unchanged)',
    async (_name, older) => {
      await withApplyRun(FILES, { sessionId: `xid-12-${older}` }, async (run) => {
        const commandOf = (id: string) => (id === older ? {} : { command: 'npm test' });
        const { result } = await gate(run, {
          task: carrier('T002', { 'chk-unit': { ...commandOf('T002'), keys: KEYS } }),
          others: [carrier('T003', { V1: { ...commandOf('T003'), keys: KEYS } })],
          checks: [UNIT],
          red: red('swap'),
        });

        expect(result.acceptance.accepted).toBe(false);
      });
    },
  );

  it('13 a narrowed gate run still shares by the command of the review red', async () => {
    await withApplyRun(
      { ...FILES, 'tsconfig.json': '{}\n' },
      { sessionId: 'xid-13' },
      async (run) => {
        const { result, commands } = await gate(run, {
          task: carrier('T002', { 'chk-unit': { command: 'npm test', keys: KEYS } }),
          others: [carrier('T003', { V1: { command: 'npm test', keys: KEYS } })],
          checks: [UNIT],
          red: red('swap'),
          config: makeConfig({ validation: { testCommand: undefined } }),
        });

        expect(commands).toEqual(['npm test -- src/a.test.ts']);
        expect(result.acceptance.accepted).toBe(true);
      },
    );
  });

  it('14 the last child of a consult split leaves the failure to the sibling under the other id', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-14-split' }, async (run) => {
      const { a, b } = triage(run, { a: ['P1'], b: ['V1.1'] });
      const split = transition(makeImplState([a, b]), {
        type: 'INSERT_TASKS',
        parentId: a.id,
        tasks: [makeTask({ id: 'T029' }), makeTask({ id: 'T030' })],
      });
      const [first, last] = split.tasks;
      if (first === undefined || last === undefined) throw new Error('missing children');

      const { result } = await gate(run, {
        task: last,
        others: [{ ...first, status: 'done' }, b],
        checks: [UNIT],
        red: red('swap'),
      });

      expect(result.acceptance.accepted).toBe(true);
    });
  });

  it('14 a consult rewrite leaves the failure to the sibling under the other id', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-14-rewrite' }, async (run) => {
      const { a, b } = triage(run, { a: ['P1'], b: ['V1.1'] });
      const rewritten = transition(makeImplState([a, b]), {
        type: 'REPLACE_TASK',
        taskId: a.id,
        task: makeTask({ id: a.id, description: 'Rewritten' }),
      });
      const [task] = rewritten.tasks;
      if (task === undefined) throw new Error('missing task');

      const { result } = await gate(run, { task, others: [b], checks: [UNIT], red: red('swap') });

      expect(result.acceptance.accepted).toBe(true);
    });
  });

  it('the verdict row and the --plain line name the sibling', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-row' }, async (run) => {
      const { a, b } = triage(run, { a: ['P1'], b: ['V1.1'] });
      const { rows } = await gate(run, { task: a, others: [b], checks: [UNIT], red: red('swap') });
      const event = rows.at(-1);
      if (event === undefined) throw new Error('missing row');
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      createStdoutTextSink({ output })(event);

      expect(
        fullSuiteSegments(event)
          .map((segment) => segment.text)
          .join(''),
      ).toContain('1 of your 2 failures gone · 1 left to T003');
      expect(chunks.join('').split('\n')).toContain(
        'fix check chk-unit: 1 of your 2 failures gone · 1 left to T003 (npm test)',
      );
    });
  });

  it('the retry text and the diagnosis list the failure under the sibling, not as the brief own', async () => {
    await withApplyRun(FILES, { sessionId: 'xid-text' }, async (run) => {
      const { result } = await gate(run, {
        task: carrier('T002', { 'chk-unit': { command: 'npm test', keys: KEYS } }),
        others: [carrier('T003', { V1: { command: 'npm test', keys: [k('swap')] } })],
        checks: [UNIT],
        red: red('pause', 'swap'),
      });
      const verdict = '1 of your 2 failures remains, 1 left to T003';

      expect(result.acceptance.accepted).toBe(false);
      expect(result.error).toContain(
        [
          `check chk-unit did not pass (fail): ${verdict}`,
          'Your failures that remain:',
          `- ${k('pause')}`,
          '  AssertionError: expected 1 to be 2',
          'Left to T003:',
          `- ${k('swap')}`,
        ].join('\n'),
      );
      expect(result.diagnosis).toBe(`check chk-unit failed: ${verdict}`);
    });
  });
});
