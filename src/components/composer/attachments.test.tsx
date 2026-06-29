import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { Composer } from './composer.js';
import {
  AttachmentChips,
  attachmentChipLabel,
  attachmentChipRows,
  expandPastes,
  extractPasteCapture,
  insertPasteDraftMarker,
  pasteDraftMarker,
  pasteChipLabel,
  type PasteMarker,
} from './attachments.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('attachmentChipLabel', () => {
  it('fits CJK and emoji file names by terminal cell width', () => {
    const label = attachmentChipLabel('/tmp/界語🙂界語🙂界語🙂界語🙂界語🙂.png', 0);

    expect(label).toContain('📎 1 ');
    expect(label).not.toContain('📎 1:');
    expect(getTerminalCellWidth(label)).toBeLessThanOrEqual(32);
  });
});

describe('pasteChipLabel', () => {
  it('renders a dim content-reference marker with the 1-based index and line count', () => {
    expect(pasteChipLabel(0, 48)).toBe('[paste #1 +48 lines]');
    expect(pasteChipLabel(1, 12)).toBe('[paste #2 +12 lines]');
  });

  it('drops the trailing " lines" in the short narrow form', () => {
    expect(pasteChipLabel(0, 48, { short: true })).toBe('[paste #1 +48]');
    expect(pasteChipLabel(1, 12, { short: true })).toBe('[paste #2 +12]');
  });
});

describe('AttachmentChips narrow collapse', () => {
  const pastes: PasteMarker[] = [
    { id: 'p0', lineCount: 48, marker: pasteDraftMarker('p0'), text: 'a' },
    { id: 'p1', lineCount: 12, marker: pasteDraftMarker('p1'), text: 'b' },
    { id: 'p2', lineCount: 5, marker: pasteDraftMarker('p2'), text: 'c' },
    { id: 'p3', lineCount: 7, marker: pasteDraftMarker('p3'), text: 'd' },
  ];

  it('caps to the newest two short markers and a "+N more" tail below the width gate', () => {
    terminalSizeStore.__testReset({ cols: 40 });
    const ui = render(
      <Box width={40}>
        <AttachmentChips pastes={pastes} />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('[paste #3 +5]');
    expect(frame).toContain('[paste #4 +7]');
    expect(frame).toContain('+2 more');
    expect(frame).not.toContain('+48');
    expect(frame).not.toContain('lines');
    ui.unmount();
    terminalSizeStore.__testReset({ cols: 80 });
  });

  it('keeps the full inline markers at normal width', () => {
    terminalSizeStore.__testReset({ cols: 80 });
    const ui = render(
      <Box width={80}>
        <AttachmentChips pastes={pastes.slice(0, 2)} />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('[paste #1 +48 lines]');
    expect(frame).toContain('[paste #2 +12 lines]');
    expect(frame).not.toContain('more');
    ui.unmount();
  });
});

describe('extractPasteCapture', () => {
  it('captures a multi-line paste, leaving the field text unchanged', () => {
    const previous = 'fix the bug ';
    const pasted = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const result = extractPasteCapture(previous, `${previous}${pasted}`);

    expect(result).not.toBeNull();
    expect(result?.text).toBe(pasted);
    expect(result?.lineCount).toBe(5);
    expect(result?.remaining).toBe(previous);
  });

  it('removes only the pasted block when inserted mid-text', () => {
    const result = extractPasteCapture('abcd', 'abP\nQ\nR\nScd');

    expect(result?.text).toBe('P\nQ\nR\nS');
    expect(result?.lineCount).toBe(4);
    expect(result?.remaining).toBe('abcd');
    expect(result?.insertAt).toBe(2);
  });

  it('records the insertion point for a mid-text paste', () => {
    const result = extractPasteCapture('fix the bug ', 'fix the P\nQ\nR\nS bug ');

    expect(result?.insertAt).toBe(8);
    expect(result?.remaining).toBe('fix the bug ');
  });

  it('ignores single keystrokes, single newlines, and small pastes', () => {
    expect(extractPasteCapture('ab', 'abc')).toBeNull();
    expect(extractPasteCapture('ab', 'ab\n')).toBeNull();
    expect(extractPasteCapture('', 'one\ntwo\nthree')).toBeNull();
  });

  it('ignores deletions and no-op changes', () => {
    expect(extractPasteCapture('abcd', 'abc')).toBeNull();
    expect(extractPasteCapture('abcd', 'abcd')).toBeNull();
  });
});

describe('expandPastes', () => {
  const pastes: PasteMarker[] = [
    { id: 'p0', lineCount: 2, marker: pasteDraftMarker('p0'), text: 'log A\nline 2' },
    { id: 'p1', lineCount: 2, marker: pasteDraftMarker('p1'), text: 'log B\nline 2' },
  ];

  it('returns the text untouched when there are no pastes', () => {
    expect(expandPastes('hello', [])).toBe('hello');
  });

  it('appends paste bodies after the typed message', () => {
    expect(expandPastes('fix it', pastes)).toBe('fix it\n\nlog A\nline 2\n\nlog B\nline 2');
  });

  it('submits the paste bodies alone when the field is empty', () => {
    expect(expandPastes('', pastes)).toBe('log A\nline 2\n\nlog B\nline 2');
  });

  it('reconstructs mid-text paste from an inline draft marker', () => {
    const marker = pasteDraftMarker('p0');
    const pastes: PasteMarker[] = [{ id: 'p0', lineCount: 4, marker, text: 'P\nQ\nR\nS' }];
    expect(expandPastes(`ab${marker}cd`, pastes)).toBe('abP\nQ\nR\nScd');
  });

  it('inserts a draft marker at the captured insertion point', () => {
    expect(insertPasteDraftMarker('abcd', 2, pasteDraftMarker('p0'))).toBe('ab[paste:p0]cd');
  });

  it('creates opaque default draft markers instead of predictable paste ids', () => {
    const first = pasteDraftMarker();
    const second = pasteDraftMarker();

    expect(first).toMatch(/^\[paste:[0-9a-f-]+\]$/);
    expect(second).toMatch(/^\[paste:[0-9a-f-]+\]$/);
    expect(first).not.toBe(second);
  });

  it('does not expand user-authored visible paste labels', () => {
    const marker = pasteDraftMarker('p0');
    const pastes: PasteMarker[] = [{ id: 'p0', lineCount: 4, marker, text: 'P\nQ\nR\nS' }];

    expect(expandPastes(`[paste #1 +4 lines] ${marker}`, pastes)).toBe(
      '[paste #1 +4 lines] P\nQ\nR\nS',
    );
  });

  it('does not let user text that resembles a predictable marker steal the paste body', () => {
    const marker = pasteDraftMarker('opaque-token');
    const pastes: PasteMarker[] = [{ id: 'paste-0', lineCount: 4, marker, text: 'P\nQ\nR\nS' }];

    expect(expandPastes(`keep [paste:paste-0] ${marker}`, pastes)).toBe(
      'keep [paste:paste-0] P\nQ\nR\nS',
    );
  });
});

describe('attachmentChipRows', () => {
  it('reserves no rows when there are no chips', () => {
    expect(attachmentChipRows([], [], 80)).toBe(0);
  });

  it('counts a single wide row for one chip that fits the content width', () => {
    expect(attachmentChipRows([], [{ path: '/tmp/shot.png' }], 80)).toBe(1);
  });

  it('caps narrow chips to the two newest rows plus a "+N more" tail row', () => {
    const pastes: PasteMarker[] = [
      { id: 'p0', lineCount: 4, marker: pasteDraftMarker('p0'), text: 'a' },
      { id: 'p1', lineCount: 4, marker: pasteDraftMarker('p1'), text: 'b' },
      { id: 'p2', lineCount: 4, marker: pasteDraftMarker('p2'), text: 'c' },
    ];
    expect(attachmentChipRows(pastes, [], 40)).toBe(3);
    expect(attachmentChipRows(pastes.slice(0, 2), [], 40)).toBe(2);
  });

  it('wraps wide chips onto additional rows when they exceed the content width', () => {
    const pending = Array.from({ length: 8 }, (_, index) => ({
      path: `/tmp/attachment-${index}.png`,
    }));
    expect(attachmentChipRows([], pending, 60)).toBeGreaterThan(1);
  });
});

describe('Composer chip-row height budget', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('reserves extra input-height rows for pending attachment chips above the box', async () => {
    inputHeightStore.__testReset({ rows: 3 });
    attachmentsStore.add({
      id: 'a0',
      kind: 'image',
      path: '/tmp/screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 1,
    });

    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode="normal"
        hint=""
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
    await tick(20);

    // empty input (1 visible row) + 2 box border rows + 1 wide chip row
    expect(inputHeightStore.get().rows).toBe(4);
    ui.unmount();
  });
});

describe('Composer question-mode transition', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('does not submit stale normal-mode text after switching into question mode', async () => {
    const submits: string[] = [];
    const baseProps: Omit<ComponentProps<typeof Composer>, 'mode'> = {
      commands: [],
      currentScreen: 'workflow',
      hint: '',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
    };

    const ui = renderFeature(<Composer {...baseProps} mode="normal" />);
    ui.stdin.write('stale normal text');
    await tick(20);
    expect(ui.lastFrame()).toContain('stale normal text');

    ui.rerender(<Composer {...baseProps} mode="question" />);
    await tick(20);
    expect(ui.lastFrame()).not.toContain('stale normal text');

    ui.stdin.write('\r');
    await tick(20);

    expect(submits).not.toContain('stale normal text');
    ui.unmount();
  });

  it('clears a stale answer when a new question supersedes the current question mode', async () => {
    const submits: string[] = [];
    const baseProps: Omit<ComponentProps<typeof Composer>, 'mode'> = {
      commands: [],
      currentScreen: 'workflow',
      hint: 'first question',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      questionEpoch: 1,
    };

    const ui = renderFeature(<Composer {...baseProps} mode="question" />);
    ui.stdin.write('stale answer');
    await tick(20);
    expect(ui.lastFrame()).toContain('stale answer');

    ui.rerender(
      <Composer {...baseProps} mode="question" hint="second question" questionEpoch={2} />,
    );
    await tick(20);
    expect(ui.lastFrame()).not.toContain('stale answer');

    ui.stdin.write('\r');
    await tick(20);

    expect(submits).not.toContain('stale answer');
    ui.unmount();
  });
});

describe('Composer home feedback sanitization', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
  });

  // Both /attach and file-drop converge on feedbackStore.setMessage(`Attached: ${path}`), so the
  // home feedback render edge is the single point that must strip terminal controls.
  it('strips OSC/CSI control bytes from home attachment feedback while keeping the stored message raw', async () => {
    const rawMessage = `Attached: ${ESC}[2J${ESC}]0;LEAKTITLE${BEL}/tmp/screenshot.png`;
    feedbackStore.setMessage(rawMessage);

    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint="Ready to plan"
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain(`${ESC}]0;`);
    expect(frame).not.toContain(`${ESC}[2J`);
    const visible = stripAnsiStyles(frame);
    expect(visible).not.toContain('LEAKTITLE');
    expect(visible).toContain('screenshot.png');
    expect(feedbackStore.get().message).toBe(rawMessage);
    ui.unmount();
  });
});
