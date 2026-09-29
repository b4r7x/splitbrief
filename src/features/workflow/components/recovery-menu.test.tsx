import { expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
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
    availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
    recommendedAction: 'switch-seat',
    switchSeat: {
      seat: 'build',
      candidates: [{ tool: 'opencode' }, { tool: 'codex' }],
    },
  });
}

it('a letter key acts as the offered row it names', async () => {
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
  expect(stripAnsiStyles(ui.lastFrame())).toContain('letter key acts');
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
    'the final review, on the plan seat it follows',
    { seat: 'review', taskId: undefined, phase: 'final-review' },
    'Change PLAN tool · runs the review again',
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
    availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
    recommendedAction: 'switch-seat',
    switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
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
    availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
    recommendedAction: 'retry-same-worker',
  });
  const ui = mount(vi.fn(), 100, issue);
  await flushEffects();
  const retryRow = stripAnsiStyles(ui.lastFrame())
    .split('\n')
    .find((line) => line.includes('Try again'));
  expect(retryRow?.replace(/[|│▌]/g, '').replace('recommended', '').trim()).toBe(label);
  ui.unmount();
});

// A panel too narrow for a row's words and its marker keeps the words whole and drops the marker.
it('keeps every action label whole on a 50-column panel', async () => {
  const issue = makeRecoveryIssue({
    reason: 'runner-usage-limit',
    seat: 'review',
    taskId: undefined,
    phase: 'final-review',
    availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
    recommendedAction: 'switch-seat',
    switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
  });
  const ui = mount(vi.fn(), 50, issue);
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  const rows = frame
    .split('\n')
    .filter((line) => /Try again|Change PLAN tool|Pause run|End run/.test(line));
  expect(rows).toHaveLength(4);
  expect(frame).toContain('Change PLAN tool · runs the review again');
  for (const row of rows) expect(row).not.toContain('…');
  ui.unmount();
});

it('drops a legend clause whole rather than cutting the last key in half', async () => {
  const ui = mount(vi.fn(), 60);
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  expect(frame).toContain('tab type a reply');
  expect(frame).not.toContain('letter key acts');
  ui.unmount();
});
