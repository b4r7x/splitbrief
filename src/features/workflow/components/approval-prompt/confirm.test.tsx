import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { ApprovalPrompt } from '../approval-prompt.js';
import {
  openApprovalPrompt,
  approvalPromptStore,
} from '../../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../prompt-grace.js';
import { glyph } from '../../../../lib/glyphs.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';

const ENTER = '\r';
const ESC = '\u001b';
const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

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

    ui.stdin.write(ESC);
    await expect(third).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it('resets confirmation progress when a pending request is superseded', async () => {
    const ui = render(<ApprovalPrompt />);
    const first = openApprovalPrompt(makeConfirmRequest('delete temp files'));
    await tick(PAST_GRACE);

    ui.stdin.write('I confirm');
    await vi.waitFor(() => {
      expect(stripColor(ui.lastFrame())).toContain(`${glyph('prompt')} I confirm`);
    });
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('phrase accepted');
    });

    const second = openApprovalPrompt(makeConfirmRequest('reset repository'));
    await expect(first).resolves.toEqual({ decision: 'deny', reason: 'superseded' });
    await tick(PAST_GRACE);

    const frame = stripColor(ui.lastFrame());
    expect(frame).toContain('reset repository');
    expect(frame).toContain('I confirm');
    expect(frame).toContain('to proceed');
    expect(frame).not.toContain('phrase accepted');

    ui.stdin.write(ESC);
    await expect(second).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });
});
