import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Task } from '../schemas/task.js';
import {
  fixBriefDescription,
  fixCheckKeys,
  fixCheckVerdict,
  fixReviewChecks,
  fileFromFailureKey,
  judgeFixCheck,
  type FixCheckCounts,
} from './fix-task.js';

describe('fixBriefDescription', () => {
  it('prints each carried command with its check id', () => {
    const description = fixBriefDescription('Fix the checks', [
      {
        id: 'F1',
        text: 'Both checks failed',
        acceptance: null,
        checkIds: ['V1', 'V2'],
        commands: { V1: 'tsc --noEmit', V2: 'npm test' },
      },
    ]);

    expect(description).toContain('Command V1: tsc --noEmit\nCommand V2: npm test');
  });

  it('fences a failing output with more backticks than any run inside it', () => {
    const output = 'expected:\n```ts\nhello()\n```\nreceived: ````';
    const description = fixBriefDescription('Fix the greeting', [
      { id: 'P1', text: 'The test failed', acceptance: null, output },
    ]);

    const fence = '`'.repeat(5);
    expect(description).toContain(`Failing output:\n${fence}\n${output}\n${fence}`);
  });
  it('names the failures the brief fixes and leaves every other failure to others', () => {
    const description = fixBriefDescription('Fix the tests', [
      {
        id: 'P1',
        text: 'Required check V1 did not pass',
        acceptance: null,
        checkIds: ['V1'],
        commands: { V1: 'npm test' },
        failureKeys: { V1: ['src/a.test.ts::adds', 'src/a.test.ts::subtracts'] },
        redKeys: { V1: ['src/a.test.ts::adds', 'src/a.test.ts::subtracts', 'src/b.test.ts::x'] },
        output: 'FAIL src/a.test.ts > adds',
      },
    ]);

    expect(description).toContain(
      [
        'Your failures, which this brief fixes:',
        '- V1: src/a.test.ts::adds',
        '- V1: src/a.test.ts::subtracts',
        'Other failures of these commands are not your job; their fix tasks or the next review answer them.',
      ].join('\n'),
    );
    expect(description).not.toContain('src/b.test.ts::x');
  });

  it('adds no failure list to a brief whose findings carry no failures', () => {
    const description = fixBriefDescription('Fix it', [
      { id: 'F1', text: 'A defect', acceptance: null },
    ]);

    expect(description).not.toContain('Your failures');
    expect(description).not.toContain('not your job; their fix tasks');
  });
});

describe('fixReviewChecks', () => {
  it('returns no reviewer check when a finding carries no commands', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [{ id: 'F1', text: 'A check failed', acceptance: null, checkIds: ['V1'] }],
      },
    });

    expect(fixReviewChecks(task)).toEqual([]);
  });

  it('leaves a plan check to the plan registry', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'F1',
            text: 'A plan check failed',
            acceptance: null,
            checkIds: ['K1'],
            commands: { K1: 'npm test' },
          },
        ],
      },
    });

    expect(fixReviewChecks(task)).toEqual([]);
  });

  it('collects both findings and keeps the first command for a repeated id', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'F1',
            text: 'The type check failed',
            acceptance: null,
            checkIds: ['V1'],
            commands: { V1: 'tsc --noEmit' },
          },
          {
            id: 'F2',
            text: 'The tests failed',
            acceptance: null,
            checkIds: ['V1', 'V2', 'V3'],
            commands: { V1: 'node --version', V2: 'npm test' },
          },
        ],
      },
    });

    expect(fixReviewChecks(task)).toEqual([
      { id: 'V1', kind: 'cmd', value: 'tsc --noEmit', required: true },
      { id: 'V2', kind: 'cmd', value: 'npm test', required: true },
    ]);
  });
});

describe('fixCheckKeys', () => {
  it('unions the failure keys every finding carries per check, once each', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [
          { id: 'F1', text: 'cause', acceptance: null, checkIds: ['V1', 'K1'] },
          {
            id: 'V1.1',
            text: 'red',
            acceptance: null,
            checkIds: ['V1'],
            failureKeys: { V1: ['src/a.ts(1,1)', 'src/a.ts(9,2)'] },
            redKeys: { V1: ['src/a.ts(1,1)', 'src/b.ts(2,2)'] },
          },
          {
            id: 'P1',
            text: 'red',
            acceptance: null,
            checkIds: ['K1', 'V1'],
            failureKeys: { K1: ['src/a.ts(1,1)'], V1: ['src/a.ts(1,1)'] },
            redKeys: { V1: ['src/a.ts(1,1)', 'src/c.ts(3,3)'] },
          },
        ],
      },
    });

    expect(Object.fromEntries(fixCheckKeys(task, [task]))).toEqual({
      V1: { failureKeys: ['src/a.ts(1,1)', 'src/a.ts(9,2)'], sharedWith: new Map(), exempt: false },
      K1: { failureKeys: ['src/a.ts(1,1)'], sharedWith: new Map(), exempt: false },
    });
  });

  it('carries nothing for a fix task saved before findings carried keys', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [{ id: 'F1', text: 'red', acceptance: null, checkIds: ['V1'] }],
      },
    });

    expect(fixCheckKeys(task, [task]).size).toBe(0);
  });

  function carrier(
    id: string,
    keys: string[],
    extra: { status?: Task['status']; cycle?: number } = {},
  ): Task {
    return makeTask({
      id,
      status: extra.status ?? 'pending',
      fix: {
        cycle: extra.cycle ?? 1,
        findings: [
          {
            id: `${id}.F1`,
            text: 'red',
            acceptance: null,
            checkIds: ['V1'],
            failureKeys: { V1: keys },
          },
        ],
      },
    });
  }

  it('names the unfinished sibling fix tasks of the same cycle that carry an own failure too', () => {
    const task = carrier('T023', ['a', 'b', 'c']);
    const tasks = [
      task,
      carrier('T024', ['a']),
      carrier('T025', ['a', 'b'], { status: 'in_progress' }),
      carrier('T026', ['c'], { status: 'done' }),
      carrier('T027', ['c'], { status: 'skipped' }),
      carrier('T028', ['c'], { cycle: 2 }),
    ];

    expect(fixCheckKeys(task, tasks).get('V1')?.sharedWith).toEqual(
      new Map([
        ['a', ['T024', 'T025']],
        ['b', ['T025']],
      ]),
    );
  });

  it('marks a check the task owns no failure of as exempt when each finding naming it owns failures of another check', () => {
    const finding = {
      id: 'P1',
      text: 'red',
      acceptance: null,
      checkIds: ['K1', 'V1'],
      failureKeys: { K1: ['src/a.ts(1,1)'] },
    };
    const exempt = makeTask({ fix: { cycle: 1, findings: [finding] } });
    const older = makeTask({
      fix: {
        cycle: 1,
        findings: [finding, { id: 'F2', text: 'older', acceptance: null, checkIds: ['V1'] }],
      },
    });

    expect(fixCheckKeys(exempt, [exempt]).get('V1')).toEqual({
      failureKeys: [],
      sharedWith: new Map(),
      exempt: true,
    });
    expect(fixCheckKeys(older, [older]).get('V1')).toBeUndefined();
  });
});

describe('judgeFixCheck', () => {
  const own = 'src/a.ts(10,5): error TS2322: Type mismatch.';
  const other = 'src/b.ts(20,3): error TS2304: Cannot find name x.';
  const carried = (
    failureKeys: string[],
    extra: { sharedWith?: Map<string, string[]>; exempt?: boolean } = {},
  ) => ({ failureKeys, sharedWith: extra.sharedWith ?? new Map(), exempt: extra.exempt ?? false });

  it('keeps the same diagnostic message when its line moves', () => {
    expect(judgeFixCheck(carried([own]), { keys: [own.replace('(10,5)', '(11,7)')] })).toEqual({
      own: 1,
      left: [own],
      deferred: [],
      others: 0,
    });
  });

  it('keeps a moved diagnostic whose message contains a double colon', () => {
    const scoped = "src/a.ts(10,5): error TS2339: Property 'x' does not exist on type 'A::B'.";
    expect(
      judgeFixCheck(carried([scoped]), { keys: [scoped.replace('(10,5)', '(12,5)'), other] }),
    ).toEqual({ own: 1, left: [scoped], deferred: [], others: 1 });
  });

  it('counts a different message in the same file as another failure', () => {
    const different = 'src/a.ts(10,5): error TS2304: Cannot find name y.';
    expect(judgeFixCheck(carried([own]), { keys: [different] })).toEqual({
      own: 1,
      left: [],
      deferred: [],
      others: 1,
    });
  });

  it('settles an absent own failure whatever else the re-run shows', () => {
    const fresh = 'src/b.ts(20,3): error TS2322: New first-stage failure.';
    expect(judgeFixCheck(carried([own]), { keys: [fresh] })).toEqual({
      own: 1,
      left: [],
      deferred: [],
      others: 1,
    });
  });

  it('leaves a remaining own failure an unfinished sibling carries to that sibling', () => {
    const second = 'src/a.ts(30,1): error TS2322: Second.';
    expect(
      judgeFixCheck(carried([own, second], { sharedWith: new Map([[second, ['T025']]]) }), {
        keys: [second, other],
      }),
    ).toEqual({ own: 2, left: [], deferred: [{ key: second, taskIds: ['T025'] }], others: 1 });
  });

  it('judges an exempt check by no failure of its own', () => {
    expect(judgeFixCheck(carried([], { exempt: true }), { keys: [other] })).toEqual({
      own: 0,
      left: [],
      deferred: [],
      others: 1,
    });
  });

  it('shows all carried failures gone on a green command', () => {
    expect(judgeFixCheck(carried([own]), null)).toEqual({
      own: 1,
      left: [],
      deferred: [],
      others: 0,
    });
  });

  it('pairs one moved diagnostic with only one carried failure', () => {
    const second = own.replace('(10,5)', '(40,3)');
    expect(
      judgeFixCheck(carried([own, second]), { keys: [own.replace('(10,5)', '(41,3)')] }),
    ).toEqual({ own: 2, left: [own], deferred: [], others: 0 });
  });

  it('pairs exact keys before moved diagnostic identities', () => {
    const second = own.replace('(10,5)', '(40,3)');
    expect(judgeFixCheck(carried([own, second]), { keys: [second] })).toEqual({
      own: 2,
      left: [second],
      deferred: [],
      others: 0,
    });
  });

  it('counts every unmatched diagnostic, including diagnostics in the same file', () => {
    const different = 'src/a.ts:13: error: Different failure.';
    expect(judgeFixCheck(carried([own]), { keys: [own, different, other] })).toEqual({
      own: 1,
      left: [own],
      deferred: [],
      others: 2,
    });
  });

  it('matches a test key only by its exact name', () => {
    expect(
      judgeFixCheck(carried(['src/a.test.ts::adds']), { keys: ['src/a.test.ts::subtracts'] }),
    ).toEqual({ own: 1, left: [], deferred: [], others: 1 });
  });

  it('matches keys with no file exactly', () => {
    expect(judgeFixCheck(carried(['error: failed']), { keys: ['error: failed'] })).toEqual({
      own: 1,
      left: ['error: failed'],
      deferred: [],
      others: 0,
    });
  });

  it('judges nothing without carried keys, on a pass with no own failure, or when the re-run names no failure', () => {
    expect(judgeFixCheck(undefined, { keys: [other] })).toBeNull();
    expect(judgeFixCheck(carried([], { exempt: true }), null)).toBeNull();
    expect(
      judgeFixCheck(carried([own]), {
        keys: ['exited with code 1'],
        placeholder: 'exited with code 1 without diagnostics',
      }),
    ).toBeNull();
  });
});

describe('fixCheckVerdict', () => {
  const counts = { own: 2, ownLeft: 0, deferred: 0, deferredTo: [], others: 0 };
  const words = (input: FixCheckCounts) =>
    fixCheckVerdict(input).map((segment) => segment.replaceAll('\u00a0', ' '));

  it('keeps each segment in one piece', () => {
    const segments = fixCheckVerdict({
      own: 3,
      ownLeft: 1,
      deferred: 1,
      deferredTo: ['T025'],
      others: 2,
    });
    expect(segments.filter((segment) => segment.includes(' '))).toEqual([]);
  });

  it('says the own failures are gone and the others are left for their fix tasks or the next review', () => {
    expect(words({ ...counts, others: 3 })).toEqual([
      'your 2 failures gone',
      '3 others left for their fix tasks or the next review',
    ]);
  });

  it('names the sibling a shared failure is left to', () => {
    expect(words({ ...counts, deferred: 1, deferredTo: ['T025'], others: 1 })).toEqual([
      '1 of your 2 failures gone',
      '1 left to T025',
      '1 other left for their fix tasks or the next review',
    ]);
    expect(words({ ...counts, deferred: 2, deferredTo: ['T025', 'T026'] })).toEqual([
      'your 2 failures left to T025 and T026',
    ]);
  });

  it('counts what remains, what is left to a sibling and the others on a red', () => {
    expect(words({ own: 3, ownLeft: 1, deferred: 1, deferredTo: ['T025'], others: 2 })).toEqual([
      '1 of your 3 failures remains',
      '1 left to T025',
      '2 others left for their fix tasks or the next review',
    ]);
  });

  it('says a check with no failure of the task leaves its failures to others', () => {
    expect(words({ ...counts, own: 0, others: 1 })).toEqual([
      'no failure of yours',
      '1 other left for their fix tasks or the next review',
    ]);
  });
});

describe('fileFromFailureKey', () => {
  it('reads the file of each diagnostic key shape', () => {
    expect(fileFromFailureKey('src/a.ts(12,3)')).toBe('src/a.ts');
    expect(fileFromFailureKey('src/a.ts:12')).toBe('src/a.ts');
    expect(fileFromFailureKey('tests/test_x.py::test_y[a')).toBe('tests/test_x.py');
    expect(fileFromFailureKey('x_test.go:12')).toBe('x_test.go');
  });

  it('reads the file of a diagnostic or test node key that keeps its message', () => {
    expect(fileFromFailureKey('src/a.ts(12,3): error TS2322: Type mismatch.')).toBe('src/a.ts');
    expect(fileFromFailureKey('src/a.ts:12:3 - error TS2322')).toBe('src/a.ts');
    expect(fileFromFailureKey('src/x.test.ts::x > y')).toBe('src/x.test.ts');
    expect(fileFromFailureKey('a.py:: weird')).toBeNull();
  });

  it('reads an output line that is one whole path', () => {
    expect(fileFromFailureKey('src/a.ts')).toBe('src/a.ts');
    expect(fileFromFailureKey('./src/a.ts')).toBe('src/a.ts');
  });

  it('reads no file from an npm script banner', () => {
    expect(fileFromFailureKey('> pkg@1.0.0 test')).toBeNull();
    expect(fileFromFailureKey('> tsx scripts/x.ts')).toBeNull();
    expect(fileFromFailureKey('> tsx scripts/check-invariants.ts')).toBeNull();
  });

  it('reads no file from command text, a runner summary or a version', () => {
    expect(fileFromFailureKey('Error: Command failed: tsx scripts/x.ts')).toBeNull();
    expect(fileFromFailureKey('make: *** [Makefile:2: check] Error 1')).toBeNull();
    expect(fileFromFailureKey('Duration  6.93s')).toBeNull();
    expect(fileFromFailureKey('1.0.0')).toBeNull();
    expect(fileFromFailureKey('src/a.ts:')).toBeNull();
  });
});
