import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { flushEffects, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { ApprovalPrompt, PROMPT_ZONE_Z } from '../approval-prompt.js';
import {
  openApprovalPrompt,
  approvalPromptStore,
} from '../../../../stores/approval-prompt/prompt.js';
import {
  _resetMouseZones,
  hitTopmostZone,
  registerMouseZone,
} from '../../../../lib/terminal/mouse-zones.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { readConversationScrollSnapshot } from '../../layout/snapshot.js';
import { getApprovalPromptRows, getStickyOptionZones } from '../../prompt-rows/approval.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../prompt-grace.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';

const ESC = '\u001b';
const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

function stripColor(frame: string | undefined): string {
  return stripAnsiStyles(frame ?? '');
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
  terminalSizeStore.reset();
});

describe('ApprovalPrompt sticky tier', () => {
  it('sanitizes action descriptions before rendering and measuring rows', async () => {
    terminalSizeStore.__testReset({ cols: 34, rows: 24, isSmall: true });
    const ui = render(<ApprovalPrompt />);
    const decision = openApprovalPrompt(
      makeStickyRequest(
        'write src/secret.ts \u001b]52;c;clipboard\u0007\u0000 token=abcdefghijklmnopqrstuvwxyz1234567890abcdef',
      ),
    );
    await tick(PAST_GRACE);

    const frame = stripColor(ui.lastFrame());
    expect(frame).toContain('write src/secret.ts');
    expect(frame).toContain('token=***REDACTED***');
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');
    expect(frame).not.toContain('\u0000');
    expect(frame.split('\n')).toHaveLength(getApprovalPromptRows(approvalPromptStore.get(), 34));

    await flushEffects();
    ui.stdin.write(ESC);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it('ignores a keystroke that lands inside the typeahead grace window, honours it after', async () => {
    const ui = render(<ApprovalPrompt />);
    const decision = openApprovalPrompt(makeStickyRequest('write outside scope'));
    await flushEffects();

    ui.stdin.write('a');
    await tick(1);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await tick(1);
    expect(settled).toBe(false);
    expect(ui.lastFrame() ?? '').toContain('Approve once');

    await tick(PAST_GRACE);
    await flushEffects();
    ui.stdin.write('a');
    await expect(decision).resolves.toEqual({ decision: 'allow', scope: 'once' });
    ui.unmount();
  });

  it('does not consume keystrokes while an overlay is open, honours them after it closes', async () => {
    const ui = render(<ApprovalPrompt />);
    const decision = openApprovalPrompt(makeStickyRequest('write outside scope'));
    overlayStore.open('settings');
    await tick(PAST_GRACE);

    await flushEffects();
    ui.stdin.write('a');
    await tick(1);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await tick(1);
    expect(settled).toBe(false);

    overlayStore.close();
    await flushEffects();
    ui.stdin.write('a');
    await expect(decision).resolves.toEqual({ decision: 'allow', scope: 'once' });
    ui.unmount();
  });
});

describe('sticky option click zones', () => {
  beforeEach(() => {
    _resetMouseZones();
  });

  afterEach(() => {
    _resetMouseZones();
    approvalPromptStore.__testReset();
  });

  it('maps each option to a full-width row anchored at boxTop + offset (calibration)', () => {
    const zones = getStickyOptionZones({
      boxTop: 10,
      cols: 80,
      promptRows: 30,
      actionClass: 'write_out_of_scope',
      actionDescription: 'write src/x.ts',
    });
    expect(zones.map((zone) => zone.key)).toEqual(['a', 's', 'w', 'x']);
    expect(zones[0]).toMatchObject({ key: 'a', left: 1, right: 80, top: 15, bottom: 15 });
    expect(zones[3]).toMatchObject({ key: 'x', top: 18, bottom: 18 });
  });

  it('drops options truncated below the clamped prompt box (no phantom hotspot)', () => {
    const zones = getStickyOptionZones({
      boxTop: 10,
      cols: 80,
      promptRows: 8,
      actionClass: 'write_out_of_scope',
      actionDescription: 'write src/x.ts',
    });
    expect(zones.map((zone) => zone.key)).toEqual(['a', 's', 'w']);
  });

  it('hits the registered row and is a no-op one row above it', () => {
    const onClick = vi.fn();
    const [first] = getStickyOptionZones({
      boxTop: 10,
      cols: 80,
      promptRows: 30,
      actionClass: 'write_out_of_scope',
      actionDescription: 'write src/x.ts',
    });
    if (!first) throw new Error('expected a sticky option zone');
    registerMouseZone({
      id: 'approval-option-a',
      left: first.left,
      right: first.right,
      top: first.top,
      bottom: first.bottom,
      z: PROMPT_ZONE_Z,
      onClick,
    });
    hitTopmostZone(40, first.top)?.onClick?.();
    hitTopmostZone(40, first.top - 1)?.onClick?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('registered option zones trigger the same store action a key would', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
    const allow = openApprovalPrompt(makeStickyRequest('write outside scope'));
    const ui = render(<ApprovalPrompt />);
    const { contentRect } = readConversationScrollSnapshot();
    const boxTop = contentRect.top + contentRect.height;
    const centerX = 40;

    await tick(PAST_GRACE);
    await vi.waitFor(() => {
      expect(hitTopmostZone(centerX, boxTop + 5)?.id).toBe('approval-option-a');
    });
    hitTopmostZone(centerX, boxTop + 5)?.onClick?.();
    await expect(allow).resolves.toEqual({ decision: 'allow', scope: 'once' });
    ui.unmount();
    _resetMouseZones();

    const deny = openApprovalPrompt(makeStickyRequest('write outside scope'));
    const denyUi = render(<ApprovalPrompt />);
    await tick(PAST_GRACE);
    await vi.waitFor(() => {
      expect(hitTopmostZone(centerX, boxTop + 8)?.id).toBe('approval-option-x');
    });
    hitTopmostZone(centerX, boxTop + 8)?.onClick?.();
    await expect(deny).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    denyUi.unmount();
  });
});

describe('short-viewport clamp clips registered sticky zones', () => {
  beforeEach(() => {
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  afterEach(() => {
    _resetMouseZones();
    approvalPromptStore.__testReset();
    terminalSizeStore.reset();
  });

  it('does not activate the deny zone below the shell-clamped prompt box', async () => {
    const decision = openApprovalPrompt(makeStickyRequest('write src/x.ts'));
    const ui = render(<ApprovalPrompt clampedBoxRows={8} />);
    await tick(PAST_GRACE);

    const { contentRect } = readConversationScrollSnapshot();
    const boxTop = contentRect.top + contentRect.height;
    const centerX = 40;

    expect(hitTopmostZone(centerX, boxTop + 5)?.id).toBe('approval-option-a');
    expect(hitTopmostZone(centerX, boxTop + 8)).toBeUndefined();

    await flushEffects();
    ui.stdin.write(ESC);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });
});

describe('multi-line trust disclosures in the sticky prompt', () => {
  beforeEach(() => {
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
  });

  afterEach(() => {
    _resetMouseZones();
    approvalPromptStore.__testReset();
    terminalSizeStore.reset();
  });

  it('keeps one line per disclosed fact instead of running them together', async () => {
    const ui = render(<ApprovalPrompt />);
    const decision = openApprovalPrompt(
      makeStickyRequest(
        'Executable: "/bin/sh"\nArguments: "-c" "id -un > SB_PROOF.txt"\nNetwork: Network access is not restricted',
      ),
    );
    await tick(PAST_GRACE);

    const lines = stripColor(ui.lastFrame()).split('\n');
    expect(lines.some((line) => line.includes('Executable: "/bin/sh"'))).toBe(true);
    expect(lines.some((line) => line.includes('Arguments: "-c" "id -un'))).toBe(true);
    expect(lines.some((line) => line.includes('Network: Network access is not restricted'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('Executable:') && line.includes('Arguments:'))).toBe(
      false,
    );
    expect(lines).toHaveLength(getApprovalPromptRows(approvalPromptStore.get(), 120));

    await flushEffects();
    ui.stdin.write(ESC);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });
});
