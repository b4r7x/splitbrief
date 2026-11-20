import { describe, expect, it } from 'vitest';
import { fixCheckVerdict, judgeFixCheck, type FixCheckCounts } from './checks.js';

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
      '2 failures gone',
      '3 others left for their fix tasks or the next review',
    ]);
  });

  it('names the sibling a shared failure is left to', () => {
    expect(words({ ...counts, deferred: 1, deferredTo: ['T025'], others: 1 })).toEqual([
      '1 of 2 failures gone',
      '1 left to T025',
      '1 other left for their fix tasks or the next review',
    ]);
    expect(words({ ...counts, deferred: 2, deferredTo: ['T025', 'T026'] })).toEqual([
      '2 failures left to T025 and T026',
    ]);
  });

  it('counts what remains, what is left to a sibling and the others on a red', () => {
    expect(words({ own: 3, ownLeft: 1, deferred: 1, deferredTo: ['T025'], others: 2 })).toEqual([
      '1 of 3 failures remains',
      '1 left to T025',
      '2 others left for their fix tasks or the next review',
    ]);
  });

  it('says a check with no failure of the task leaves its failures to others', () => {
    expect(words({ ...counts, own: 0, others: 1 })).toEqual([
      'no failure from this brief',
      '1 other left for their fix tasks or the next review',
    ]);
  });
});

it('describes cleared failures without addressing the person reading the fix check', () => {
  const words = fixCheckVerdict({ own: 2, ownLeft: 0, deferred: 0, deferredTo: [], others: 1 })
    .join(' · ')
    .replaceAll('\u00a0', ' ');
  expect(words).toMatch(/2 failures/);
  expect(words).toMatch(/1 other/);
  expect(words).not.toMatch(/\byour(?:s)?\b/);
});
