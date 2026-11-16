import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { makeKey } from '#testing/helpers/factories/key.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import { CONFIRM_REASON_UNSTATED } from './approval.js';
import {
  type ConfirmKeyPanel,
  type ConfirmKeyResult,
  type ConfirmKeyState,
  INITIAL_CONFIRM_KEY_STATE,
  confirmKeyStep,
  confirmRowStep,
} from './confirm-keys.js';

// Options: destructive [Confirm (no key), r, x]; package_change [y, r, x]; runner_trust [y, x].
const DESTRUCTIVE: ConfirmKeyPanel = { actionClass: 'destructive', optionRows: 3 };
const REVERSIBLE: ConfirmKeyPanel = { actionClass: 'package_change', optionRows: 3 };
const TRUST: ConfirmKeyPanel = { actionClass: 'runner_trust', optionRows: 2 };
// One option row shows only the highlighted row.
const ONE_ROW: ConfirmKeyPanel = { actionClass: 'package_change', optionRows: 1 };

const DENY: ConfirmKeyResult = {
  kind: 'answer',
  answer: { decision: 'deny', reason: 'user_denied' },
};

function confirmed(reason: string): ConfirmKeyResult {
  return { kind: 'answer', answer: { decision: 'confirm', phrase: CONFIRM_PHRASE, reason } };
}

function state(overrides: Partial<ConfirmKeyState> = {}): ConfirmKeyState {
  return { ...INITIAL_CONFIRM_KEY_STATE, ...overrides };
}

function next(overrides: Partial<ConfirmKeyState>): ConfirmKeyResult {
  return { kind: 'state', state: state(overrides) };
}

function press(
  panel: ConfirmKeyPanel,
  keys: ReadonlyArray<readonly [string, Partial<Key>?]>,
): ConfirmKeyResult {
  let result: ConfirmKeyResult = { kind: 'state', state: INITIAL_CONFIRM_KEY_STATE };
  for (const [input, overrides] of keys) {
    if (result.kind === 'answer') return result;
    result = confirmKeyStep(result.state, input, makeKey(overrides), panel);
  }
  return result;
}

describe('confirmKeyStep in the choose step', () => {
  it.each([
    {
      name: 'Esc denies',
      panel: DESTRUCTIVE,
      from: {},
      input: '',
      key: { escape: true },
      expected: DENY,
    },
    {
      name: '↓ moves the highlight and clears the nudge',
      panel: DESTRUCTIVE,
      from: { nudged: true },
      input: '',
      key: { downArrow: true },
      expected: next({ selectedIndex: 1 }),
    },
    {
      name: '↑ from the first row wraps to the last',
      panel: REVERSIBLE,
      from: {},
      input: '',
      key: { upArrow: true },
      expected: next({ selectedIndex: 2 }),
    },
    {
      name: '⏎ on the keyless Confirm row of an irreversible write confirms',
      panel: DESTRUCTIVE,
      from: {},
      input: '\r',
      key: { return: true },
      expected: confirmed(CONFIRM_REASON_UNSTATED),
    },
    {
      name: '⏎ on the r row opens the reason step and clears the nudge',
      panel: DESTRUCTIVE,
      from: { selectedIndex: 1, nudged: true },
      input: '\r',
      key: { return: true },
      expected: next({ step: 'reason', selectedIndex: 1 }),
    },
    {
      name: '⏎ on Deny denies',
      panel: REVERSIBLE,
      from: { selectedIndex: 2 },
      input: '\r',
      key: { return: true },
      expected: DENY,
    },
    {
      name: '⏎ takes the highlighted row even when the panel shows it alone',
      panel: ONE_ROW,
      from: { selectedIndex: 2 },
      input: '\r',
      key: { return: true },
      expected: DENY,
    },
    {
      name: 'y confirms a reversible write with Confirm in view',
      panel: REVERSIBLE,
      from: {},
      input: 'y',
      key: {},
      expected: confirmed(CONFIRM_REASON_UNSTATED),
    },
    {
      name: 'Y confirms like y',
      panel: REVERSIBLE,
      from: {},
      input: 'Y',
      key: { shift: true },
      expected: confirmed(CONFIRM_REASON_UNSTATED),
    },
    {
      name: 'y on an irreversible write moves the highlight to Confirm and nudges',
      panel: DESTRUCTIVE,
      from: { selectedIndex: 2 },
      input: 'y',
      key: {},
      expected: next({ selectedIndex: 0, nudged: true }),
    },
    {
      name: 'y nudges on a reversible write with Confirm out of view',
      panel: ONE_ROW,
      from: { selectedIndex: 2 },
      input: 'y',
      key: {},
      expected: next({ selectedIndex: 0, nudged: true }),
    },
    {
      name: 'y on a runner trust confirms',
      panel: TRUST,
      from: {},
      input: 'y',
      key: {},
      expected: confirmed(CONFIRM_REASON_UNSTATED),
    },
    { name: 'x denies', panel: DESTRUCTIVE, from: {}, input: 'x', key: {}, expected: DENY },
    { name: 'n denies', panel: REVERSIBLE, from: {}, input: 'n', key: {}, expected: DENY },
    {
      name: 'N denies like n',
      panel: REVERSIBLE,
      from: {},
      input: 'N',
      key: { shift: true },
      expected: DENY,
    },
    {
      name: 'r with its row in view opens the reason step and clears the nudge',
      panel: DESTRUCTIVE,
      from: { nudged: true },
      input: 'r',
      key: {},
      expected: next({ step: 'reason' }),
    },
    {
      name: 'r with its row out of view moves the highlight there and keeps the nudge',
      panel: ONE_ROW,
      from: { nudged: true },
      input: 'r',
      key: {},
      expected: next({ selectedIndex: 1, nudged: true }),
    },
  ])('$name', ({ panel, from, input, key: overrides, expected }) => {
    expect(confirmKeyStep(state(from), input, makeKey(overrides), panel)).toEqual(expected);
  });

  it('gives back the same state when ⏎ finds no option row on the panel', () => {
    const from = state();
    expect(
      confirmKeyStep(from, '\r', makeKey({ return: true }), { ...DESTRUCTIVE, optionRows: 0 }),
    ).toEqual({ kind: 'state', state: from });
  });

  it.each([
    { name: 'r on a runner trust, which asks for no reason', panel: TRUST, input: 'r' },
    { name: 'a letter that names no row', panel: REVERSIBLE, input: 'q' },
    { name: '→', panel: REVERSIBLE, input: '' },
  ])('gives back the same state for $name', ({ panel, input }) => {
    const from = state({ selectedIndex: 1 });
    const result = confirmKeyStep(from, input, makeKey({ rightArrow: input === '' }), panel);
    expect(result).toEqual({ kind: 'state', state: from });
    expect(result.kind === 'state' && result.state).toBe(from);
  });
});

describe('confirmKeyStep in the reason step', () => {
  const reason = (text: string): ConfirmKeyState => state({ step: 'reason', reason: text });

  it.each([
    { name: 'Esc denies', from: 'half', input: '', key: { escape: true }, expected: DENY },
    {
      name: '⏎ confirms with the trimmed reason',
      from: '  migrating the remote ',
      input: '\r',
      key: { return: true },
      expected: confirmed('migrating the remote'),
    },
    {
      name: '⏎ on a blank reason confirms with no stated reason',
      from: '   ',
      input: '\r',
      key: { return: true },
      expected: confirmed(CONFIRM_REASON_UNSTATED),
    },
    {
      name: 'backspace drops the last character',
      from: 'pins',
      input: '',
      key: { backspace: true },
      expected: next({ step: 'reason', reason: 'pin' }),
    },
    {
      name: 'delete drops the last character',
      from: 'pins',
      input: '',
      key: { delete: true },
      expected: next({ step: 'reason', reason: 'pin' }),
    },
    {
      name: 'typed text appends as typed, with its case',
      from: 'pin ',
      input: 'Y x',
      key: {},
      expected: next({ step: 'reason', reason: 'pin Y x' }),
    },
  ])('$name', ({ from, input, key: overrides, expected }) => {
    expect(confirmKeyStep(reason(from), input, makeKey(overrides), DESTRUCTIVE)).toEqual(expected);
  });

  it.each([
    { name: '↑', input: '', key: { upArrow: true } },
    { name: '↓', input: '', key: { downArrow: true } },
    { name: 'ctrl+a', input: 'a', key: { ctrl: true } },
    { name: 'meta+a', input: 'a', key: { meta: true } },
  ])('gives back the same state for $name', ({ input, key: overrides }) => {
    const from = reason('kept');
    const result = confirmKeyStep(from, input, makeKey(overrides), DESTRUCTIVE);
    expect(result.kind === 'state' && result.state).toBe(from);
  });
});

describe('confirmKeyStep over the keys of one read', () => {
  it('takes ↓ ↓ ⏎ as Deny', () => {
    expect(
      press(REVERSIBLE, [
        ['', { downArrow: true }],
        ['', { downArrow: true }],
        ['\r', { return: true }],
      ]),
    ).toEqual(DENY);
  });

  it('confirms with the reason typed behind r', () => {
    expect(press(DESTRUCTIVE, [['r'], ['pasted reason'], ['\r', { return: true }]])).toEqual(
      confirmed('pasted reason'),
    );
  });

  it('keeps the nudge of y when an out-of-view r follows it', () => {
    expect(press({ ...DESTRUCTIVE, optionRows: 1 }, [['y'], ['r']])).toEqual(
      next({ selectedIndex: 1, nudged: true }),
    );
  });

  it('takes a second r as the reason step once the first r shows its row', () => {
    expect(press(ONE_ROW, [['r'], ['r']])).toEqual(next({ step: 'reason', selectedIndex: 1 }));
  });
});

describe('confirmRowStep', () => {
  it.each([
    { name: 'the r row opens the reason step', row: 'r', expected: next({ step: 'reason' }) },
    { name: 'the x row denies', row: 'x', expected: DENY },
    { name: 'the y row confirms', row: 'y', expected: confirmed(CONFIRM_REASON_UNSTATED) },
    {
      name: 'the keyless Confirm row confirms',
      row: '',
      expected: confirmed(CONFIRM_REASON_UNSTATED),
    },
  ])('$name', ({ row, expected }) => {
    expect(confirmRowStep(state({ nudged: true }), row)).toEqual(expected);
  });
});
