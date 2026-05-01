import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { ApprovalPrompt } from './approval-prompt.js';
import { openApprovalPrompt } from '../../../stores/approval-prompt/actions.js';
import { approvalPromptStore, type TieredApprovalRequest } from '../../../stores/approval-prompt/store.js';

const ENTER = '\r';
const ESC = '';

function makeConfirmRequest(actionDescription: string): TieredApprovalRequest {
  return {
    tier: 'confirm',
    actionClass: 'destructive',
    actionDescription,
    phase: 'implementing',
  };
}

beforeEach(() => {
  approvalPromptStore.__testReset();
});

afterEach(() => {
  approvalPromptStore.__testReset();
});

describe('ApprovalPrompt', () => {
  it('resets confirmation progress when a pending request is superseded', async () => {
    const ui = render(<ApprovalPrompt />);
    const first = openApprovalPrompt(makeConfirmRequest('delete temp files'));
    await tick(1); await tick(1);

    ui.stdin.write('I confirm');
    await tick(1); await tick(1);
    ui.stdin.write(ENTER);
    await tick(1); await tick(1);
    expect(ui.lastFrame() ?? '').toContain('Phrase accepted. Enter reason');

    const second = openApprovalPrompt(makeConfirmRequest('reset repository'));
    await expect(first).resolves.toEqual({ decision: 'deny', reason: 'superseded' });
    await tick(1); await tick(1);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('reset repository');
    expect(frame).toContain('Type "I confirm" to proceed');
    expect(frame).not.toContain('Phrase accepted. Enter reason');

    ui.stdin.write(ESC);
    await expect(second).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });
});
