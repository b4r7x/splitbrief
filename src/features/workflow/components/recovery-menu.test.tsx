import chalk from 'chalk';
import { defaultTheme, ThemeProvider } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import {
  renderThroughFilteredStdin,
  type FilteredStdinHarnessDependencies,
} from '#testing/helpers/filtered-stdin-harness.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { listRowLead } from '../../../components/list-row/lead.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { createDraftDocument } from '../../../core/composer/document.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { clampWorkflowPromptRows } from '../layout/rect.js';
import { RecoveryMenu } from './recovery-menu.js';
import { settleSlashHandoff, startSlashHandoff } from '../slash-handoff.js';
import { UNREAD_WORDS_MESSAGE } from '../inline-menu/use-keys.js';
import { PASTE_END, PASTE_START } from '../../../lib/terminal/filtered-stdin/paste.js';
import { buildReviewFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/review-failed.js';
import { buildRetryExhaustedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/retry.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { recoveryPromptSummaryRows } from '../recovery/prompt-text.js';
import { recoveryMenuRow } from '../recovery/menu-label.js';
import { getRecoveryPromptActions, recoveryActionKey } from '../recovery/actions.js';

afterEach(() => {
  composerLiveStore.reset();
  runViewStore.__testReset();
  feedbackStore.reset();
  settleSlashHandoff();
});

function mount(onResolve: (answer: string) => void, width = 80, issue = makeRecoveryIssue()) {
  return renderFeature(
    <RecoveryMenu
      issue={issue}
      width={width}
      clampedBoxRows={14}
      focused
      onFocusChange={() => {}}
      onResolve={onResolve}
    />,
  );
}

function seatSwapIssue() {
  return makeRecoveryIssue({
    reason: 'runner-usage-limit',
    availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
    recommendedAction: 'switch-seat',
    switchSeat: {
      seat: 'build',
      candidates: [{ tool: 'opencode' }, { tool: 'codex' }],
    },
  });
}

it.each([
  ['dark', 24],
  ['dark', 80],
  ['light', 24],
  ['light', 80],
] as const)(
  'keeps multiline recovery frame rows and span colors in %s at width %s',
  (variant, width) => {
    const colorLevel = chalk.level;
    chalk.level = 3;
    const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
    const ui = renderFeature(
      <ThemeProvider theme={theme}>
        <RecoveryMenu
          issue={makeRecoveryIssue({
            reason: 'seat-protocol-error',
            seat: 'review',
            taskId: undefined,
            taskTitle: undefined,
            files: [],
            affectedTaskIds: [],
            details: [],
            message: 'Provider refused request\n  try another tool',
          })}
          width={width}
          clampedBoxRows={14}
          focused
          onFocusChange={() => {}}
          onResolve={() => {}}
        />
      </ThemeProvider>,
    );
    try {
      const frame = ui.lastFrame();
      const rows = stripAnsiStyles(frame).split('\n');
      expect(rows.slice(1, 4).map((line) => line.slice(2, -2).trimEnd())).toEqual([
        width === 24 ? 'Seat down · Provide…' : 'Seat down · Provider refused request',
        '',
        '    try another tool',
      ]);
      expect(rows.map(getTerminalCellWidth)).toEqual(Array(14).fill(width));
      expect(frame).toContain(
        paint(theme[stateTone('attention')], 'Seat down').replace('\u001b[39m', ''),
      );
      expect(frame).toContain(paint(theme.textDim, ' · ').replace('\u001b[39m', ''));
      expect(frame).toContain(
        paint(theme.text, width === 24 ? 'Provide' : 'Provider refused request').replace(
          '\u001b[39m',
          '',
        ),
      );
      expect(frame).toContain(
        paint(theme.textDim, '    try another tool').replace('\u001b[39m', ''),
      );
    } finally {
      ui.unmount();
      chalk.level = colorLevel;
    }
  },
);

it('a letter key presses the offered row it names', async () => {
  const onResolve = vi.fn();
  const ui = mount(onResolve);
  await flushEffects();
  ui.stdin.write('s');
  await flushEffects();
  expect(onResolve).toHaveBeenCalledExactlyOnceWith('s');
  ui.unmount();
});

it('a letter that names no offered row does nothing', async () => {
  const onResolve = vi.fn();
  const ui = mount(onResolve);
  await flushEffects();
  ui.stdin.write('x');
  await flushEffects();
  expect(onResolve).not.toHaveBeenCalled();
  expect(stripAnsiStyles(ui.lastFrame())).toContain('↑↓ select');
  ui.unmount();
});

it('hands the keys to the composer on Tab and answers no row', async () => {
  const onFocusChange = vi.fn<(menuFocused: boolean) => void>();
  const onResolve = vi.fn();
  const ui = renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue()}
      width={80}
      clampedBoxRows={14}
      focused
      onFocusChange={onFocusChange}
      onResolve={onResolve}
    />,
  );
  await flushEffects();
  ui.stdin.write('\t');
  await flushEffects();
  expect(onFocusChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(onResolve).not.toHaveBeenCalled();
  ui.unmount();
});

it('reads no Tab or letter in the read whose slash handed the keys to the composer', async () => {
  const onFocusChange = vi.fn<(menuFocused: boolean) => void>();
  const onResolve = vi.fn();
  const ui = renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue()}
      width={80}
      clampedBoxRows={14}
      focused
      onFocusChange={onFocusChange}
      onResolve={onResolve}
    />,
  );
  await flushEffects();
  startSlashHandoff();
  ui.stdin.write('\t');
  await flushEffects();
  ui.stdin.write('s');
  await flushEffects();
  expect(onFocusChange).not.toHaveBeenCalled();
  expect(onResolve).not.toHaveBeenCalled();
  ui.unmount();
});

// The seat's picker is the one place its tool and model are chosen, so the swap row hands the
// prompt straight to the driver that opens it — a tool list here would name tools without models.
it('takes the seat swap in one press and never lists the offered tools itself', async () => {
  const onResolve = vi.fn();
  const ui = mount(onResolve, 80, seatSwapIssue());
  await flushEffects();
  ui.stdin.write('\r');
  await flushEffects();
  expect(onResolve).toHaveBeenCalledExactlyOnceWith('w');
  expect(stripAnsiStyles(ui.lastFrame())).not.toContain('OpenCode');
  ui.unmount();
});

it.each([
  [
    'the final review, on an inherited tool',
    { seat: 'review', taskId: undefined, phase: 'final-review' },
    'Change REVIEW tool  runs the review again',
  ],
  [
    "a brief's consult",
    { seat: 'plan', phase: 'escalating' },
    'Change PLAN tool  continues this brief',
  ],
  [
    'a planning step',
    { seat: 'plan', taskId: undefined, phase: 'planning' },
    'Change PLAN tool  runs this step again',
  ],
  // Saved before halts named their seat: the applier reads the planner phase as the plan seat's.
  [
    'a planning step, saved without its seat',
    { seat: undefined, taskId: undefined, phase: 'planning' },
    'Change PLAN tool  runs this step again',
  ],
] as const)('names what the swap runs again after a halt on %s', async (_halt, halt, label) => {
  const issue = makeRecoveryIssue({
    ...halt,
    reason: 'runner-usage-limit',
    availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
    recommendedAction: 'switch-seat',
    switchSeat: { seat: halt.seat ?? 'plan', candidates: [{ tool: 'claude-code' }] },
  });
  const ui = mount(vi.fn(), 100, issue);
  await flushEffects();
  expect(stripAnsiStyles(ui.lastFrame())).toContain(label);
  ui.unmount();
});

// On a consult halt "Try again" reads as retrying the consult alone, but the brief continues on
// the files it kept; a retry that re-runs the call the halt stopped needs no second clause.
it.each([
  ["a brief's consult", { seat: 'plan', phase: 'escalating' }, 'Try again  continues this brief'],
  ['a planning step', { seat: 'plan', taskId: undefined, phase: 'planning' }, 'Try again'],
  ['a BUILD call', { seat: 'build', phase: 'implementing' }, 'Try again'],
] as const)('says what a retry after a halt on %s runs', async (_halt, halt, label) => {
  const issue = makeRecoveryIssue({
    ...halt,
    reason: 'runner-usage-limit',
    availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
    recommendedAction: 'retry-same-worker',
  });
  const ui = mount(vi.fn(), 100, issue);
  await flushEffects();
  const retryRow = stripAnsiStyles(ui.lastFrame())
    .split('\n')
    .find((line) => line.includes('Try again'));
  expect(retryRow?.replace(/ {2,}/g, ' ')).toContain(label.replace(/ {2,}/g, ' '));
  ui.unmount();
});

// A panel too narrow for a row's words and its marker keeps the words whole and drops the marker.
it('keeps every action label whole on a 56-column panel', async () => {
  const issue = makeRecoveryIssue({
    reason: 'runner-usage-limit',
    seat: 'review',
    taskId: undefined,
    phase: 'final-review',
    availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
    recommendedAction: 'switch-seat',
    switchSeat: { seat: 'review', candidates: [{ tool: 'claude-code' }] },
  });
  const ui = mount(vi.fn(), 56, issue);
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  const rows = frame
    .split('\n')
    .filter((line) => /Try again|Change REVIEW tool|Skip task|End run/.test(line));
  expect(rows).toHaveLength(4);
  const nameRow = frame.split('\n').findIndex((line) => line.includes('Change REVIEW tool'));
  const name = frame.split('\n')[nameRow] ?? '';
  const detail = frame.split('\n')[nameRow + 1] ?? '';
  expect(detail.indexOf('runs the review again')).toBe(name.indexOf('Change REVIEW tool'));
  for (const row of rows) expect(row).not.toContain('…');
  ui.unmount();
});

it('drops a legend token whole rather than cutting the last key in half', async () => {
  const ui = mount(vi.fn(), 30);
  await flushEffects();
  const legendRow = stripAnsiStyles(ui.lastFrame())
    .split('\n')
    .find((line) => line.includes('↑↓ select'));
  expect(legendRow).toContain('⏎ confirm');
  expect(legendRow).not.toContain('tab type a correction');
  expect(legendRow).not.toContain('…');
  ui.unmount();
});

it('shows each row its key beside its label', async () => {
  const issue = makeRecoveryIssue({
    reason: 'dependency-blocked',
    availableActions: ['skip-current-task', 'end-run'],
    recommendedAction: 'skip-current-task',
  });
  const ui = mount(vi.fn(), 80, issue);
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  expect(frame).toContain('s  Skip task');
  expect(frame).toContain('a  End run');
  ui.unmount();
});

it('keeps the recovery key beside the seat change while the composer has focus', () => {
  const ui = renderFeature(
    <RecoveryMenu
      issue={seatSwapIssue()}
      width={80}
      clampedBoxRows={14}
      focused={false}
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  try {
    const row = stripAnsiStyles(ui.lastFrame())
      .split('\n')
      .find((line) => line.includes('Change BUILD tool'));
    expect(row).toContain('w  Change BUILD tool');
    expect(row?.slice(1, row.indexOf('w  Change BUILD tool')).trim()).toBe('');
  } finally {
    ui.unmount();
  }
});

it('aligns the recommendation at the right edge of the selected row', async () => {
  const issue = makeRecoveryIssue({
    reason: 'dependency-blocked',
    availableActions: ['skip-current-task', 'end-run'],
    recommendedAction: 'end-run',
  });
  const ui = mount(vi.fn(), 80, issue);
  await flushEffects();
  const row = stripAnsiStyles(ui.lastFrame())
    .split('\n')
    .find((line) => line.includes('End run'));
  expect(row).toContain(`${listRowLead('active')}a  End run`);
  expect(row).toMatch(/End run {2,}recommended [|│]$/u);
  ui.unmount();
});

it('keeps the recommendation beside the consequence', async () => {
  const issue = makeRecoveryIssue({
    reason: 'review-failed',
    availableActions: ['revise', 'end-run'],
    recommendedAction: 'revise',
  });
  const ui = mount(vi.fn(), 80, issue);
  await flushEffects();
  const row = stripAnsiStyles(ui.lastFrame())
    .split('\n')
    .find((line) => line.includes('Review again'));
  expect(row).toContain(`${listRowLead('active')}v  Review again  sends your note to the reviewer`);
  expect(row).toMatch(/reviewer {2,}recommended [|│]$/u);
  ui.unmount();
});

it('offers the correction key only on a halt that takes typed words', async () => {
  const accepting = mount(vi.fn());
  await flushEffects();
  expect(stripAnsiStyles(accepting.lastFrame())).toContain(
    '↑↓ select · ⏎ confirm · tab type a correction',
  );
  accepting.unmount();

  composerLiveStore.setDraft(createDraftDocument('focus on the error'));
  const acceptingWithWords = mount(vi.fn());
  await flushEffects();
  expect(stripAnsiStyles(acceptingWithWords.lastFrame())).toContain(
    '↑↓ select · ⏎ confirm · tab type a correction',
  );
  acceptingWithWords.unmount();
  composerLiveStore.reset();

  const refusing = mount(
    vi.fn(),
    80,
    makeRecoveryIssue({
      reason: 'dependency-blocked',
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    }),
  );
  await flushEffects();
  const frame = stripAnsiStyles(refusing.lastFrame());
  expect(frame).toContain('↑↓ select · ⏎ confirm');
  expect(frame).not.toContain('tab type a correction');
  refusing.unmount();
});

it('offers tab edit the words on an apply-partial halt with words, and no tab hint when empty', async () => {
  composerLiveStore.setDraft(createDraftDocument('keep going'));
  const withWords = mount(
    vi.fn(),
    56,
    makeRecoveryIssue({
      reason: 'apply-partial',
      availableActions: ['retry-same-worker', 'restore-backup', 'end-run'],
      recommendedAction: 'retry-same-worker',
    }),
  );
  await flushEffects();
  expect(stripAnsiStyles(withWords.lastFrame())).toContain('tab edit the words');
  withWords.unmount();

  composerLiveStore.reset();
  const empty = mount(
    vi.fn(),
    56,
    makeRecoveryIssue({
      reason: 'apply-partial',
      availableActions: ['retry-same-worker', 'restore-backup', 'end-run'],
      recommendedAction: 'retry-same-worker',
    }),
  );
  await flushEffects();
  const frame = stripAnsiStyles(empty.lastFrame());
  expect(frame).toContain('↑↓ select · ⏎ confirm');
  expect(frame).not.toContain('tab');
  empty.unmount();
});

it('says what ⏎ in the composer does while it holds focus, and lists no live keys', async () => {
  const ui = renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue({
        reason: 'retry-exhausted',
        availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
        recommendedAction: 'retry-same-worker',
      })}
      width={80}
      clampedBoxRows={14}
      focused={false}
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  expect(frame).toContain('⏎ Try again with the typed correction · tab back to the actions');
  expect(frame).not.toContain('↑↓ select');
  ui.unmount();
});

it.each<[string, Partial<RecoveryIssue>, string]>([
  [
    'a failed review',
    {
      reason: 'review-failed',
      phase: 'final-review',
      availableActions: ['revise', 'accept-as-is', 'end-run'],
      recommendedAction: 'revise',
    },
    'Review again',
  ],
  ['a PLAN halt on a brief', { seat: 'plan', phase: 'escalating' }, 'Try again'],
  ['a REVIEW halt on a brief', { seat: 'review', phase: 'implementing' }, 'Try again'],
  ['a BUILD halt', { seat: 'build', phase: 'implementing' }, 'Try again'],
  ['a brief that ran out of attempts', {}, 'Try again'],
])(
  'names the action without its consequence while the composer holds focus after %s',
  async (_label, overrides, action) => {
    const ui = renderFeature(
      <RecoveryMenu
        issue={makeRecoveryIssue(overrides)}
        width={120}
        clampedBoxRows={14}
        focused={false}
        onFocusChange={() => {}}
        onResolve={() => {}}
      />,
    );
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain(`⏎ ${action} with the typed correction · tab back to the actions`);
    ui.unmount();
  },
);

it('says ⏎ runs the command when the composer holds a slash command', async () => {
  composerLiveStore.setDraft(createDraftDocument('/scroll top'));
  const ui = renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue()}
      width={80}
      clampedBoxRows={14}
      focused={false}
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  expect(frame).toContain('⏎ runs the command · tab back to the actions');
  expect(frame).not.toContain('typed correction');
  ui.unmount();
});

it('offers a typed correction on a halt whose Try again takes it', async () => {
  const ui = mount(
    vi.fn(),
    80,
    makeRecoveryIssue({
      reason: 'retry-exhausted',
      availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
    }),
  );
  await flushEffects();
  expect(stripAnsiStyles(ui.lastFrame())).toContain(
    '↑↓ select · ⏎ confirm · tab type a correction',
  );
  ui.unmount();
});

it('says only where typing goes when the halt takes no note and the composer holds focus', async () => {
  const ui = renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue({
        reason: 'dependency-blocked',
        availableActions: ['skip-current-task', 'end-run'],
        recommendedAction: 'skip-current-task',
      })}
      width={80}
      clampedBoxRows={14}
      focused={false}
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  expect(stripAnsiStyles(ui.lastFrame())).toContain(
    'typing goes to the composer · tab back to the actions',
  );
  ui.unmount();
});

it.each([
  ['validation-failed', 'Needs you', 'PLAN', 'planner'],
  ['seat-protocol-error', 'Seat down', 'BUILD', 'implementer'],
] as const)(
  'paints the %s halt and keeps seat words in its explanation in the prose tone',
  (reason, label, seat, tone) => {
    const colorLevel = chalk.level;
    chalk.level = 3;
    const ui = mount(
      vi.fn(),
      100,
      makeRecoveryIssue({
        reason,
        seat: tone === 'planner' ? 'plan' : 'build',
        message: `${seat} needs repair`,
      }),
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.warning, label).replace('\u001b[39m', ''));
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.text, `${seat} needs repair`).replace('\u001b[39m', ''),
    );
    ui.unmount();
    chalk.level = colorLevel;
  },
);

it.each([true, false])(
  'keeps the seat and consequence tones on a selected=%s action',
  (focused) => {
    const colorLevel = chalk.level;
    chalk.level = 3;
    const ui = renderFeature(
      <RecoveryMenu
        issue={makeRecoveryIssue({
          seat: 'build',
          availableActions: ['switch-seat', 'end-run'],
          recommendedAction: 'switch-seat',
        })}
        width={100}
        clampedBoxRows={14}
        focused={focused}
        onFocusChange={() => {}}
        onResolve={() => {}}
      />,
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.implementer, 'BUILD').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(focused ? defaultTheme.accent : defaultTheme.text, 'Change ').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.textDim, '  restarts this brief').replace('\u001b[39m', ''),
    );
    ui.unmount();
    chalk.level = colorLevel;
  },
);

it('keeps the key and recommendation inside a narrow row and wraps the consequence', () => {
  const colorLevel = chalk.level;
  chalk.level = 3;
  const ui = mount(
    vi.fn(),
    30,
    makeRecoveryIssue({
      seat: 'build',
      availableActions: ['switch-seat'],
      recommendedAction: 'switch-seat',
    }),
  );
  const line = stripAnsiStyles(ui.lastFrame())
    .split('\n')
    .find((line) => line.includes('Change'));
  expect(line).toContain('w  Change …  recommended');
  expect(getTerminalCellWidth(line ?? '')).toBe(30);
  expect(stripAnsiStyles(ui.lastFrame())).toContain('restarts this brief');
  ui.unmount();
  chalk.level = colorLevel;
});

it('marks the halt text an 80x24 panel cuts and keeps every action and the legend', async () => {
  // The whole middle of an 80x24 workflow screen: the most rows the panel can take.
  const panelRowsAt80x24 = 16;
  const ui = renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue({
        message: 'T901 failed after 4 attempts',
        details: [
          "Last error: src/features/workflow/display/activity.ts(42,18): error TS2339: Property 'stop' does not exist on type 'Projection'.",
          'Attempts: 4',
          `Implementer said: ${'activity.ts reads projection.stop, but Projection has no stop field. '.repeat(4)}I changed nothing.`,
        ],
      })}
      width={getChromeContentWidth(80)}
      clampedBoxRows={panelRowsAt80x24}
      focused
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const rows = stripAnsiStyles(ui.lastFrame()).split('\n');
  const separator = rows.findIndex((row) => row.includes('──────'));
  expect(rows).toHaveLength(panelRowsAt80x24);
  const isBlank = (row: string | undefined) => /^[│|] +[│|]$/.test(row ?? '');
  const mark = rows.findIndex((row) => /^[│|] {3}… \d+ more lines +[│|]$/.test(row));
  expect(mark).toBeGreaterThan(0);
  expect(mark).toBeLessThan(separator);
  expect(isBlank(rows[mark - 1])).toBe(false);
  expect(rows.slice(mark + 1, separator).every(isBlank)).toBe(true);
  expect(rows.some((row) => row.includes('Try again'))).toBe(true);
  expect(rows.some((row) => row.includes('End run'))).toBe(true);
  expect(rows.at(-2)).toContain('↑↓ select · ⏎ confirm');
  ui.unmount();
});

it.each([
  ['Question: Which file holds the locales?', 'Attempts: 1'],
  ['Planner said: No locale service exists in this repository.', 'Attempts: 2'],
])(
  'keeps %s after the task and the divider on a panel that reaches it',
  async (asked, attempts) => {
    const ui = renderFeature(
      <RecoveryMenu
        issue={makeRecoveryIssue({ details: [asked, 'Last error: blocked', attempts] })}
        width={getChromeContentWidth(120)}
        clampedBoxRows={panelBoxRows(40)}
        focused
        onFocusChange={() => {}}
        onResolve={() => {}}
      />,
    );
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame.indexOf('Task T001')).toBeGreaterThan(-1);
    expect(frame.indexOf('Task T001')).toBeLessThan(frame.indexOf('Files src/auth/session.ts'));
    expect(frame.indexOf('Files src/auth/session.ts')).toBeLessThan(frame.indexOf(asked));
    expect(frame.indexOf(asked)).toBeLessThan(frame.indexOf('Last error: blocked'));
    expect(frame).toContain('──────');
    ui.unmount();
  },
);

it("gives the divider's row to the whole question at 80 columns", async () => {
  const ui = renderFeature(
    <RecoveryMenu
      issue={askedIssue(`Question: ${LONG_ASKED_TEXT}`, FOUR_ACTIONS, 'retry-same-worker')}
      width={getChromeContentWidth(80)}
      clampedBoxRows={panelBoxRows(24)}
      focused
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const rows = frameRows(ui);
  const question = rows.findIndex((row) => row.includes('Question: greet.ts needs'));
  const task = rows.findIndex((row) => row.includes('Task T001'));
  expect(question).toBeGreaterThan(-1);
  expect(task - question).toBe(5);
  expect(rows.some((row) => row.includes('──────'))).toBe(false);
  expect(rows.filter((row) => /^[│|] [▌|]? +[rdsa] {2}/.test(row))).toHaveLength(4);
  ui.unmount();
});

it('shows the whole question at 80 columns, and the rows after it give way', async () => {
  const asked = `Question: ${LONG_ASKED_TEXT}`;
  const ui = renderFeature(
    <RecoveryMenu
      issue={askedIssue(asked, FOUR_ACTIONS, 'retry-same-worker')}
      width={getChromeContentWidth(80)}
      clampedBoxRows={panelBoxRows(24)}
      focused
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const rows = frameRows(ui);
  expect(panelText(rows)).toContain(asked);
  expect(rows.some((row) => row.includes('Task T001'))).toBe(true);
  expect(rows.some((row) => /… \d+ more lines/.test(row))).toBe(true);
  expect(rows.some((row) => row.includes('Attempts: 2'))).toBe(false);
  ui.unmount();
});

const LONG_PLANNER_REASON = `The type test needs a decision on what alpha exports. ${'word '.repeat(70)}alpha-reason-end`;

it('wraps the whole planner reason of a review stuck halt at 80x24', async () => {
  const ui = renderFeature(
    <RecoveryMenu
      issue={buildReviewFailedRecoveryIssue({
        createdAt: '2026-09-24T00:00:00.000Z',
        phase: 'implementing',
        blocking: 1,
        noProgress: ['F1'],
        fixCycle: 2,
        cannot: LONG_PLANNER_REASON,
        scope: 'task',
        afterTaskId: taskId('T004'),
      })}
      width={getChromeContentWidth(80)}
      clampedBoxRows={panelBoxRows(24)}
      focused
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const rows = frameRows(ui);
  expect(panelText(rows)).toContain(`Planner said: ${LONG_PLANNER_REASON}`);
  expect(rows.some((row) => row.includes('…'))).toBe(false);
  ui.unmount();
});

it('cuts a question taller than the panel with … and keeps the action rows and the mark', async () => {
  const asked = `Question: ${LONG_ASKED_TEXT}`;
  const issue = askedIssue(asked, FOUR_ACTIONS, 'retry-same-worker');
  const ui = renderFeature(
    <RecoveryMenu
      issue={issue}
      width={getChromeContentWidth(60)}
      clampedBoxRows={panelBoxRows(18)}
      focused
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const rows = frameRows(ui);
  const headline = rows.findIndex((row) => row.includes('Needs you'));
  expect(headline, rows.join('\n')).toBeGreaterThan(-1);
  expect(rows).toHaveLength(panelBoxRows(18));
  expect(rows[headline + 1], rows.join('\n')).toContain('Question: greet.ts needs');
  expect(rows[headline + 1], rows.join('\n')).toContain('…');
  expect(compact(asked).startsWith(compact(shownQuestion(rows)))).toBe(true);
  expect(shownQuestion(rows).length).toBeGreaterThan(40);
  expect(rows[headline + 2], rows.join('\n')).toMatch(/… \d+ more lines/);
  for (const action of FOUR_ACTIONS) expect(actionShown(rows, issue, action)).toBe(true);
  expect(rows.some((row) => row.includes('↑↓ select · ⏎ confirm'))).toBe(true);
  ui.unmount();
});

it('gives the blank row to a cut reason at 60x18', async () => {
  // The reason is the panel's only fact, so its cut rows take the blank row under the headline.
  const issue = makeRecoveryIssue({
    taskId: undefined,
    taskTitle: undefined,
    files: [],
    affectedTaskIds: [],
    details: [`Planner said: ${LONG_PLANNER_REASON}`],
    availableActions: THREE_ACTIONS,
    recommendedAction: 'retry-same-worker',
  });
  const ui = mountBox(issue, panelBoxRows(18));
  await flushEffects();
  const rows = frameRows(ui);
  const headline = rows.findIndex((row) => row.includes('Needs you'));
  expect(headline, rows.join('\n')).toBeGreaterThan(-1);
  const reason = rows
    .slice(headline + 1, headline + 4)
    .map((row) => row.replace(/[│|]/gu, '').trim());
  expect(reason, rows.join('\n')).toHaveLength(3);
  for (const reasonRow of reason) expect(reasonRow, rows.join('\n')).not.toBe('');
  expect(reason[0]).toContain('Planner said: The type test');
  expect(reason[2]).toContain('…');
  ui.unmount();
});

it('redacts a key in the asked row before it cuts the row on a short panel', async () => {
  const key = `sk-ant-api03-${'abcdEFGH1234'.repeat(5)}`;
  const ui = renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue({
        details: [
          `Question: use ${'x'.repeat(25)} ${key} here`,
          'Last error: blocked',
          'Attempts: 2',
        ],
      })}
      width={getChromeContentWidth(60)}
      clampedBoxRows={panelBoxRows(18)}
      focused
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  expect(frame).toContain('Question: use');
  expect(frame).not.toContain('sk-ant-api');
  ui.unmount();
});

const BLOCKED_ERROR = 'Last error: blocked';
const DOUBLE_QUOTE = 'Last error: cannot find module "./foo"';
const SINGLE_QUOTE = "Last error: no property 'stop' on 'Projection'";
const PLANNER_QUOTE = 'Planner said: cannot find module "./foo"';

it.each([
  ['Authorization: Bearer abcDEF123456789012345', 15, BLOCKED_ERROR],
  ['"password": "hunter2hunter2hunter2"', 15, BLOCKED_ERROR],
  ['"password": "hunter2hunter2hunter2"', 20, BLOCKED_ERROR],
  ['password: please rotate it', 28, BLOCKED_ERROR],
  ['OPENAI_API_KEY=abcdefghijklmnop', 10, BLOCKED_ERROR],
  ['OPENAI_API_KEY=abcdefghijklmnop', 14, BLOCKED_ERROR],
  ['"token": "abcdefgh hijk"', 20, DOUBLE_QUOTE],
  ["'api_token': 'abc'", 15, SINGLE_QUOTE],
  ['"token": "abcdefgh hijk"', 20, PLANNER_QUOTE],
])(
  'keeps a cut question on a short panel when the panel masks %s at filler %i above %s',
  async (value, filler, below) => {
    const words = 'Should we keep this? '.repeat(2).slice(0, filler);
    const ui = mountBox(
      makeRecoveryIssue({
        details: [`Question: ${words}${value} ${'then more words '.repeat(10)}`, below],
        availableActions: FOUR_ACTIONS,
        recommendedAction: 'retry-same-worker',
      }),
      panelBoxRows(18),
    );
    await flushEffects();
    const rows = frameRows(ui);
    expect(rows.find((row) => row.includes('Question: ')) ?? '', rows.join('\n')).toContain('…');
    expect(rows.join('\n')).not.toContain('hunter2');
    ui.unmount();
  },
);

const LONG_QUOTED_ERROR = `Last error: cannot find module "./foo" ${'and the build stopped with more words here '.repeat(4)}`;

it.each([
  [
    'a question that fits',
    'Question: Should "password": "please rotate it now',
    18,
    'please rotate',
  ],
  [
    'a Planner said row',
    'Planner said: the brief stops at password: "x and I cannot read it',
    20,
    'x and I',
  ],
  [
    'a question cut past its first row',
    `Question: "password": "please rotate ${'then more words '.repeat(14)}`,
    20,
    'please rotate',
  ],
])(
  'keeps %s on a short panel when its open quote pairs with a long row below',
  async (_label, asked, terminalRows, shown) => {
    const ui = mountBox(
      makeRecoveryIssue({
        details: [asked, LONG_QUOTED_ERROR, 'Attempts: 2'],
        availableActions: FOUR_ACTIONS,
        recommendedAction: 'retry-same-worker',
      }),
      panelBoxRows(terminalRows),
    );
    await flushEffects();
    const rows = frameRows(ui);
    const label = asked.slice(0, asked.indexOf(':') + 2);
    expect(rows.find((row) => row.includes(label)) ?? '', rows.join('\n')).toContain(shown);
    ui.unmount();
  },
);

it.each([
  ['a review headline', 18, 'no locale service exists', 'R1: cannot find module "./foo"'],
  ['a review headline', 40, 'no locale service exists', 'R1: cannot find module "./foo"'],
  ['a review headline', 40, 'no "locale" service exists', 'R1: blocked'],
])(
  'keeps Planner said on a panel from %s of %i terminal rows with an open quote',
  async (_label, terminalRows, cannot, below) => {
    const ui = mountBox(
      buildReviewFailedRecoveryIssue({
        createdAt: '2026-09-24T00:00:00.000Z',
        blocking: 1,
        noProgress: ['password: "x and more'],
        cannot,
        details: [below],
      }),
      panelBoxRows(terminalRows),
    );
    await flushEffects();
    const rows = frameRows(ui);
    expect(rows.join('\n')).toContain(`Planner said: ${cannot}`);
    expect(rows.join('\n')).not.toContain('x and more');
    ui.unmount();
  },
);

it.each([
  ['a task title', { taskTitle: 'Rotate password: "x and more' }, 'Files src/auth/session.ts'],
  ['a file name', { files: ['password: "x y.ts'] }, 'Task T001'],
])('keeps the question on a tall panel below %s with an open quote', async (_label, patch, row) => {
  const ui = mountBox(
    makeRecoveryIssue({
      ...patch,
      details: ['Question: which file holds the locales?', LONG_QUOTED_ERROR],
      availableActions: FOUR_ACTIONS,
      recommendedAction: 'retry-same-worker',
    }),
    panelBoxRows(40),
  );
  await flushEffects();
  const frame = frameRows(ui).join('\n');
  expect(frame).toContain('Question: which file holds the locales?');
  expect(frame).toContain(row);
  ui.unmount();
});

it('keeps the row below a question with an open quote on a tall panel', async () => {
  const ui = mountBox(
    makeRecoveryIssue({
      details: ['Question: which password: "x goes first?', LONG_QUOTED_ERROR],
      availableActions: FOUR_ACTIONS,
      recommendedAction: 'retry-same-worker',
    }),
    panelBoxRows(40),
  );
  await flushEffects();
  const frame = frameRows(ui).join('\n');
  expect(frame).toContain('Question: which password: "x goes first?');
  expect(frame).toContain('Last error: cannot find module "./foo"');
  ui.unmount();
});

function panelBoxRows(terminalRows: number): number {
  // A one-line composer takes three rows; the panel takes every row the screen chrome leaves.
  return clampWorkflowPromptRows({
    rows: terminalRows,
    inputRows: 3,
    feedbackRows: 1,
    promptRows: Number.MAX_SAFE_INTEGER,
  });
}

async function mountPanel(issue: RecoveryIssue, terminalRows: number, terminalCols = 140) {
  const ui = renderFeature(
    <RecoveryMenu
      issue={issue}
      width={getChromeContentWidth(terminalCols)}
      clampedBoxRows={panelBoxRows(terminalRows)}
      focused
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  return ui;
}

function frameRows(ui: ReturnType<typeof renderFeature>): string[] {
  return stripAnsiStyles(ui.lastFrame()).split('\n');
}

it('says what Accept as is and Decide for me do on a failed review the planner cannot fix, whole at 60x18', async () => {
  const issue = buildReviewFailedRecoveryIssue({
    createdAt: '2026-09-24T00:00:00.000Z',
    blocking: 1,
    noProgress: ['V1'],
    cannot: 'The two specs pin the old signup rules.',
    acceptAsIs: true,
  });
  const ui = await mountPanel(issue, 18, 60);
  const rows = frameRows(ui);
  const review = rows.findIndex((line) => line.includes('v  Review again'));
  expect(rows[review]).toMatch(/Review again {2,}sends your note to {2,}recommended/);
  expect(rows[review + 1]?.indexOf('the reviewer')).toBe(rows[review]?.indexOf('sends your'));
  expect(rows.join('\n')).toMatch(/k {2}Accept as is {2,}records the blockers/);
  expect(rows.join('\n')).toMatch(/d {2}Decide for me {2,}closes this run/);
  expect(rows.join('\n')).toContain('a  End run');
  ui.unmount();
});

/** The panel's words with its border and indent gone, one space between rows. */
function panelText(rows: readonly string[]): string {
  return rows.map((row) => row.replace(/^[│|] */, '').replace(/ *[│|]$/, '')).join(' ');
}

/** The question as the panel shows it, up to the `…` that cuts it or the task row after it. */
function shownQuestion(rows: readonly string[]): string {
  const text = panelText(rows);
  return text.slice(text.indexOf('Question: ')).split(/…|Task T001/)[0] ?? '';
}

function compact(text: string): string {
  return text.replace(/\s/g, '');
}

function actionShown(rows: readonly string[], issue: RecoveryIssue, action: RecoveryAction) {
  const label = recoveryMenuRow(action, issue, false, false).name.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const row = new RegExp(`\\b${recoveryActionKey(action)}\\s+${label}`);
  return rows.some((text) => row.test(text));
}

/** Every action the list hides sits behind a `↑ more` or `↓ more` mark on its side. */
function expectHiddenActionsMarked(rows: readonly string[], issue: RecoveryIssue): void {
  const shown = getRecoveryPromptActions(issue).map((action) => actionShown(rows, issue, action));
  const first = shown.indexOf(true);
  expect(first, rows.join('\n')).toBeGreaterThanOrEqual(0);
  if (first > 0)
    expect(
      rows.some((row) => row.includes('↑ more')),
      rows.join('\n'),
    ).toBe(true);
  if (shown.lastIndexOf(true) < shown.length - 1) {
    expect(
      rows.some((row) => row.includes('↓ more')),
      rows.join('\n'),
    ).toBe(true);
  }
}

const LONG_ASKED_TEXT = `${'greet.ts needs a locale table, but the brief names no locale source. '.repeat(4)}Which file?`;
const FOUR_ACTIONS: RecoveryAction[] = [
  'retry-same-worker',
  'decide-for-me',
  'skip-current-task',
  'end-run',
];
const THREE_ACTIONS: RecoveryAction[] = ['retry-same-worker', 'skip-current-task', 'end-run'];

function askedIssue(asked: string, actions: RecoveryAction[], recommended: RecoveryAction) {
  return makeRecoveryIssue({
    details: [asked, 'Last error: blocked', 'Attempts: 2'],
    availableActions: actions,
    recommendedAction: recommended,
  });
}

function mountBox(
  issue: RecoveryIssue,
  box: number,
  onResolve: (answer: string) => void = () => {},
) {
  return renderFeature(
    <RecoveryMenu
      issue={issue}
      width={getChromeContentWidth(60)}
      clampedBoxRows={box}
      focused
      onFocusChange={() => {}}
      onResolve={onResolve}
    />,
  );
}

const FAILED_REVIEW_HALT = makeRecoveryIssue({
  reason: 'review-failed',
  taskId: undefined,
  availableActions: ['revise', 'end-run'],
  recommendedAction: 'revise',
});

it('offers no typed correction on a failed review whose step reads no words', async () => {
  runViewStore.__testReset({
    halt: { issue: FAILED_REVIEW_HALT, at: { kind: 'apply' } },
    reviewNone: true,
  });
  const ui = mountBox(FAILED_REVIEW_HALT, 12);
  await flushEffects();
  const panel = frameRows(ui).join('\n');
  ui.unmount();
  expect(panel).toContain('Continue');
  expect(panel).not.toContain('Review again');
  expect(panel).not.toContain('type a correction');
  expect(panel).not.toContain('sends your note to the reviewer');
});

it('keeps the typed correction under REVIEW None when the next brief reads it', async () => {
  runViewStore.__testReset({
    halt: {
      issue: FAILED_REVIEW_HALT,
      at: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    },
    reviewNone: true,
  });
  const ui = mountBox(FAILED_REVIEW_HALT, 12);
  await flushEffects();
  const panel = frameRows(ui).join('\n');
  ui.unmount();
  expect(panel).toContain('type a correction');
  expect(panel).toContain('Continue');
  expect(panel).not.toContain('Review again');
  expect(panel).not.toContain('sends your note to the reviewer');
});

it('names Continue in the typed-correction legend under REVIEW None', async () => {
  runViewStore.__testReset({
    halt: {
      issue: FAILED_REVIEW_HALT,
      at: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    },
    reviewNone: true,
  });
  const ui = renderFeature(
    <RecoveryMenu
      issue={FAILED_REVIEW_HALT}
      width={80}
      clampedBoxRows={14}
      focused={false}
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  ui.unmount();
  expect(frame).toContain('⏎ Continue with the typed correction');
  expect(frame).not.toContain('Review again');
});

it.each([
  ['Question: ', 10, FOUR_ACTIONS],
  ['Planner said: ', 10, FOUR_ACTIONS],
  ['Question: ', 9, THREE_ACTIONS],
  ['Planner said: ', 9, THREE_ACTIONS],
] as const)(
  'keeps %s on a panel of %i rows with no divider once every action has its row, and marks the rest',
  async (label, box, actions) => {
    const issue = askedIssue(`${label}${LONG_ASKED_TEXT}`, [...actions], 'retry-same-worker');
    const ui = mountBox(issue, box);
    await flushEffects();
    const rows = frameRows(ui);
    expect(rows).toHaveLength(box);
    const asked = rows.findIndex((row) => row.includes(label));
    const mark = rows.findIndex((row) => row.includes('… 4 more lines'));
    expect(asked, rows.join('\n')).toBe(2);
    expect(rows[asked], rows.join('\n')).toContain('…');
    expect(mark, rows.join('\n')).toBe(3);
    expect(rows.some((row) => row.includes('──────'))).toBe(false);
    expect(rows.at(-2)).toContain('↑↓ select · ⏎ confirm');
    for (const action of actions)
      expect(actionShown(rows, issue, action), rows.join('\n')).toBe(true);
    ui.unmount();
  },
);

it.each([
  ['Question: ', 4, 8],
  ['Question: ', 4, 9],
  ['Planner said: ', 4, 8],
  ['Planner said: ', 4, 9],
  ['Question: ', 3, 8],
] as const)(
  'keeps %s and each of %i actions on a panel of %i rows that gives up its border for them',
  async (label, count, box) => {
    const actions = count === 4 ? FOUR_ACTIONS : THREE_ACTIONS;
    const issue = askedIssue(`${label}${LONG_ASKED_TEXT}`, actions, 'retry-same-worker');
    const ui = mountBox(issue, box);
    await flushEffects();
    const rows = frameRows(ui);

    expect(rows).toHaveLength(box);
    expect(
      rows.some((row) => row.includes(label)),
      rows.join('\n'),
    ).toBe(true);
    for (const action of actions)
      expect(actionShown(rows, issue, action), rows.join('\n')).toBe(true);
    expect(
      rows.some((row) => /^[│|┌└╭╰+]/.test(row)),
      rows.join('\n'),
    ).toBe(false);
    expect(
      rows.some((row) => /[↑↓] more/.test(row)),
      rows.join('\n'),
    ).toBe(false);
    expect(rows.at(-1)).toContain('↑↓ select · ⏎ confirm');
    ui.unmount();
  },
);

it.each([
  ['retry-same-worker', 10],
  ['skip-current-task', 10],
  ['end-run', 10],
  ['retry-same-worker', 9],
  ['skip-current-task', 9],
  ['end-run', 9],
  ['retry-same-worker', 8],
  ['skip-current-task', 8],
  ['end-run', 8],
] as const)(
  'walks every action from %s on a panel of %i rows that keeps the asked row',
  async (recommended, box) => {
    const issue = askedIssue(`Question: ${LONG_ASKED_TEXT}`, FOUR_ACTIONS, recommended);
    const answers: string[] = [];
    const ui = mountBox(issue, box, (answer) => answers.push(answer));
    await flushEffects();
    const start = FOUR_ACTIONS.indexOf(recommended);
    // The cursor row opens on the border of a framed panel and on the padding of a bare one.
    const cursor = () => frameRows(ui).filter((row) => /^[│| ] [▌|] /.test(row));
    expect(frameRows(ui).some((row) => row.includes('Question: '))).toBe(true);
    for (let step = 1; step <= FOUR_ACTIONS.length; step += 1) {
      ui.stdin.write('\u001b[B');
      await flushEffects();
      const action = FOUR_ACTIONS[(start + step) % FOUR_ACTIONS.length];
      if (action === undefined) throw new Error('no action');
      expect(cursor()).toHaveLength(1);
      expect(cursor()[0]).toContain(` ${recoveryActionKey(action)}  `);
    }
    ui.stdin.write('\r');
    await flushEffects();
    expect(answers).toEqual([recoveryActionKey(recommended)]);
    ui.unmount();
  },
);

it.each([
  ['a path wider than a row', `Question: Read ${'src/feature/'.repeat(30)}greet.ts or the brief?`],
  ['a first word that fills a row', `Question: ${'x'.repeat(66)} holds ${LONG_ASKED_TEXT}`],
])('keeps a question that starts with %s in reading order', async (_label, asked) => {
  const issue = askedIssue(asked, FOUR_ACTIONS, 'retry-same-worker');
  const ui = renderFeature(
    <RecoveryMenu
      issue={issue}
      width={getChromeContentWidth(80)}
      clampedBoxRows={panelBoxRows(24)}
      focused
      onFocusChange={() => {}}
      onResolve={() => {}}
    />,
  );
  await flushEffects();
  const rows = frameRows(ui);
  expect(compact(shownQuestion(rows)).length).toBeGreaterThan(5 * 60);
  expect(compact(asked).startsWith(compact(shownQuestion(rows)))).toBe(true);
  ui.unmount();
});

it('names the changes End run keeps once a brief finished', async () => {
  const issue = askedIssue('Question: Which file?', FOUR_ACTIONS, 'retry-same-worker');
  const row = async () => {
    const ui = mountBox(issue, 14);
    await flushEffects();
    const end = frameRows(ui).find((text) => text.includes('End run'));
    ui.unmount();
    return end;
  };
  expect(await row()).not.toContain('keeps its changes');
  runViewStore.__testReset({
    briefs: { tasks: [{ id: 'T001', title: 'Done first', status: 'done' }] },
  });
  expect(await row()).toMatch(/End run {2,}closes this run, keeps its changes/);
});

it('leaves a 7-row panel on the headline that carries the cut mark', async () => {
  // The actions take every row but the headline's at this height, so the headline carries the mark
  // that names every fact.
  const issue = askedIssue(`Question: ${LONG_ASKED_TEXT}`, FOUR_ACTIONS, 'retry-same-worker');
  const ui = mountBox(issue, 7);
  await flushEffects();
  const rows = frameRows(ui);
  expect(rows.some((row) => row.includes('Question: '))).toBe(false);
  expect(rows[1]).toContain('T001 failed');
  expect(rows[1]).toMatch(/… \d+ more lines/);
  expect(rows.some((row) => row.includes('↓ more'))).toBe(true);
  ui.unmount();
});

function retryExhaustedIssue() {
  return makeRecoveryIssue({
    reason: 'retry-exhausted',
    taskId: taskId('T901'),
    message: 'T901 failed',
    details: [
      'Last error: blocked: Which locale table does greet.ts read?',
      'Attempts: 5',
      'Implementer said: I could not find the locale table greet.ts reads.',
    ],
    availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
    recommendedAction: 'retry-same-worker',
  });
}

it.each([12, 13, 14, 15, 16])(
  'keeps the headline, the cut mark, the recommended action, the hidden-action marks and the legend at 140x%s',
  async (terminalRows) => {
    const issue = retryExhaustedIssue();
    const ui = await mountPanel(issue, terminalRows);
    const rows = frameRows(ui);
    expect(rows).toHaveLength(panelBoxRows(terminalRows));
    expect(rows.some((row) => row.includes('T901 failed'))).toBe(true);
    expect(rows.some((row) => /… \d+ more lines/.test(row))).toBe(true);
    expect(rows.some((row) => /Try again {2,}recommended/.test(row))).toBe(true);
    expectHiddenActionsMarked(rows, issue);
    expect(rows.some((row) => row.includes('↑↓ select · ⏎ confirm'))).toBe(true);
    ui.unmount();
  },
);

it.each([12, 13, 14, 15, 16])(
  'keeps the selected action and marks every hidden action after one ↓ press at 140x%s',
  async (terminalRows) => {
    const issue = retryExhaustedIssue();
    const ui = await mountPanel(issue, terminalRows);
    ui.stdin.write('\u001b[B');
    await flushEffects();
    const rows = frameRows(ui);
    expect(rows).toHaveLength(panelBoxRows(terminalRows));
    expect(actionShown(rows, issue, 'skip-current-task'), rows.join('\n')).toBe(true);
    expectHiddenActionsMarked(rows, issue);
    expect(rows.some((row) => row.includes('↑↓ select · ⏎ confirm'))).toBe(true);
    ui.unmount();
  },
);

it.each([12, 13, 14, 15, 16])(
  'marks both sides around a recommended action in the middle of the list at 140x%s',
  async (terminalRows) => {
    const issue = { ...seatSwapIssue(), details: ['Resets 17:00', 'Attempts: 3', 'Tool: claude'] };
    const ui = await mountPanel(issue, terminalRows);
    const rows = frameRows(ui);
    expect(rows).toHaveLength(panelBoxRows(terminalRows));
    expect(rows.some((row) => row.includes('Seat down'))).toBe(true);
    expect(rows.some((row) => /… \d+ more lines/.test(row))).toBe(true);
    expect(actionShown(rows, issue, 'switch-seat'), rows.join('\n')).toBe(true);
    expect(rows.some((row) => row.includes('recommended'))).toBe(true);
    expectHiddenActionsMarked(rows, issue);
    expect(rows.some((row) => row.includes('↑↓ select · ⏎ confirm'))).toBe(true);
    ui.unmount();
  },
);

it.each([12, 14])('counts one cut line in the singular at 140x%s', async (terminalRows) => {
  const issue = makeRecoveryIssue({
    reason: 'seat-protocol-error',
    seat: 'plan',
    message: 'The planner answered twice without matching its contract',
    details: ['result.tasks: Required'],
    availableActions: ['retry-same-worker', 'end-run'],
    recommendedAction: 'retry-same-worker',
    files: [],
    affectedTaskIds: [],
    taskId: undefined,
    taskTitle: undefined,
  });
  const ui = await mountPanel(issue, terminalRows);
  const frame = frameRows(ui).join('\n');
  expect(frame).toContain('… 1 more line');
  expect(frame).not.toContain('1 more lines');
  ui.unmount();
});

const CORRECTION_GOES_AGAIN = 'Your plan correction goes again with this step.';

function correctedPlanHalt() {
  return makeRecoveryIssue({
    reason: 'planner-call-failed',
    seat: 'plan',
    phase: 'planning',
    message: 'Planning failed: output token limit reached',
    details: [
      'OpenAI Codex CLI reported: Incomplete response returned, reason: max_output_tokens',
      'A retry can run as long and stop at the same limit. Type a correction that asks for a shorter answer, or change the tool.',
      CORRECTION_GOES_AGAIN,
    ],
    availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
    recommendedAction: 'switch-seat',
    switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
    files: [],
    affectedTaskIds: [],
    taskId: undefined,
    taskTitle: undefined,
  });
}

it.each([
  [60, 18],
  [80, 24],
  [120, 40],
])(
  'shows the last detail line of a planner halt whole at %ix%i',
  async (terminalCols, terminalRows) => {
    const issue = correctedPlanHalt();
    const ui = await mountPanel(issue, terminalRows, terminalCols);
    const rows = frameRows(ui);
    expect(compact(panelText(rows)), rows.join('\n')).toContain(compact(CORRECTION_GOES_AGAIN));
    expect(actionShown(rows, issue, 'switch-seat'), rows.join('\n')).toBe(true);
    expectHiddenActionsMarked(rows, issue);
    expect(rows.some((row) => row.includes('↑↓ select · ⏎ confirm'))).toBe(true);
    ui.unmount();
  },
);

it.each([
  [80, 24],
  [120, 40],
])(
  'shows each detail line of a planner halt whole at %ix%i',
  async (terminalCols, terminalRows) => {
    const issue = correctedPlanHalt();
    const ui = await mountPanel(issue, terminalRows, terminalCols);
    const shown = compact(panelText(frameRows(ui)));
    for (const detail of issue.details) expect(shown).toContain(compact(detail));
    ui.unmount();
  },
);

function questionsHalt(questions: readonly string[], correction: boolean) {
  return makeRecoveryIssue({
    reason: 'plan-questions-exhausted',
    seat: 'plan',
    phase: 'planning',
    message: 'The planner asked a third round of questions; a session takes 2.',
    details: [...questions, ...(correction ? [CORRECTION_GOES_AGAIN] : [])],
    availableActions: ['retry-same-worker', 'revise', 'end-run'],
    recommendedAction: 'revise',
    files: [],
    affectedTaskIds: [],
    taskId: undefined,
    taskTitle: undefined,
  });
}

const EIGHT_QUESTIONS = Array.from(
  { length: 8 },
  (_, at) => `Which name does part ${at + 1} take?`,
);

it('shows the plan correction line whole at 60x18 when a planner question starts with its first words', async () => {
  const issue = questionsHalt(
    [
      'Your plan correction asks for 7 commands. Do you want 7?',
      'Which registry takes the package?',
    ],
    true,
  );
  const ui = await mountPanel(issue, 18, 60);
  const rows = frameRows(ui);
  expect(compact(panelText(rows)), rows.join('\n')).toContain(compact(CORRECTION_GOES_AGAIN));
  ui.unmount();
});

it('shows each of 8 planner questions of a halt at 120x40', async () => {
  const issue = questionsHalt(EIGHT_QUESTIONS, false);
  const ui = await mountPanel(issue, 40, 120);
  const rows = frameRows(ui);
  const shown = compact(panelText(rows));
  for (const question of EIGHT_QUESTIONS)
    expect(shown, rows.join('\n')).toContain(compact(question));
  ui.unmount();
});

it.each([
  [60, 18],
  [80, 24],
])(
  'counts each hidden planner question of a halt in the cut mark at %ix%i',
  async (terminalCols, terminalRows) => {
    const issue = questionsHalt(EIGHT_QUESTIONS, false);
    const ui = await mountPanel(issue, terminalRows, terminalCols);
    const rows = frameRows(ui);
    const text = compact(panelText(rows));
    const shown = EIGHT_QUESTIONS.filter((question) => text.includes(compact(question)));
    const hidden = Number(/… (\d+) more lines?/.exec(rows.join('\n'))?.[1] ?? 0);
    expect(shown.length + hidden, rows.join('\n')).toBe(EIGHT_QUESTIONS.length);
    expect(actionShown(rows, issue, 'revise'), rows.join('\n')).toBe(true);
    expectHiddenActionsMarked(rows, issue);
    expect(rows.some((row) => row.includes('↑↓ select · ⏎ confirm'))).toBe(true);
    ui.unmount();
  },
);

it.each([
  [60, 18],
  [80, 24],
  [120, 40],
])(
  'shows the plan correction line whole under 8 planner questions at %ix%i',
  async (terminalCols, terminalRows) => {
    const issue = questionsHalt(EIGHT_QUESTIONS, true);
    const ui = await mountPanel(issue, terminalRows, terminalCols);
    const rows = frameRows(ui);
    expect(compact(panelText(rows)), rows.join('\n')).toContain(compact(CORRECTION_GOES_AGAIN));
    ui.unmount();
  },
);

async function panelAt120(issue: RecoveryIssue, terminalRows: number): Promise<string> {
  const ui = await mountPanel(issue, terminalRows, 120);
  const frame = frameRows(ui).join('\n');
  ui.unmount();
  return frame;
}

const PEM_BLOCK = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBCANARYbODY\n-----END PRIVATE KEY-----';

it('keeps every row below the asked row when one of them has an open quote', async () => {
  const frame = await panelAt120(
    makeRecoveryIssue({
      details: [
        'Question: which file holds the locales?',
        'Last error: cannot read password: "x in config',
        'Attempts: 2',
        'Implementer said: I ran "npm test" and stopped',
      ],
    }),
    40,
  );
  expect(frame).toContain('Last error: cannot read password: "x in config');
  expect(frame).toContain('Attempts: 2');
  expect(frame).toContain('Implementer said: I ran "npm test" and stopped');
  expect(frame).not.toContain('***REDACTED***');
});

it('keeps the rows of a halt with no asked row when one has an open quote', async () => {
  const frame = await panelAt120(
    makeRecoveryIssue({
      details: [
        'Last error: cannot read password: "x in config',
        'Attempts: 2',
        'Implementer said: I ran "npm test"',
      ],
    }),
    40,
  );
  expect(frame).toContain('Attempts: 2');
  expect(frame).toContain('Implementer said: I ran "npm test"');
  expect(frame).not.toContain('***REDACTED***');
});

it('keeps the title and the Files row on a short panel when the title has an open quote', async () => {
  const frame = await panelAt120(
    buildRetryExhaustedRecoveryIssue({
      id: 'rec_short_title',
      task: makeTask({
        id: 'T901',
        title: 'Rotate password: "x and the token store',
        suggestedFiles: ['src/a.ts'],
      }),
      phase: 'escalating',
      question: 'Should activity.ts read the new value from the environment?',
      validationSummary: `cannot find module "./foo" and the build stopped ${'with more words here '.repeat(4).trimEnd()}`,
      attempts: 3,
      allowRetryOverride: true,
      selectedImplementerProfile: 'default',
      createdAt: '2026-09-24T00:00:00.000Z',
    }),
    20,
  );
  expect(frame).toContain('Rotate password: "x and the token store');
  expect(frame).toContain('Files src/a.ts');
  expect(frame).not.toContain('***REDACTED***');
});

it('holds a title of 10000 characters with an open quote and a quote below', () => {
  const issue = makeRecoveryIssue({
    taskTitle: `Rotate password: "x ${'word '.repeat(2000)}`,
    details: ['Question: which file?', 'Last error: cannot find module "./foo"'],
  });
  const rows = recoveryPromptSummaryRows(issue, 108);
  expect(JSON.stringify(rows[2])).toContain('Rotate password: \\"x word word');
});

it('does not merge a row that ends on Bearer with the row below', async () => {
  const frame = await panelAt120(
    makeRecoveryIssue({ details: ['Last error: sent Authorization: Bearer', 'Attempts: 2'] }),
    40,
  );
  expect(frame).toContain('Attempts: 2');
});

it.each([
  ['a two-line title', { taskTitle: `Rotate\n${PEM_BLOCK}` }],
  [
    'a message',
    {
      reason: 'seat-protocol-error',
      seat: 'review',
      attempts: undefined,
      message: `Tool said\n${PEM_BLOCK}`,
    },
  ],
] as const)('keeps a PEM block masked in %s', async (_label, patch) => {
  const frame = await panelAt120(
    makeRecoveryIssue({
      ...patch,
      details: ['Question: which key?', 'Last error: cannot find "foo"'],
    }),
    40,
  );
  expect(frame).not.toContain('CANARY');
});

it('keeps a quoted value that spans two lines of one row masked', async () => {
  const frame = await panelAt120(
    makeRecoveryIssue({
      taskTitle: 'Rotate password: "CANARYa\nCANARYb tail" done',
      details: ['Question: which key?'],
    }),
    40,
  );
  expect(frame).not.toContain('CANARY');
});

// A word or a paste names no action, so the ⏎ after it takes no row and says how to choose one.
describe('a typed word and ⏎ through the input bridge', () => {
  const ENTER = '\r';
  const DOWN = '\u001b[B';
  const SHIFT_DOWN = '\u001b[1;2B';
  const FOCUS_BACK = Symbol('the keys come back to the menu');
  // The rows are Try again, Skip and End run; the menu opens on End run.
  const END_RUN_FIRST = makeRecoveryIssue({ recommendedAction: 'end-run' });

  async function answersOf(
    reads: ReadonlyArray<string | typeof FOCUS_BACK>,
    dependencies: FilteredStdinHarnessDependencies = {},
    boxRows = 14,
  ) {
    const answers: string[] = [];
    let focus: (focused: boolean) => void = () => {};
    function Menu() {
      const [focused, setFocused] = useState(true);
      focus = setFocused;
      return (
        <RecoveryMenu
          issue={END_RUN_FIRST}
          width={80}
          clampedBoxRows={boxRows}
          focused={focused}
          onFocusChange={setFocused}
          onResolve={(answer) => answers.push(answer)}
        />
      );
    }
    const ui = renderThroughFilteredStdin(<Menu />, undefined, dependencies);
    try {
      await ui.settled();
      for (const read of reads) {
        if (read === FOCUS_BACK) focus(true);
        else ui.pressBytes(read);
        await ui.settled();
      }
      return { answers, message: feedbackStore.get().message };
    } finally {
      ui.unmount();
    }
  }

  it.each([
    { name: 'in one read', reads: [`skip${ENTER}`] },
    { name: 'in two reads', reads: ['skip', ENTER] },
    { name: 'with skip in a bracketed paste', reads: [`${PASTE_START}skip${PASTE_END}`, ENTER] },
  ])('takes no action on skip and ⏎ $name and says how to choose one', async ({ reads }) => {
    expect(await answersOf(reads)).toEqual({ answers: [], message: UNREAD_WORDS_MESSAGE });
  });

  it('takes the highlighted action on the ⏎ after the text', async () => {
    expect((await answersOf([`skip${ENTER}`, ENTER])).answers).toEqual([
      recoveryActionKey('end-run'),
    ]);
  });

  it.each([
    { name: 'two Tab keys', read: '\t\t' },
    { name: 'two spaces', read: '  ' },
    { name: 'two Ctrl+A keys', read: '\u0001\u0001' },
  ])(
    'takes the highlighted action on ⏎ after $name in one read, with no text',
    async ({ read }) => {
      expect(await answersOf([read, ENTER])).toEqual({
        answers: [recoveryActionKey('end-run')],
        message: null,
      });
    },
  );

  it('takes the row that ↓ moved to after a word, with no text', async () => {
    expect(await answersOf(['skip', DOWN, ENTER])).toEqual({
      answers: [recoveryActionKey('retry-same-worker')],
      message: null,
    });
  });

  it('takes no action on ⏎ after a word and shift+↓, which chooses no row', async () => {
    expect(await answersOf(['skip', SHIFT_DOWN, ENTER])).toEqual({
      answers: [],
      message: UNREAD_WORDS_MESSAGE,
    });
  });

  it.each([
    { name: 'n and o', reads: ['n', 'o', ENTER] },
    { name: 'a digit', reads: ['1', ENTER] },
  ])(
    'takes no action on ⏎ after $name typed one key per read, which name no action, and says how to choose one',
    async ({ reads }) => {
      expect(await answersOf(reads)).toEqual({ answers: [], message: UNREAD_WORDS_MESSAGE });
    },
  );

  it.each([
    { name: 'a space', read: ' ' },
    { name: 'a Ctrl+A key', read: '\u0001' },
    { name: 'an Alt+n key', read: '\u001bn' },
  ])('takes the highlighted action on ⏎ after $name, with no text', async ({ read }) => {
    expect(await answersOf([read, ENTER])).toEqual({
      answers: [recoveryActionKey('end-run')],
      message: null,
    });
  });

  it('skips on S', async () => {
    expect(await answersOf(['S'])).toEqual({
      answers: [recoveryActionKey('skip-current-task')],
      message: null,
    });
  });

  it('takes no action on ⏎ after the letter of an action out of view, and says how to choose one', async () => {
    expect(await answersOf(['r', ENTER], {}, 4)).toEqual({
      answers: [],
      message: UNREAD_WORDS_MESSAGE,
    });
  });

  // On a terminal that gave no word on bracketed paste, a row letter and ⏎ of one read are the
  // same bytes as a pasted letter and its line break.
  it('takes no action on the letter of an action and ⏎ of one read on a terminal that gave no word, and says how to choose one on the next ⏎', async () => {
    expect(await answersOf([`s${ENTER}`], { terminalAnswers: false })).toEqual({
      answers: [],
      message: null,
    });
    expect(await answersOf([`s${ENTER}`, ENTER], { terminalAnswers: false })).toEqual({
      answers: [],
      message: UNREAD_WORDS_MESSAGE,
    });
  });

  it('skips on s after a word', async () => {
    expect(await answersOf(['skip', 's'])).toEqual({
      answers: [recoveryActionKey('skip-current-task')],
      message: null,
    });
  });

  it('takes the highlighted action on ⏎ after a word, Tab and the keys back, with no text', async () => {
    expect(await answersOf(['skip', '\t', FOCUS_BACK, ENTER])).toEqual({
      answers: [recoveryActionKey('end-run')],
      message: null,
    });
  });
});
