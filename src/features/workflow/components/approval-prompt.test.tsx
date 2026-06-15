import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { ApprovalPrompt } from './approval-prompt.js';
import { openApprovalPrompt, approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../prompt-grace.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';

const ENTER = '\r';
const ESC = '\u001b';
const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

function makeConfirmRequest(actionDescription: string): TieredApprovalRequest {
  return {
    tier: 'confirm',
    actionClass: 'destructive',
    actionDescription,
    phase: 'implementing',
  };
}

function makeStickyRequest(actionDescription: string): TieredApprovalRequest {
  return {
    tier: 'sticky',
    actionClass: 'write_out_of_scope',
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

describe('ApprovalPrompt', () => {
  it('resets confirmation progress when a pending request is superseded', async () => {
    const ui = render(<ApprovalPrompt />);
    const first = openApprovalPrompt(makeConfirmRequest('delete temp files'));
    await tick(PAST_GRACE);

    ui.stdin.write('I confirm');
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Phrase: I confirm');
    });
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Phrase accepted. Enter reason');
    });

    const second = openApprovalPrompt(makeConfirmRequest('reset repository'));
    await expect(first).resolves.toEqual({ decision: 'deny', reason: 'superseded' });
    await tick(PAST_GRACE);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('reset repository');
    expect(frame).toContain('Type "I confirm" to proceed');
    expect(frame).not.toContain('Phrase accepted. Enter reason');

    ui.stdin.write(ESC);
    await expect(second).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it('ignores a keystroke that lands inside the typeahead grace window, honours it after', async () => {
    const ui = render(<ApprovalPrompt />);
    const decision = openApprovalPrompt(makeStickyRequest('write outside scope'));
    await tick(1);

    // A keystroke buffered for the composer arrives the instant the prompt opens. The grace
    // swallows it so it cannot make a decision the user never aimed at the prompt.
    ui.stdin.write('a');
    await tick(1);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await tick(1);
    expect(settled).toBe(false);
    expect(ui.lastFrame() ?? '').toContain('Approve once');

    // Once the grace elapses the same key is honoured.
    await tick(PAST_GRACE);
    ui.stdin.write('a');
    await expect(decision).resolves.toEqual({ decision: 'allow', scope: 'once' });
    ui.unmount();
  });

  it('does not consume keystrokes while an overlay is open, honours them after it closes', async () => {
    const ui = render(<ApprovalPrompt />);
    const decision = openApprovalPrompt(makeStickyRequest('write outside scope'));
    overlayStore.open('settings');
    await tick(PAST_GRACE);

    // The prompt sits hidden behind the overlay; a decision key meant for the overlay must not
    // resolve the buried prompt.
    ui.stdin.write('a');
    await tick(1);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await tick(1);
    expect(settled).toBe(false);

    // Closing the overlay hands input back to the prompt and the same key is honoured.
    overlayStore.close();
    await tick(1);
    ui.stdin.write('a');
    await expect(decision).resolves.toEqual({ decision: 'allow', scope: 'once' });
    ui.unmount();
  });
});
