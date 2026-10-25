import chalk from 'chalk';
import { defaultTheme, ThemeProvider } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { afterEach, expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { listRowLead } from '../../../components/list-row.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { createDraftDocument } from '../../../core/composer/document.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { clampWorkflowPromptRows } from '../layout/rect.js';
import { RecoveryMenu } from './recovery-menu.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import {
  getRecoveryPromptActions,
  recoveryActionKey,
  recoveryMenuLabel,
} from '../recovery-prompt.js';

afterEach(() => composerLiveStore.reset());

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

it('says what ⏎ in the composer does while it holds focus, and lists no live keys', async () => {
  const ui = renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue({
        reason: 'consult-bound-spent',
        availableActions: ['continue', 'skip-current-task', 'end-run'],
        recommendedAction: 'continue',
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
  expect(frame).toContain('⏎ Continue with the typed correction · tab back to the actions');
  expect(frame).not.toContain('↑↓ select');
  expect(frame).toContain('Continue');
  expect(frame).not.toContain('c   Continue');
  ui.unmount();
});

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

it('offers a typed note on a halt whose Continue grants a spent bound', async () => {
  const ui = mount(
    vi.fn(),
    80,
    makeRecoveryIssue({
      reason: 'consult-bound-spent',
      availableActions: ['continue', 'skip-current-task', 'end-run'],
      recommendedAction: 'continue',
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

function panelBoxRows(terminalRows: number): number {
  // A one-line composer takes three rows; the panel takes every row the screen chrome leaves.
  return clampWorkflowPromptRows({
    rows: terminalRows,
    inputRows: 3,
    promptRows: Number.MAX_SAFE_INTEGER,
  });
}

async function mountPanel(issue: RecoveryIssue, terminalRows: number) {
  const ui = renderFeature(
    <RecoveryMenu
      issue={issue}
      width={getChromeContentWidth(140)}
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

function actionShown(rows: readonly string[], issue: RecoveryIssue, action: RecoveryAction) {
  const label = recoveryMenuLabel(action, issue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function consultBoundIssue() {
  return makeRecoveryIssue({
    reason: 'consult-bound-spent',
    message: 'T901 used its consult allowance after 5 attempts',
    details: [
      'Last diagnosis: Implementer is blocked on a locale table',
      'Consults: 2 of 2',
      'Attempts: 5',
    ],
    availableActions: ['continue', 'skip-current-task', 'end-run'],
    recommendedAction: 'continue',
  });
}

it.each([12, 13, 14, 15, 16])(
  'keeps the headline, the cut mark, the recommended action, the hidden-action marks and the legend at 140x%s',
  async (terminalRows) => {
    const issue = consultBoundIssue();
    const ui = await mountPanel(issue, terminalRows);
    const rows = frameRows(ui);
    expect(rows).toHaveLength(panelBoxRows(terminalRows));
    expect(rows.some((row) => row.includes('T901 used its consult allowance'))).toBe(true);
    expect(rows.some((row) => /… \d+ more lines/.test(row))).toBe(true);
    expect(rows.some((row) => row.includes('Continue recommended'))).toBe(true);
    expectHiddenActionsMarked(rows, issue);
    expect(rows.some((row) => row.includes('↑↓ select · ⏎ confirm'))).toBe(true);
    ui.unmount();
  },
);

it.each([12, 13, 14, 15, 16])(
  'keeps the selected action and marks every hidden action after one ↓ press at 140x%s',
  async (terminalRows) => {
    const issue = consultBoundIssue();
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
