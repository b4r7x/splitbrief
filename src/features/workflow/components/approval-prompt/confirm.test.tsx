import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { listRowLead } from '../../../../components/list-row.js';
import { glyph } from '../../../../lib/glyphs.js';
import { ApprovalPrompt } from '../approval-prompt.js';
import {
  openApprovalPrompt,
  approvalPromptStore,
} from '../../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../../lib/terminal/typeahead-grace.js';
import {
  CONFIRM_NUDGE,
  CONFIRM_QUESTION,
  CONFIRM_REASON_HINTS,
  CONFIRM_REASON_OPTIONAL,
  CONFIRM_REASON_UNSTATED,
  CHOOSE_HINTS,
  approvalTitle,
  getApprovalPromptRows,
} from '../../prompt-rows/approval.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { approvalTextWidth } from '../../prompt-rows/measure.js';
import { fitKeyLegend } from '../../../../core/key-legend.js';
import { CONFIRM_PHRASE } from '../../../../core/approval/types.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';

const ENTER = '\r';
const ESC = '\u001b';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;
const bar = listRowLead('active');

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
    await expect(third).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it('never asks the user to type a confirmation phrase', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config'));
    await tick(PAST_GRACE);

    const frame = stripColor(ui.lastFrame());
    expect(frame).not.toContain(CONFIRM_PHRASE);
    expect(frame).not.toContain('to proceed');
    // A destructive Confirm row carries no accelerator key, so its key cell is blank and the
    // label column is set by `r` and `x`.
    expect(frame).toContain(`${bar}    Confirm`);
    expect(frame).toContain('r   Confirm with a reason');
    expect(frame).toContain('x   Deny');
    expect(frame).toContain('this cannot be undone');
    expect(frame).toContain(CHOOSE_HINTS);
    expect(frame).not.toContain(glyph('cursor'));

    await flushEffects();
    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it('starts on Confirm and confirms an irreversible write on ⏎', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    expect(stripColor(ui.lastFrame())).toContain(`${bar}    Confirm`);

    ui.stdin.write(ENTER);
    await expect(pending).resolves.toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: CONFIRM_REASON_UNSTATED,
    });
    ui.unmount();
  });

  it('moves the highlight with ↑↓, wraps it, and takes the highlighted row on ⏎', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('package.json', 'package_change'));
    await tick(PAST_GRACE);
    await flushEffects();

    expect(stripColor(ui.lastFrame())).toContain(`${bar}y   Confirm`);

    // Up from the first row wraps to the last; ⏎ then takes Deny.
    ui.stdin.write(UP);
    await tick(20);
    expect(stripColor(ui.lastFrame())).toContain(`${bar}x   Deny`);

    await flushEffects();
    ui.stdin.write(ENTER);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it('takes the r row on ⏎ into the reason step, and that ⏎ does not also submit it', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write(DOWN);
    await tick(20);
    expect(stripColor(ui.lastFrame())).toContain(`${bar}r   Confirm with a reason`);

    ui.stdin.write(ENTER);
    await tick(20);
    expect(stripColor(ui.lastFrame())).toContain(CONFIRM_QUESTION);
    expect(approvalPromptStore.get().status).toBe('pending');

    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it('reads ↑↓ delivered in the same render as ⏎ through the mirrored index', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('package.json', 'package_change'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN);
    ui.stdin.write(ENTER);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it('answers a bare y on an irreversible write with the nudge and moves the highlight to Confirm', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write(DOWN);
    await tick(20);
    expect(stripColor(ui.lastFrame())).toContain(`${bar}r   Confirm with a reason`);

    ui.stdin.write('y');
    await tick(20);
    expect(approvalPromptStore.get().status).toBe('pending');
    const nudged = stripColor(ui.lastFrame());
    expect(nudged).toContain(CONFIRM_NUDGE);
    expect(nudged).toContain(`${bar}    Confirm`);

    // Any arrow clears the nudge and moves the highlight.
    ui.stdin.write(DOWN);
    await tick(20);
    const cleared = stripColor(ui.lastFrame());
    expect(cleared).not.toContain(CONFIRM_NUDGE);
    expect(cleared).toContain(CHOOSE_HINTS);
    expect(cleared).toContain(`${bar}r   Confirm with a reason`);

    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it('confirms a reversible write on y', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('package.json', 'package_change'));
    await tick(PAST_GRACE);

    expect(stripColor(ui.lastFrame())).toContain(`${bar}y   Confirm`);
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

  it('leaves the reason step alone for arrows', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('r');
    await tick(20);
    ui.stdin.write(UP);
    ui.stdin.write(DOWN);
    await tick(20);

    ui.stdin.write('kept');
    await tick(20);
    ui.stdin.write(ENTER);
    await expect(pending).resolves.toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: 'kept',
    });
    ui.unmount();
  });

  it('denies on x', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('x');
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it('ignores keystrokes buffered before the prompt appeared', async () => {
    const ui = render(<ApprovalPrompt />);
    const pending = openApprovalPrompt(makeConfirmRequest('package.json', 'package_change'));
    await flushEffects();

    ui.stdin.write('y');
    ui.stdin.write(DOWN);
    ui.stdin.write(ENTER);
    await tick(20);
    expect(approvalPromptStore.get().status).toBe('pending');

    await tick(PAST_GRACE);
    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it.each([
    [40, 'destructive' as const, '.splitbrief/sessions/2026-08-10-a/state.json'],
    [60, 'package_change' as const, 'package.json'],
    [80, 'sensitive_change' as const, '.env.local'],
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
      // title, every option with its padded key cell, and the legend its own row.
      const chooseStep = stripColor(ui.lastFrame());
      const confirmRow = actionClass === 'destructive' ? `${bar}    Confirm` : `${bar}y   Confirm`;
      expect(chooseStep).toContain(approvalTitle(actionClass));
      expect(chooseStep).toContain(confirmRow);
      expect(chooseStep).toContain('Confirm with a reason');
      expect(chooseStep).toContain('Deny');
      expect(chooseStep).toContain(CHOOSE_HINTS);
      expect(chooseStep).not.toContain('…');

      ui.stdin.write('r');
      await tick(30);
      expect(frameRows(ui.lastFrame())).toBe(budget);

      const reasonStep = stripColor(ui.lastFrame());
      expect(reasonStep).toContain(CONFIRM_QUESTION);
      expect(reasonStep).toContain(CONFIRM_REASON_OPTIONAL);
      expect(reasonStep).toContain(CONFIRM_REASON_HINTS);

      ui.stdin.write(ESC);
      await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
      ui.unmount();
    },
  );

  it('resets confirmation progress when a pending request is superseded', async () => {
    const ui = render(<ApprovalPrompt />);
    const first = openApprovalPrompt(makeConfirmRequest('delete temp files'));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write(DOWN);
    await tick(20);
    expect(stripColor(ui.lastFrame())).toContain(`${bar}r   Confirm with a reason`);
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
    expect(frame).toContain(`${bar}    Confirm`);
    expect(frame).not.toContain('half a reason');
    expect(frame).not.toContain('Why are you making this change?');

    await flushEffects();
    ui.stdin.write(ESC);
    await expect(second).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });

  it('fits the choose-step legend and the nudge, shedding whole tail tokens when narrow', async () => {
    terminalSizeStore.__testReset({ cols: 34, rows: 40 });
    const ui = renderFeature(<ApprovalPrompt />, { cols: 34, rows: 40 });
    const pending = openApprovalPrompt(makeConfirmRequest('.git/config', 'destructive'));
    await tick(PAST_GRACE);
    await flushEffects();

    const width = approvalTextWidth(34);
    const legend = fitKeyLegend(CHOOSE_HINTS, width);
    expect(legend).toBe('↑↓ select · ⏎ confirm');
    const chooseStep = stripColor(ui.lastFrame());
    expect(chooseStep).toContain(legend);
    expect(chooseStep).not.toContain('esc deny');
    expect(chooseStep).not.toContain('…');

    ui.stdin.write('y');
    await tick(20);
    const nudge = fitKeyLegend(CONFIRM_NUDGE, width);
    expect(nudge).toBe('⏎ confirms this write');
    const nudged = stripColor(ui.lastFrame());
    expect(nudged).toContain(nudge);
    expect(nudged).not.toContain('esc deny');
    expect(frameRows(ui.lastFrame())).toBe(getApprovalPromptRows(approvalPromptStore.get(), 34));

    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });
});

describe('short-viewport clamp on the confirm panel', () => {
  afterEach(() => {
    terminalSizeStore.reset();
  });

  it('sheds its blank rows so the clamped panel keeps its legend and bottom border', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: false });
    const request = makeConfirmRequest('.env.local', 'sensitive_change');
    const pending = openApprovalPrompt(request);
    const budget = getApprovalPromptRows(approvalPromptStore.get(), 60);
    const ui = render(<ApprovalPrompt clampedBoxRows={budget - 2} />);
    await tick(PAST_GRACE);

    const lines = stripColor(ui.lastFrame()).replace(/\n$/, '').split('\n');
    expect(lines).toHaveLength(budget - 2);
    // The legend sits directly above the last row, so the bottom border is painted too.
    expect(lines.at(-2)).toContain(CHOOSE_HINTS);

    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });
});

const TRUST_DISCLOSURE = [
  'Executable: "/Users/someone/.local/bin/review-bot"',
  'Arguments: "--diff" "--strict"',
  'Contract: direct',
  'Working directory: Project directory',
  'Staging: None',
  'Environment names: "REVIEW_BOT_TOKEN", "REVIEW_BOT_URL"',
  'Environment access: Declared environment references only',
  'Filesystem: Not an OS sandbox; the process can access files available to the current user',
  'Network: Network access is not restricted',
  'Result: Reviewed workspace diff; it writes directly into the project directory',
  '',
  'Exact confirmation stores an owner-only reusable receipt.',
].join('\n');

describe('runner trust panel', () => {
  afterEach(() => {
    terminalSizeStore.reset();
  });

  it.each([
    // The cut rows hold one blank row, which the count leaves out.
    { cols: 60, rows: 18, lastSubjectRow: /… 9 more lines/ },
    { cols: 80, rows: 24, lastSubjectRow: /Exact confirmation stores/ },
  ])(
    'fits an unclamped panel in $cols x $rows and keeps the subject and the options',
    async ({ cols, rows, lastSubjectRow }) => {
      terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 120 });
      const ui = renderFeature(<ApprovalPrompt />, { cols, rows });
      const pending = openApprovalPrompt(makeConfirmRequest(TRUST_DISCLOSURE, 'runner_trust'));
      await tick(PAST_GRACE);

      const lines = stripColor(ui.lastFrame()).replace(/\n$/, '').split('\n');
      expect(lines.length).toBeLessThanOrEqual(rows);
      // The title sits right under the top border, and the legend right above the bottom one.
      expect(lines[1]).toContain(approvalTitle('runner_trust'));
      const frame = lines.join('\n');
      expect(frame).toContain('runner command from the project config');
      expect(frame).toContain('Executable:');
      expect(frame).toContain('Arguments: "--diff" "--strict"');
      expect(frame).toContain('y   Confirm');
      expect(frame).toContain('x   Deny');
      expect(lines.at(-2)).toContain(CHOOSE_HINTS);
      // The last subject row and the options keep a blank row between them.
      const confirmRow = lines.findIndex((line) => line.includes('y   Confirm'));
      expect(lines[confirmRow - 1]).toMatch(/^\|\s+\|$/);
      expect(lines[confirmRow - 2]).toMatch(lastSubjectRow);

      ui.stdin.write(ESC);
      await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
      ui.unmount();
    },
  );

  it('sheds disclosure lines from the bottom once a clamped panel has no blank rows left', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const ui = render(<ApprovalPrompt clampedBoxRows={12} />);
    const pending = openApprovalPrompt(makeConfirmRequest(TRUST_DISCLOSURE, 'runner_trust'));
    await tick(PAST_GRACE);

    const lines = stripColor(ui.lastFrame()).replace(/\n$/, '').split('\n');
    expect(lines).toHaveLength(12);
    const frame = lines.join('\n');
    expect(frame).toContain(approvalTitle('runner_trust'));
    expect(frame).toContain('Executable:');
    expect(frame).toContain('Arguments:');
    expect(frame).not.toContain('Exact confirmation stores');
    expect(frame).toContain('… 9 more lines');
    expect(frame).toContain('x   Deny');
    expect(lines.at(-2)).toContain(CHOOSE_HINTS);

    ui.stdin.write(ESC);
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_denied' });
    ui.unmount();
  });
});
