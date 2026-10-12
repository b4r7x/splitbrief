import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { PlanProposalSchema, type PlanProposal } from '../../core/schemas/plan.js';
import { checkPlan, planRepairWarning, renderCheckNotes, type PlanTaskFit } from './plan-checks.js';

const projectDir = '/repo';
const k2 = [{ id: 'K2', kind: 'test' as const, value: 'src/b.test.ts', required: true }];
const fits = new Map<string, PlanTaskFit>([
  ['T001', { fit: 'fits' }],
  ['T002', { fit: 'tight' }],
]);

function codes(plan: PlanProposal, contextFits = fits, dir = projectDir): string[] {
  return checkPlan(plan, dir, contextFits, undefined).map((error) => error.code);
}

describe('planRepairWarning', () => {
  it.each(['Criterion C2 is served by no task.', 'Criterion C2 is served by no task'])(
    'embeds the check message without a trailing full stop: %s',
    (message) => {
      for (const more of [
        [],
        [{ code: 'empty-plan', message: 'The plan has no task.' }],
      ] as const) {
        const first = { code: 'uncovered-criterion', message } as const;
        const warning = planRepairWarning([first, ...more]);
        expect(warning.message).toBe(
          `The plan failed check uncovered-criterion: Criterion C2 is served by no task${more.length > 0 ? ' (+1 more)' : ''}; it goes back to the planner once.`,
        );
        expect(warning.planCheck).toEqual({ code: 'uncovered-criterion', message });
      }
    },
  );
});

describe('checkPlan', () => {
  it('passes a plan whose tasks cover every criterion and fit BUILD, tight included', () => {
    const plan = makePlanProposal({
      checks: [{ id: 'K9', kind: 'cmd', value: 'npm test', required: true }],
      criteria: [{ id: 'C1', text: 'Greets', checkIds: ['K1', 'K9'] }],
      tasks: [
        makeTaskSpec(),
        makeTaskSpec({
          id: 'T002',
          dependsOn: ['T001'],
          batch: 2,
          checks: k2,
        }),
      ],
    });
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([]);
  });

  it('names a criterion no task serves and a task reference to an unknown criterion', () => {
    const plan = makePlanProposal({
      criteria: [
        { id: 'C1', text: 'Greets', checkIds: ['K1'] },
        { id: 'C2', text: 'Logs', checkIds: ['K1'] },
      ],
      tasks: [makeTaskSpec({ criteria: ['C1', 'C7'] })],
    });
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([
      { code: 'uncovered-criterion', message: 'Criterion C2 is served by no task.' },
      { code: 'unknown-criterion', message: 'Task T001 serves unknown criterion C7.' },
    ]);
  });

  it('refuses a plan with no task or no criterion', () => {
    expect(codes(makePlanProposal({ criteria: [], tasks: [] }))).toEqual([
      'empty-plan',
      'empty-plan',
    ]);
  });

  it('refuses a task that serves no criterion and a task whose intent is blank', () => {
    const plan = makePlanProposal({
      tasks: [
        makeTaskSpec(),
        makeTaskSpec({ id: 'T002', criteria: [], intent: '  \n ', checks: k2 }),
      ],
    });
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([
      { code: 'task-without-criterion', message: 'Task T002 serves no criterion.' },
      { code: 'task-without-intent', message: 'Task T002 has no intent.' },
    ]);
  });

  it('refuses a criterion without checkIds and one naming an unknown check', () => {
    const plan = makePlanProposal({
      criteria: [
        { id: 'C1', text: 'Greets', checkIds: [] },
        { id: 'C2', text: 'Logs', checkIds: ['K404'] },
      ],
      tasks: [makeTaskSpec({ criteria: ['C1', 'C2'] })],
    });
    expect(codes(plan)).toEqual(['criterion-without-check', 'unknown-check']);
  });

  it('refuses duplicate task ids and a check id used twice across the run and a task', () => {
    const plan = makePlanProposal({
      checks: [{ id: 'K1', kind: 'cmd', value: 'npm test', required: true }],
      tasks: [makeTaskSpec(), makeTaskSpec({ checks: [] })],
    });
    expect(codes(plan)).toEqual(['duplicate-task-id', 'duplicate-check-id', 'task-without-check']);
  });

  it('refuses a plan check id in the V range the reviewer checks use, once per id', () => {
    const v1 = { id: 'V1', kind: 'cmd' as const, value: 'npm test', required: true };
    const plan = makePlanProposal({
      checks: [v1],
      tasks: [makeTaskSpec({ checks: [{ ...v1, id: 'V2' }] })],
    });
    expect(
      checkPlan(plan, projectDir, fits, undefined).filter(
        (error) => error.code === 'reserved-check-id',
      ),
    ).toEqual([
      {
        code: 'reserved-check-id',
        message: "Check id V1 is reserved for the reviewer's checks (V1, V2, …).",
      },
      {
        code: 'reserved-check-id',
        message: "Check id V2 is reserved for the reviewer's checks (V1, V2, …).",
      },
    ]);
  });

  it('refuses an unknown dependency, a dependency on a later batch and a cycle', () => {
    expect(codes(makePlanProposal({ tasks: [makeTaskSpec({ dependsOn: ['T009'] })] }))).toEqual([
      'unknown-dependency',
    ]);
    const later = makePlanProposal({
      tasks: [
        makeTaskSpec({ dependsOn: ['T002'] }),
        makeTaskSpec({ id: 'T002', batch: 2, checks: k2 }),
      ],
    });
    expect(codes(later)).toEqual(['dependency-later-batch']);
    const cycle = makePlanProposal({
      tasks: [
        makeTaskSpec({ dependsOn: ['T002'] }),
        makeTaskSpec({ id: 'T002', dependsOn: ['T001'], checks: k2 }),
      ],
    });
    const [cycleError, ...rest] = checkPlan(cycle, projectDir, fits, undefined);
    expect(rest).toEqual([]);
    expect(cycleError?.code).toBe('dependency-cycle');
    expect(cycleError?.message).toMatch(/T001.*T002.*T001/);
  });

  it('refuses a plan whose task order is not the build order', () => {
    const plan = makePlanProposal({
      tasks: [
        makeTaskSpec({ dependsOn: ['T002'] }),
        makeTaskSpec({ id: 'T002', checks: k2 }),
        makeTaskSpec({
          id: 'T003',
          batch: 2,
          checks: [{ id: 'K3', kind: 'test', value: 'src/c.test.ts', required: true }],
        }),
        makeTaskSpec({
          id: 'T004',
          checks: [{ id: 'K4', kind: 'test', value: 'src/d.test.ts', required: true }],
        }),
      ],
    });
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([
      {
        code: 'batch-out-of-order',
        message: 'Task T004 (batch 1) comes after T003 (batch 2); list the tasks in batch order.',
      },
      {
        code: 'dependency-later-task',
        message: 'Task T001 depends on T002, which is listed after it; list T002 first.',
      },
    ]);
  });

  it('refuses a suggested, context or protected file outside the project', () => {
    const plan = makePlanProposal({
      tasks: [
        makeTaskSpec({
          suggestedFiles: ['../x.ts'],
          contextFiles: ['/etc/passwd'],
          protectedOperations: [{ path: '../.env', operation: 'write' }],
        }),
      ],
    });
    expect(codes(plan)).toEqual([
      'path-outside-project',
      'path-outside-project',
      'path-outside-project',
    ]);
  });

  it('refuses a protected operation whose write asks for nothing, spelled as the gate spells it', () => {
    const plan = PlanProposalSchema.parse(
      makePlanProposal({
        tasks: [
          makeTaskSpec({
            protectedOperations: [
              { path: './src/a.ts', operation: 'write' },
              { path: 'src/../package.json', operation: 'write' },
            ],
          }),
        ],
      }),
    );
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([
      {
        code: 'unprotected-operation',
        message:
          'Task T001 lists write src/a.ts as a protected operation, but writing it asks for nothing; drop it from protectedOperations.',
      },
    ]);
  });

  it('refuses a suggested write to a protected path the task does not list as a protected operation', () => {
    const plan = makePlanProposal({
      tasks: [makeTaskSpec({ suggestedFiles: ['src/hello.ts', 'package.json'] })],
    });
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([
      {
        code: 'unlisted-protected-operation',
        message:
          'Task T001 writes package.json, a protected path, without listing it in protectedOperations; list { path: "package.json", operation: "write" }.',
      },
    ]);
  });

  it('passes a suggested write to a protected path the task lists as a protected operation', () => {
    const plan = makePlanProposal({
      tasks: [
        makeTaskSpec({
          suggestedFiles: ['src/hello.ts', 'package.json'],
          protectedOperations: [{ path: 'package.json', operation: 'write' }],
        }),
      ],
    });
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([]);
  });

  it('refuses a task over BUILD’s context and only that label', () => {
    const plan = makePlanProposal();
    const overflow = new Map([['T001', { fit: 'overflow', blocked: 'too big' } as const]]);
    expect(checkPlan(plan, projectDir, overflow, undefined)).toEqual([
      {
        code: 'context-overflow',
        message: 'Task T001 does not fit the BUILD model’s context; split it.',
      },
    ]);
  });

  it('refuses a task that fits but that no implementer can take, with the routing reason', () => {
    const plan = makePlanProposal();
    const blocked = new Map([['T001', { fit: 'fits', blocked: 'No capable profile' } as const]]);
    expect(checkPlan(plan, projectDir, blocked, undefined)).toEqual([
      {
        code: 'no-capable-worker',
        message: 'Task T001 has no implementer that can take it: No capable profile.',
      },
    ]);
  });

  it('refuses a criterion id used twice', () => {
    const plan = makePlanProposal({
      criteria: [
        { id: 'C1', text: 'x', checkIds: ['K1'] },
        { id: 'C1', text: 'y', checkIds: ['K1'] },
      ],
    });
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([
      { code: 'duplicate-criterion-id', message: 'Criterion id C1 is used twice.' },
    ]);
  });
});

describe('checkPlan on the files of the checkout', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  function checkout(): string {
    const dir = createTempDir('plan-checks');
    dirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    return dir;
  }

  it('refuses a directory named as a context file or a suggested file', () => {
    const dir = checkout();
    const plan = makePlanProposal({
      tasks: [makeTaskSpec({ suggestedFiles: ['src/hello.ts', 'src'], contextFiles: ['src'] })],
    });
    expect(checkPlan(plan, dir, fits, undefined)).toEqual([
      { code: 'path-not-file', message: 'Task T001 names src, which is not a regular file.' },
      { code: 'path-not-file', message: 'Task T001 names src, which is not a regular file.' },
    ]);
  });

  it('refuses a context file that does not exist and that no task before it writes', () => {
    const dir = checkout();
    const plan = makePlanProposal({
      tasks: [makeTaskSpec({ contextFiles: ['src/a.ts', 'src/gone.ts'] })],
    });
    expect(checkPlan(plan, dir, fits, undefined)).toEqual([
      {
        code: 'missing-context-file',
        message:
          'Task T001 reads src/gone.ts, which does not exist and neither this task nor an earlier one writes.',
      },
    ]);
  });

  it('passes a suggested file the task creates and a context file this or an earlier task writes', () => {
    const dir = checkout();
    const plan = makePlanProposal({
      criteria: [{ id: 'C1', text: 'Greets', checkIds: ['K1'] }],
      tasks: [
        makeTaskSpec({ suggestedFiles: ['src/new.ts'], contextFiles: ['src/new.ts'] }),
        makeTaskSpec({
          id: 'T002',
          dependsOn: ['T001'],
          batch: 2,
          checks: k2,
          suggestedFiles: ['src/b.ts'],
          contextFiles: ['src/new.ts', 'src/a.ts'],
        }),
      ],
    });
    expect(checkPlan(plan, dir, fits, undefined)).toEqual([]);
  });

  it('reads a file an earlier task writes however the plan spells the path', () => {
    const dir = checkout();
    const plan = PlanProposalSchema.parse(
      makePlanProposal({
        tasks: [
          makeTaskSpec({ suggestedFiles: ['./src/new.ts'] }),
          makeTaskSpec({
            id: 'T002',
            dependsOn: ['T001'],
            batch: 2,
            checks: k2,
            suggestedFiles: ['src/b.ts'],
            contextFiles: ['src/new.ts'],
          }),
        ],
      }),
    );
    expect(checkPlan(plan, dir, fits, undefined)).toEqual([]);
  });

  it('names the context files of a task over BUILD’s context and their size', () => {
    const dir = checkout();
    writeFileSync(join(dir, 'src', 'big.ts'), 'x'.repeat(36_000));
    const plan = makePlanProposal({
      tasks: [makeTaskSpec({ contextFiles: ['src/big.ts', 'src/a.ts'] })],
    });
    expect(
      checkPlan(plan, dir, new Map([['T001', { fit: 'overflow' } as const]]), undefined),
    ).toEqual([
      {
        code: 'context-overflow',
        message:
          'Task T001 does not fit the BUILD model’s context. Its context files go in with it: src/big.ts (36,000 characters), src/a.ts (20 characters). Narrow or drop contextFiles, or split the task.',
      },
    ]);
  });

  it.each([['.github/workflows/*.yml'], ['.github/'], ['.github/workflows'], ['package.json/']])(
    'refuses the protected operation %s, which names no one exact file',
    (listed) => {
      const dir = checkout();
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
      writeFileSync(join(dir, 'package.json'), '{}\n');
      const plan = PlanProposalSchema.parse(
        makePlanProposal({
          tasks: [makeTaskSpec({ protectedOperations: [{ path: listed, operation: 'write' }] })],
        }),
      );
      expect(codes(plan, fits, dir)).toEqual(['protected-path-not-file']);
    },
  );

  it('checks differently cased protected paths against the checkout filesystem', () => {
    const dir = checkout();
    writeFileSync(join(dir, 'package.json'), '{}\n');
    const plan = PlanProposalSchema.parse(
      makePlanProposal({
        tasks: [
          makeTaskSpec({ protectedOperations: [{ path: 'Package.json', operation: 'write' }] }),
        ],
      }),
    );
    expect(codes(plan, fits, dir)).toEqual(
      existsSync(join(dir, 'Package.json')) ? ['protected-path-not-file'] : [],
    );
  });

  it('flags every render check, run-level and task-level, when validation.render is not set', () => {
    const plan = makePlanProposal({
      checks: [{ id: 'K-render', kind: 'render', value: 'overlay-picker', required: true }],
      criteria: [{ id: 'C1', text: 'Greets', checkIds: ['K1', 'K-render'] }],
      tasks: [
        makeTaskSpec({
          checks: [
            { id: 'K1', kind: 'test', value: 'src/hello.test.ts', required: true },
            { id: 'T001-K2', kind: 'render', value: 'home', required: false },
          ],
        }),
      ],
    });
    expect(checkPlan(plan, projectDir, fits, undefined)).toEqual([
      {
        code: 'render-check-unconfigured',
        message:
          'Render checks K-render, T001-K2 need validation.render, which is not set; drop them or ask the user.',
      },
    ]);
    expect(
      checkPlan(plan, projectDir, fits, 'npm run tui-shots -- --scenario {id} --output {out}'),
    ).toEqual([]);
  });

  it('words the planner reason and the card note in the number of render checks', () => {
    const one = makePlanProposal({
      checks: [{ id: 'K-render', kind: 'render', value: 'overlay-picker', required: true }],
      criteria: [{ id: 'C1', text: 'Greets', checkIds: ['K1', 'K-render'] }],
    });
    const two = makePlanProposal({
      checks: [
        { id: 'K-a', kind: 'render', value: 'home', required: true },
        { id: 'K-b', kind: 'render', value: 'overlay-picker', required: true },
      ],
      criteria: [{ id: 'C1', text: 'Greets', checkIds: ['K1', 'K-a', 'K-b'] }],
    });

    expect(checkPlan(one, projectDir, fits, undefined).map((error) => error.message)).toEqual([
      'Render check K-render needs validation.render, which is not set; drop it or ask the user.',
    ]);
    expect(renderCheckNotes(one, undefined)).toEqual([
      'Render check K-render needs validation.render, which is not set. Add it to .splitbrief/config.yaml, or request changes to drop it; without it the run halts before its review.',
    ]);
    expect(renderCheckNotes(two, undefined)).toEqual([
      'Render checks K-a, K-b need validation.render, which is not set. Add it to .splitbrief/config.yaml, or request changes to drop them; without it the run halts before its review.',
    ]);
    expect(renderCheckNotes(two, 'render {id} {out}')).toEqual([]);
  });
});
