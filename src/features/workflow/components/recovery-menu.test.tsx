import chalk from 'chalk';
import { defaultTheme, ThemeProvider } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { listRowLead } from '../../../components/list-row.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { RecoveryMenu } from './recovery-menu.js';

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
