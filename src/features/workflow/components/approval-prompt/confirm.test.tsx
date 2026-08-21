import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { ApprovalPrompt } from '../approval-prompt.js';
import {
  openApprovalPrompt,
  approvalPromptStore,
} from '../../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../../lib/terminal/typeahead-grace.js';
import {
  CONFIRM_QUESTION,
  CONFIRM_REASON_HINTS,
  CONFIRM_REASON_OPTIONAL,
  CONFIRM_REASON_UNSTATED,
  getApprovalPromptRows,
  getConfirmChooseHints,
} from '../../prompt-rows/approval.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { CONFIRM_PHRASE } from '../../../../core/approval/types.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';

const ENTER = '\r';
const ESC = '\u001b';
const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

function frameRows(frame: string | undefined): number {
  return stripAnsiStyles(frame ?? '')
    .replace(/\n$/, '')
    .split('\n').length;
}

function stripColor(frame: string | undefined): string {
  return stripAnsiStyles(frame ?? '');
}

function makeConfirmRequest(
  actionDescription: string,
  actionClass: TieredApprovalRequest['actionClass'] = 'destructive',
): TieredApprovalRequest {
  return {
    tier: 'confirm',
    actionClass,
    actionDescription,
    phase: 'implementing',
  };
}

beforeEach(() => {
  approvalPromptStore.__testReset();
  overlayStore.reset();
});

afterEach(() => {
  approvalPromptStore.__testReset();
  overlayStore.reset();
});

describe('ApprovalPrompt confirm tier', () => {
  it('labels confirm prompts by action class', async () => {
    const ui = render(<ApprovalPrompt />);
    const first = openApprovalPrompt(makeConfirmRequest('.splitbrief/state.json', 'destructive'));
    await tick(PAST_GRACE);

    expect(ui.lastFrame() ?? '').toContain('control-plane file write');
    expect(ui.lastFrame() ?? '').toContain('.splitbrief/state.json');

    const second = openApprovalPrompt(makeConfirmRequest('package.json', 'package_change'));
    await expect(first).resolves.toEqual({ decision: 'deny', reason: 'superseded' });
    await tick(PAST_GRACE);

    expect(ui.lastFrame() ?? '').toContain('package manifest write');
    expect(ui.lastFrame() ?? '').toContain('package.json');

    const third = openApprovalPrompt(makeConfirmRequest('src/feature.ts', 'write_out_of_scope'));
    await expect(second).resolves.toEqual({ decision: 'deny', reason: 'superseded' });
    await tick(PAST_GRACE);

    expect(ui.lastFrame() ?? '').toContain('confirm file write');
    expect(ui.lastFrame() ?? '').toContain('src/feature.ts');

    await flushEffects();
    ui.stdin.write(ESC);
    await expect(third).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it('never asks the user to type a confirmation phrase', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config'));
    await tick(PAST_GRACE);

    const frame = stripColor(ui.lastFrame());
    expect(frame).not.toContain(CONFIRM_PHRASE);
    expect(frame).not.toContain('to proceed');
    expect(frame).toContain('enter   Confirm');
    // `enter` is five columns and `r` is one, so the label column is padded to the widest key.
    expect(frame).toContain('r       Confirm with a reason');
    expect(frame).toContain('x       Deny');
    expect(frame).toContain('this cannot be undone');

    await flushEffects();
    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it('confirms an irreversible write on enter and records that no reason was stated', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write(ENTER);
    await expect(pending).resolves.toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: CONFIRM_REASON_UNSTATED,
    });
    ui.unmount();
  });

  it('refuses a bare y on an irreversible write and points at enter', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('y');
    await tick(20);
    expect(approvalPromptStore.get().status).toBe('pending');
    expect(stripColor(ui.lastFrame())).toContain('enter confirms this write');

    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it('confirms a reversible write on y', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('package.json', 'package_change'));
    await tick(PAST_GRACE);

    expect(stripColor(ui.lastFrame())).toContain('y   Confirm');
    await flushEffects();

    ui.stdin.write('y');
    await expect(pending).resolves.toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: CONFIRM_REASON_UNSTATED,
    });
    ui.unmount();
  });

  it('takes an optional typed reason behind r', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('r');
    await tick(20);
    expect(stripColor(ui.lastFrame())).toContain('Why are you making this change?');

    ui.stdin.write('migrating the remote');
    await tick(20);
    ui.stdin.write(ENTER);
    await expect(pending).resolves.toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: 'migrating the remote',
    });
    ui.unmount();
  });

  it('handles queued pasted reason input with no delay', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('r');
    ui.stdin.write('pasted reason');
    ui.stdin.write(ENTER);

    await expect(pending).resolves.toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: 'pasted reason',
    });
    ui.unmount();
  });

  it('denies on x', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('x');
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it('ignores keystrokes buffered before the prompt appeared', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('package.json', 'package_change'));
    await flushEffects();

    ui.stdin.write('y');
    await tick(20);
    expect(approvalPromptStore.get().status).toBe('pending');

    await tick(PAST_GRACE);
    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it.each([
    [40, 'destructive' as const, '.splitbrief/sessions/2026-08-10-a/state.json'],
    [60, 'package_change' as const, 'package.json'],
    [120, 'destructive' as const, '.git/config'],
  ])(
    'renders both steps inside the row budget it reports at %i cols',
    async (cols, actionClass, description) => {
      terminalSizeStore.__testReset({ cols, rows: 40 });
      const ui = renderFeature(<ApprovalPrompt />, { cols, rows: 40 });
      const pending = openApprovalPrompt(makeConfirmRequest(description, actionClass));
      await tick(PAST_GRACE);
      await flushEffects();

      const budget = getApprovalPromptRows(approvalPromptStore.get(), cols);
      expect(frameRows(ui.lastFrame())).toBe(budget);

      // A row count cannot see a clipped line, so the choose step is judged on what it shows: the
      // title, every option with its padded key cell, and a legend that ends in a whole token.
      const chooseStep = stripColor(ui.lastFrame());
      const keyCell = actionClass === 'destructive' ? 'enter  ' : 'y  ';
      expect(chooseStep).toContain('Approval');
      expect(chooseStep).toContain(`${keyCell} Confirm`);
      expect(chooseStep).toContain('Confirm with a reason');
      expect(chooseStep).toContain('Deny');
      expect(chooseStep).toContain(getConfirmChooseHints(actionClass));
      expect(chooseStep).not.toContain('…');

      ui.stdin.write('r');
      await tick(30);
      expect(frameRows(ui.lastFrame())).toBe(budget);

      const reasonStep = stripColor(ui.lastFrame());
      expect(reasonStep).toContain(CONFIRM_QUESTION);
      expect(reasonStep).toContain(CONFIRM_REASON_OPTIONAL);
      expect(reasonStep).toContain(CONFIRM_REASON_HINTS);

      ui.stdin.write(ESC);
      await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
      ui.unmount();
    },
  );

  it('resets confirmation progress when a pending request is superseded', async () => {
    const ui = render(<ApprovalPrompt />);
    const first = openApprovalPrompt(makeConfirmRequest('delete temp files'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('r');
    await tick(20);
    ui.stdin.write('half a reason');
    await tick(20);
    expect(stripColor(ui.lastFrame())).toContain('half a reason');

    const second = openApprovalPrompt(makeConfirmRequest('reset repository'));
    await expect(first).resolves.toEqual({ decision: 'deny', reason: 'superseded' });
    await tick(PAST_GRACE);

    const frame = stripColor(ui.lastFrame());
    expect(frame).toContain('reset repository');
    expect(frame).toContain('enter   Confirm');
    expect(frame).not.toContain('half a reason');
    expect(frame).not.toContain('Why are you making this change?');

    await flushEffects();
    ui.stdin.write(ESC);
    await expect(second).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });
});
