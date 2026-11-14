import { describe, expect, it } from 'vitest';
import {
  CONFIRM_NUDGE,
  CONFIRM_REASON_HINTS,
  CHOOSE_HINTS,
  approvalKeyColumnWidth,
  approvalTitle,
  getApprovalConfirmLabel,
  getConfirmOptions,
  getConfirmPrimaryKey,
} from './approval.js';
import { CONFIRM_HINT } from '../../../components/key-legend.js';

describe('confirm gate title and label', () => {
  it.each([
    [
      'runner_trust',
      'Trust and run a configured runner:',
      'runner command from the project config',
    ],
    ['package_change', 'Change a package manifest:', 'package manifest write'],
    ['sensitive_change', 'Change a CI or secret file:', 'CI or secret file write'],
    ['destructive', 'Destructive action:', 'control-plane file write'],
    ['write_out_of_scope', "Write outside the brief's declared files:", 'confirm file write'],
  ] as const)('names what a %s request approves', (actionClass, title, label) => {
    expect(approvalTitle(actionClass)).toBe(title);
    expect(getApprovalConfirmLabel(actionClass)).toBe(label);
  });
});

describe('confirm gate keys and legends', () => {
  it('takes y on every confirm-tier class except the irreversible one', () => {
    expect(getConfirmPrimaryKey('package_change')).toBe('y');
    expect(getConfirmPrimaryKey('write_out_of_scope')).toBe('y');
    expect(getConfirmPrimaryKey('sensitive_change')).toBe('y');
    expect(getConfirmPrimaryKey('destructive')).toBe('');
  });

  it('leaves the Confirm row without a key on a destructive gate, so r sets the column', () => {
    expect(getConfirmOptions('destructive').map((option) => option.key)).toEqual(['', 'r', 'x']);
    expect(approvalKeyColumnWidth(getConfirmOptions('destructive'))).toBe(1);
    expect(getConfirmOptions('package_change').map((option) => option.key)).toEqual([
      'y',
      'r',
      'x',
    ]);
  });

  it('offers a runner trust no reason row, and keeps it on every protected write', () => {
    expect(getConfirmOptions('runner_trust').map((option) => option.key)).toEqual(['y', 'x']);
    for (const actionClass of [
      'write_out_of_scope',
      'package_change',
      'sensitive_change',
      'destructive',
    ] as const) {
      expect(getConfirmOptions(actionClass).map((option) => option.label)).toContain(
        'Confirm with a reason',
      );
    }
  });

  it('teaches ⏎ as confirm and esc as deny on both steps', () => {
    expect(CONFIRM_HINT).toEqual({ key: '⏎', verb: 'confirm' });
    expect(CONFIRM_REASON_HINTS).toBe('⏎ confirm · esc deny');
    expect(CHOOSE_HINTS).toBe('↑↓ select · ⏎ confirm · esc deny');
  });

  it('keeps the way out on the refusal a stray y earns', () => {
    expect(CONFIRM_NUDGE).toBe('⏎ confirms this write · esc deny');
  });
});
