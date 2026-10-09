import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  fixBriefDescription,
  fixCheckKeys,
  fixCheckVerdict,
  fixReviewChecks,
  fileFromFailureKey,
  judgeFixCheck,
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

    expect(Object.fromEntries(fixCheckKeys(task))).toEqual({
      V1: {
        failureKeys: ['src/a.ts(1,1)', 'src/a.ts(9,2)'],
        redKeys: ['src/a.ts(1,1)', 'src/b.ts(2,2)', 'src/c.ts(3,3)'],
      },
      K1: { failureKeys: ['src/a.ts(1,1)'], redKeys: [] },
    });
  });

  it('carries nothing for a fix task saved before findings carried keys', () => {
    const task = makeTask({
      fix: {
        cycle: 1,
        findings: [{ id: 'F1', text: 'red', acceptance: null, checkIds: ['V1'] }],
      },
    });

    expect(fixCheckKeys(task).size).toBe(0);
  });
});

describe('judgeFixCheck', () => {
  const own = 'src/a.ts(10,5): error TS2322: Type mismatch.';
  const other = 'src/b.ts(20,3): error TS2304: Cannot find name x.';

  it('keeps the same diagnostic message when its line moves', () => {
    expect(
      judgeFixCheck(
        { failureKeys: [own], redKeys: [own, other] },
        { keys: [own.replace('(10,5)', '(11,7)')] },
      ),
    ).toEqual({ own: 1, left: [own], others: 0, proven: true });
  });

  it('keeps a moved diagnostic whose message contains a double colon', () => {
    const scoped = "src/a.ts(10,5): error TS2339: Property 'x' does not exist on type 'A::B'.";
    expect(
      judgeFixCheck(
        { failureKeys: [scoped], redKeys: [scoped, other] },
        { keys: [scoped.replace('(10,5)', '(12,5)'), other] },
      ),
    ).toEqual({ own: 1, left: [scoped], others: 1, proven: true });
  });

  it('counts a different message in the same file as another failure', () => {
    const different = 'src/a.ts(10,5): error TS2304: Cannot find name y.';
    expect(
      judgeFixCheck({ failureKeys: [own], redKeys: [own, different] }, { keys: [different] }),
    ).toEqual({ own: 1, left: [], others: 1, proven: true });
  });

  it('cannot prove an absent own key fixed without the original red keys', () => {
    expect(judgeFixCheck({ failureKeys: [own], redKeys: [] }, { keys: [other] })).toEqual({
      own: 1,
      left: [],
      others: 1,
      proven: false,
    });
  });

  it('does not claim proof on an older red even when its own failure remains', () => {
    expect(judgeFixCheck({ failureKeys: [own], redKeys: [] }, { keys: [own] })).toEqual({
      own: 1,
      left: [own],
      others: 0,
      proven: false,
    });
  });

  it('proves the stage ran when an original other diagnostic remains after moving', () => {
    expect(
      judgeFixCheck(
        { failureKeys: [own], redKeys: [own, other] },
        { keys: [other.replace('(20,3)', '(21,8)')] },
      ),
    ).toEqual({ own: 1, left: [], others: 1, proven: true });
  });

  it('cannot prove a later stage ran when only new failures appear', () => {
    const fresh = 'src/b.ts(20,3): error TS2322: New first-stage failure.';
    expect(judgeFixCheck({ failureKeys: [own], redKeys: [own, other] }, { keys: [fresh] })).toEqual(
      { own: 1, left: [], others: 1, proven: false },
    );
  });

  it('shows all carried failures gone on a green command', () => {
    expect(judgeFixCheck({ failureKeys: [own], redKeys: [] }, null)).toEqual({
      own: 1,
      left: [],
      others: 0,
      proven: true,
    });
  });

  it('says absent failures are not proven fixed', () => {
    expect(fixCheckVerdict({ own: 2, ownLeft: 0, others: 1, proven: false })).toEqual([
      'your 2 failures not shown',
      'not proven fixed',
    ]);
  });

  it('pairs one moved diagnostic with only one carried failure', () => {
    const second = own.replace('(10,5)', '(40,3)');
    expect(
      judgeFixCheck(
        { failureKeys: [own, second], redKeys: [own, second] },
        { keys: [own.replace('(10,5)', '(41,3)')] },
      ),
    ).toEqual({ own: 2, left: [own], others: 0, proven: true });
  });

  it('pairs exact keys before moved diagnostic identities', () => {
    const second = own.replace('(10,5)', '(40,3)');
    expect(
      judgeFixCheck({ failureKeys: [own, second], redKeys: [own, second] }, { keys: [second] }),
    ).toEqual({ own: 2, left: [second], others: 0, proven: true });
  });

  it('counts every unmatched diagnostic, including diagnostics in the same file', () => {
    const different = 'src/a.ts:13: error: Different failure.';
    expect(
      judgeFixCheck({ failureKeys: [own], redKeys: [own] }, { keys: [own, different, other] }),
    ).toEqual({ own: 1, left: [own], others: 2, proven: true });
  });

  it('matches a test key only by its exact name', () => {
    expect(
      judgeFixCheck(
        { failureKeys: ['src/a.test.ts::adds'], redKeys: [] },
        { keys: ['src/a.test.ts::subtracts'] },
      ),
    ).toEqual({ own: 1, left: [], others: 1, proven: false });
  });

  it('matches keys with no file exactly', () => {
    expect(
      judgeFixCheck(
        { failureKeys: ['error: failed'], redKeys: ['error: failed'] },
        { keys: ['error: failed'] },
      ),
    ).toEqual({ own: 1, left: ['error: failed'], others: 0, proven: true });
  });

  it('judges nothing without carried keys or when the re-run names no failure', () => {
    expect(judgeFixCheck({ failureKeys: [], redKeys: [] }, { keys: [other] })).toBeNull();
    expect(
      judgeFixCheck(
        { failureKeys: [own], redKeys: [] },
        { keys: ['exited with code 1'], placeholder: 'exited with code 1 without diagnostics' },
      ),
    ).toBeNull();
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
