import { listRowLead } from '../../../components/list-row.js';
import chalk from 'chalk';
import { defaultTheme } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { openReviewChecksPrompt } from '../../../stores/review-checks-prompt/prompt.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../lib/terminal/typeahead-grace.js';
import type { ReviewChecksApprovalRequest } from '../../../core/approval/types.js';
import { ReviewChecksCard } from './card.js';
import { reviewChecksCardTitle, reviewChecksVisibleCommands } from './options.js';

const originalColorLevel = chalk.level;

const DOWN = '\x1b[B';
const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

const REQUEST: ReviewChecksApprovalRequest = {
  scope: 'final',
  commands: [
    { id: 'V1', command: 'npm run typecheck', reason: 'The change edits exported types.' },
    { id: 'V2', command: 'npm test', reason: 'The unit tests cover the formatter.\nMore.' },
  ],
};

function renderCard(focused = true) {
  const answer = openReviewChecksPrompt(REQUEST);
  const onFocusChange = vi.fn<(cardFocused: boolean) => void>();
  const ui = renderFeature(
    <ReviewChecksCard request={REQUEST} focused={focused} onFocusChange={onFocusChange} />,
  );
  return { ui, answer, onFocusChange };
}

it('returns the reviewer title as seat and secondary parts', () => {
  expect(reviewChecksCardTitle(REQUEST)).toEqual([
    { text: 'Reviewer', tone: 'reviewer' },
    { text: ' checks', tone: 'textDim' },
    { text: ' · ', tone: 'textDim' },
    { text: 'chose 2', tone: 'textDim' },
    { text: ' · ', tone: 'textDim' },
    { text: 'none has run yet', tone: 'textDim' },
  ]);
});

describe('ReviewChecksCard', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
  });

  afterEach(() => {
    chalk.level = originalColorLevel;
    resetAllStores();
  });

  it.each([60, 120])(
    'keeps option names distinct from wrapped dim consequences at %s columns',
    async (cols) => {
      chalk.level = 3;
      terminalSizeStore.__testReset({ cols, rows: 40 });
      const { ui } = renderCard();
      const frame = ui.lastFrame();
      expect(frame).toContain(
        paint(defaultTheme.textDim, 'npm run typecheck').replace('\u001b[39m', ''),
      );
      expect(frame).toContain(
        paint(defaultTheme.accent, `${listRowLead('active')}Run all`).replace('\u001b[39m', ''),
      );
      expect(frame).toContain(paint(defaultTheme.text, 'Skip all').replace('\u001b[39m', ''));
      expect(frame).toContain(paint(defaultTheme.textDim, ' · ').replace('\u001b[39m', ''));
      expect(frame).toContain(
        paint(defaultTheme.textDim, ' · run none;').replace('\u001b[39m', ''),
      );
      await flushEffects();
      await tick(PAST_GRACE);
      ui.stdin.write(DOWN);
      await flushEffects();
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.accent, `${listRowLead('active')}Skip all`).replace('\u001b[39m', ''),
      );
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.textDim, ' · run none;').replace('\u001b[39m', ''),
      );
      ui.unmount();
    },
  );

  it('names each chosen command with the first line of its reason, then Run all and Skip all', async () => {
    const { ui } = renderCard();
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Reviewer checks · chose 2 · none has run yet');
    expect(frame).toContain('V1  npm run typecheck · The change edits exported types.');
    expect(frame).toContain('V2  npm test · The unit tests cover the formatter.');
    expect(frame).not.toContain('More.');
    expect(frame).toContain('Run all');
    expect(frame).toContain('Skip all');
    expect(frame).toContain('tab type a message');
    ui.unmount();
  });

  it('shows a command with a line break or a tab on its one row', async () => {
    const request: ReviewChecksApprovalRequest = {
      scope: 'final',
      commands: [
        { id: 'V1', command: "make '--eval=pwn:\n\ttouch pwned' pwn", reason: 'Runs the suite.' },
        { id: 'V2', command: 'npm test', reason: 'The unit tests.' },
      ],
    };
    void openReviewChecksPrompt(request);
    const ui = renderFeature(
      <ReviewChecksCard request={request} focused onFocusChange={vi.fn()} />,
    );
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const { ui: plain } = renderCard();
    await tick();
    const plainFrame = stripAnsiStyles(plain.lastFrame() ?? '');

    expect(frame).toContain("V1  make '--eval=pwn: touch pwned' pwn · Runs the suite.");
    expect(frame.split('\n')).toHaveLength(plainFrame.split('\n').length);
    ui.unmount();
    plain.unmount();
  });

  it('answers run on Enter', async () => {
    const { ui, answer } = renderCard();
    await flushEffects();
    await tick(PAST_GRACE);
    ui.stdin.write('\r');

    await expect(answer).resolves.toBe('run');
    ui.unmount();
  });

  it('strips terminal controls and links from a reason on the command row', async () => {
    const request: ReviewChecksApprovalRequest = {
      scope: 'final',
      commands: [
        {
          id: 'V1',
          command: 'npm test',
          reason: 'Checks \x1b[2K\x1b]8;;https://example.test\x1b\\the suite\x1b]8;;\x1b\\.',
        },
      ],
    };
    void openReviewChecksPrompt(request);
    const ui = renderFeature(
      <ReviewChecksCard request={request} focused onFocusChange={vi.fn()} />,
    );
    await tick();
    const raw = ui.lastFrame() ?? '';

    expect(stripAnsiStyles(raw)).toContain('V1  npm test · Checks the suite.');
    expect(raw).not.toContain('\x1b[2K');
    expect(raw).not.toContain('\x1b]8;');
    expect(raw).not.toContain('https://example.test');
    ui.unmount();
  });

  it('answers skip from Skip all', async () => {
    const { ui, answer } = renderCard();
    await flushEffects();
    await tick(PAST_GRACE);
    ui.stdin.write(DOWN);
    await tick(30);
    ui.stdin.write('\r');

    await expect(answer).resolves.toBe('skip');
    ui.unmount();
  });

  it('takes no Enter that arrives with the card', async () => {
    const { ui, answer } = renderCard();
    const settled = vi.fn();
    void answer.then(settled);
    await flushEffects();
    ui.stdin.write('\r');
    await tick(30);

    expect(settled).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('binds no bare letters and hands the keyboard to the composer on Tab', async () => {
    const { ui, answer, onFocusChange } = renderCard();
    const settled = vi.fn();
    void answer.then(settled);
    await flushEffects();
    await tick(PAST_GRACE);
    for (const letter of ['r', 's', 'y', 'n', 'x']) ui.stdin.write(letter);
    await tick(30);
    ui.stdin.write('\t');
    await tick(30);

    expect(settled).not.toHaveBeenCalled();
    expect(onFocusChange).toHaveBeenCalledWith(false);
    ui.unmount();
  });
  it('paints Reviewer with reviewer, commands and ids with textDim', () => {
    chalk.level = 3;
    const { ui } = renderCard();
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.reviewer, 'Reviewer').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, 'V1').replace('\u001b[39m', ''));
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.accent, `${listRowLead('active')}Run all`).replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.textDim, 'npm run typecheck').replace('\u001b[39m', ''),
    );
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      'Reviewer checks · chose 2 · none has run yet',
    );
    ui.unmount();
  });
});

describe('reviewChecksVisibleCommands', () => {
  it('shows every command and the rule when the card has its full height', () => {
    expect(reviewChecksVisibleCommands(REQUEST, 120, 9)).toEqual({
      shown: REQUEST.commands,
      hidden: 0,
      rule: true,
    });
  });

  it('sheds the rule first, then the last commands onto a count', () => {
    expect(reviewChecksVisibleCommands(REQUEST, 120, 8)).toMatchObject({ hidden: 0, rule: false });
    expect(reviewChecksVisibleCommands(REQUEST, 120, 7)).toEqual({
      shown: [],
      hidden: 2,
      rule: false,
    });
  });
});
