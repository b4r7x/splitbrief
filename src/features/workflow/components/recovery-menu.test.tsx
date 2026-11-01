import chalk from 'chalk';
import { defaultTheme, ThemeProvider } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { afterEach, expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { listRowLead } from '../../../components/list-row.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { createDraftDocument } from '../../../core/composer/document.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { clampWorkflowPromptRows } from '../layout/rect.js';
import { RecoveryMenu } from './recovery-menu.js';
import {
  buildRetryExhaustedRecoveryIssue,
  buildReviewFailedRecoveryIssue,
} from '../../../engine/orchestrator/recovery/builders/task.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import {
  getRecoveryPromptActions,
  recoveryActionKey,
  recoveryMenuParts,
  recoveryPromptSummaryRows,
} from '../recovery-prompt.js';

afterEach(() => {
  composerLiveStore.reset();
  runViewStore.__testReset();
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
            attempts: undefined,
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
    'Change REVIEW tool · runs the review again',
  ],
  [
    "a brief's hint",
    { seat: 'plan', phase: 'escalating' },
    'Change PLAN tool · restarts this brief',
  ],
  [
    'a planning step',
    { seat: 'plan', taskId: undefined, phase: 'planning' },
    'Change PLAN tool · runs this step again',
  ],
  // Saved before halts named their seat: the applier reads the planner phase as the plan seat's.
  [
    'a planning step, saved without its seat',
    { seat: undefined, taskId: undefined, phase: 'planning' },
    'Change PLAN tool · runs this step again',
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

// On a hint halt "Try again" reads as retrying the hint, but it restarts the brief; a retry that
// re-runs the call the halt stopped needs no second clause.
it.each([
  ["a brief's hint", { seat: 'plan', phase: 'escalating' }, 'Try again · restarts this brief'],
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
  expect(retryRow).toContain(label);
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
  expect(frame).toContain('Change REVIEW tool · runs the review again');
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
  expect(frame).toContain('s   Skip task');
  expect(frame).toContain('a   End run');
  ui.unmount();
});

it('stands the recommended marker one cell after the label and highlights that row', async () => {
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
  expect(row).toContain(`${listRowLead('active')}a   End run recommended`);
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
    'Fix again',
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
        attempts: undefined,
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
      paint(defaultTheme.textDim, ' · restarts this brief').replace('\u001b[39m', ''),
    );
    ui.unmount();
    chalk.level = colorLevel;
  },
);

it('preserves the action whole-word cut and seat tone at width 30', () => {
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
  expect(line).toContain('w   Change BUILD tool…');
  expect(getTerminalCellWidth(line ?? '')).toBe(30);
  expect(ui.lastFrame()).toContain(
    paint(defaultTheme.implementer, 'BUILD').replace('\u001b[39m', ''),
  );
  expect(ui.lastFrame()).toContain(paint(defaultTheme.accent, ' tool').replace('\u001b[39m', ''));
  expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, '…'));
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
  expect(rows.filter((row) => /^[│|] [▌|]? +[rdsa] {3}/.test(row))).toHaveLength(4);
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
  const cut = rows.find((row) => row.includes('…') && !row.includes('more lines'));
  expect(cut, rows.join('\n')).toBeDefined();
  expect(compact(asked).startsWith(compact(shownQuestion(rows)))).toBe(true);
  expect(shownQuestion(rows).length).toBeGreaterThan(40);
  expect(rows.some((row) => /… \d+ more lines/.test(row))).toBe(true);
  for (const action of FOUR_ACTIONS) expect(actionShown(rows, issue, action)).toBe(true);
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
  const label = recoveryMenuParts(action, issue, false)
    .map((part) => part.text)
    .join('')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

it.each([
  ['Question: ', 9, FOUR_ACTIONS],
  ['Planner said: ', 9, FOUR_ACTIONS],
  ['Question: ', 8, FOUR_ACTIONS],
  ['Planner said: ', 8, THREE_ACTIONS],
] as const)(
  'keeps %s on a panel of %i rows with no divider, and marks the rest',
  async (label, box, actions) => {
    const issue = askedIssue(`${label}${LONG_ASKED_TEXT}`, [...actions], 'retry-same-worker');
    const ui = mountBox(issue, box);
    await flushEffects();
    const rows = frameRows(ui);
    expect(rows).toHaveLength(box);
    const asked = rows.findIndex((row) => row.includes(label));
    const mark = rows.findIndex((row) => row.includes('… 4 more lines'));
    expect(asked, rows.join('\n')).toBe(2);
    expect(mark, rows.join('\n')).toBe(3);
    expect(rows.some((row) => row.includes('──────'))).toBe(false);
    expect(rows.at(-2)).toContain('↑↓ select · ⏎ confirm');
    expectHiddenActionsMarked(rows, issue);
    ui.unmount();
  },
);

it.each([
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
    const cursor = () => frameRows(ui).filter((row) => /^[│|] [▌|] /.test(row));
    expect(frameRows(ui).some((row) => row.includes('Question: '))).toBe(true);
    for (let step = 1; step <= FOUR_ACTIONS.length; step += 1) {
      ui.stdin.write('\u001b[B');
      await flushEffects();
      const action = FOUR_ACTIONS[(start + step) % FOUR_ACTIONS.length];
      if (action === undefined) throw new Error('no action');
      expect(cursor()).toHaveLength(1);
      expect(cursor()[0]).toContain(` ${recoveryActionKey(action)}   `);
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
  expect(await row()).toContain('End run · closes this run, keeps its changes');
});

it('leaves a 7-row panel on the headline and the cut mark', async () => {
  const issue = askedIssue(`Question: ${LONG_ASKED_TEXT}`, FOUR_ACTIONS, 'retry-same-worker');
  const ui = mountBox(issue, 7);
  await flushEffects();
  const rows = frameRows(ui);
  expect(rows.some((row) => row.includes('Question: '))).toBe(false);
  expect(rows[2]).toMatch(/… \d+ more lines/);
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
    expect(rows.some((row) => row.includes('Try again recommended'))).toBe(true);
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
