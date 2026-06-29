import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import {
  ApprovalPrompt,
  PROMPT_ZONE_Z,
  getStickyOptionZones,
  triggerStickyOption,
} from './approval-prompt.js';
import { openApprovalPrompt, approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import {
  _resetMouseZones,
  hitTopmostZone,
  registerMouseZone,
} from '../../../lib/terminal/mouse-zones.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { readConversationScrollSnapshot } from '../layout/snapshot.js';
import { getApprovalPromptRows } from '../prompt-rows.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../prompt-grace.js';
import { glyph } from '../../../lib/glyphs.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';

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

describe('ApprovalPrompt', () => {
  it('labels confirm prompts by action class', async () => {
    const ui = render(<ApprovalPrompt />);
    const first = openApprovalPrompt(makeConfirmRequest('.diptych/state.json', 'destructive'));
    await tick(PAST_GRACE);

    expect(ui.lastFrame() ?? '').toContain('control-plane file write');
    expect(ui.lastFrame() ?? '').toContain('.diptych/state.json');

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

    ui.stdin.write(ESC);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
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
    expect(ui.lastFrame() ?? '').toContain('approve once');

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

describe('sticky option click zones', () => {
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
    // boxTop(10) + border(1) + title(1) + blank(1) + request(1) + blank(1) = first option row 15.
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
    // boxBottom = 10 + 8 - 1 = 17, so the deny row at 18 is clipped and not registered.
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

  it('triggers the same store action a key would for each option', async () => {
    const allow = openApprovalPrompt(makeStickyRequest('write outside scope'));
    triggerStickyOption('a');
    await expect(allow).resolves.toEqual({ decision: 'allow', scope: 'once' });

    const deny = openApprovalPrompt(makeStickyRequest('write outside scope'));
    triggerStickyOption('x');
    await expect(deny).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
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
    const ui = render(<ApprovalPrompt clampedBoxRows={8} />);
    const decision = openApprovalPrompt(makeStickyRequest('write src/x.ts'));
    await tick(PAST_GRACE);

    const { contentRect } = readConversationScrollSnapshot();
    const boxTop = contentRect.top + contentRect.height;
    const centerX = 40;

    // The first option row sits inside the clamped box and stays clickable.
    expect(hitTopmostZone(centerX, boxTop + 5)?.id).toBe('approval-option-a');
    // The deny row (boxTop + 8) renders below the clamped box bottom (boxTop + 7) and the
    // overflow="hidden" shell hides it, so no zone may be registered there.
    expect(hitTopmostZone(centerX, boxTop + 8)).toBeUndefined();

    ui.stdin.write(ESC);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });
});
