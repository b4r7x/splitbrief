import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { defaultTheme } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { hydrateFromState } from '../../../stores/workflow/actions/hydrate.js';
import { loadEvents } from '../../../stores/workflow/actions/load.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { glyph } from '../../../lib/glyphs.js';
import { formatResetAt } from '../../../core/recovery/reset-clock.js';
import { seatWaitSentence } from '../display/seat-wait-line.js';
import { InputFooter } from './input-footer.js';

const originalColorLevel = chalk.level;

describe('seatWait byline', () => {
  beforeEach(() => {
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/splitbrief-test' });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord(),
      execution: {
        kind: 'local',
        prepared: makePreparedExecution({
          projectDir: '/tmp/splitbrief-test',
          sessionId: 'seat-wait-byline-session',
          feature: 'demo',
          config: makeConfig(),
          gates: () => [],
        }),
      },
    });
    lifecycleStore.__testReset();
    tasksStore.__testReset();
  });

  afterEach(() => {
    chalk.level = originalColorLevel;
    configStore.__testReset();
    routerStore.init({ screen: 'home' });
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    terminalSizeStore.reset();
  });

  it('formats the sentence with middle dot and returns null on invalid reset', () => {
    const resetAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(seatWaitSentence('claude', resetAt)).toBe(
      `Waiting for claude · ${formatResetAt(resetAt)}`,
    );
    expect(seatWaitSentence('codex', undefined)).toBeNull();
    expect(seatWaitSentence('codex', 'not-a-date')).toBeNull();
  });

  it('shows the sentence and hides Resuming the plan when seatWait is set in paused Plan', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const resetAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    lifecycleStore.__testReset({
      status: 'paused',
      phase: 'planning',
      seatWait: { tool: 'claude', resetAt },
    });
    const ui = renderFeature(<InputFooter width={120} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const sentence = seatWaitSentence('claude', resetAt)!;
    expect(frame).toContain(`${glyph('statusPending')} ${sentence}`);
    expect(frame).not.toContain('Resuming the plan');
    expect(frame).not.toContain('Resuming');
    ui.unmount();
  });

  it('hides Resuming T002 when seatWait is set in paused Build', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const resetAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    lifecycleStore.__testReset({
      status: 'paused',
      phase: 'implementing',
      seatWait: { tool: 'codex', resetAt },
    });
    tasksStore.__testReset({
      currentTask: 2,
      totalTasks: 2,
      tasks: [
        { id: 'T001', title: 'One', status: 'done' },
        { id: 'T002', title: 'Two', status: 'in_progress' },
      ],
    });
    const ui = renderFeature(<InputFooter width={120} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const sentence = seatWaitSentence('codex', resetAt)!;
    expect(frame).toContain(`${glyph('statusPending')} ${sentence}`);
    expect(frame).not.toContain('Resuming T002');
    expect(frame).not.toContain('Resuming');
    ui.unmount();
  });

  it('hides Resuming the review when seatWait is set in paused Review', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const resetAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    lifecycleStore.__testReset({
      status: 'paused',
      phase: 'final-review',
      seatWait: { tool: 'gemini', resetAt },
    });
    const ui = renderFeature(<InputFooter width={120} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const sentence = seatWaitSentence('gemini', resetAt)!;
    expect(frame).toContain(`${glyph('statusPending')} ${sentence}`);
    expect(frame).not.toContain('Resuming the review');
    expect(frame).not.toContain('Resuming');
    ui.unmount();
  });

  it('hides Implementing and hides a rising clock when seatWait is set in running Build', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const resetAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'implementing',
      startedAt: Date.now() - 42_000,
      phaseFirstSeenTs: { implementing: Date.now() - 42_000 },
      seatWait: { tool: 'codex', resetAt },
    });
    const ui = renderFeature(<InputFooter width={120} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const sentence = seatWaitSentence('codex', resetAt)!;
    expect(frame).toContain(`${glyph('statusPending')} ${sentence}`);
    expect(frame).not.toContain('Implementing');
    expect(frame).not.toContain('0:42');
    ui.unmount();
  });

  it('shows Resuming when seatWait is null on paused Build', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      status: 'paused',
      phase: 'implementing',
      seatWait: null,
    });
    tasksStore.__testReset({
      currentTask: 2,
      totalTasks: 2,
      tasks: [
        { id: 'T001', title: 'One', status: 'done' },
        { id: 'T002', title: 'Two', status: 'in_progress' },
      ],
    });
    const ui = renderFeature(<InputFooter width={120} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Resuming T002');
    ui.unmount();
  });

  it('keeps Resuming T002 when the wait deadline has passed', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const resetAt = new Date(Date.now() - 60 * 1000).toISOString();
    lifecycleStore.__testReset({
      status: 'paused',
      phase: 'implementing',
      seatWait: { tool: 'codex', resetAt },
    });
    tasksStore.__testReset({
      currentTask: 2,
      totalTasks: 2,
      tasks: [
        { id: 'T001', title: 'One', status: 'done' },
        { id: 'T002', title: 'Two', status: 'in_progress' },
      ],
    });
    const ui = renderFeature(<InputFooter width={120} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Resuming T002');
    expect(frame).not.toContain('Waiting for');
    ui.unmount();
  });

  it('still shows its own text when a given byline is passed', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const resetAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    lifecycleStore.__testReset({
      status: 'paused',
      phase: 'implementing',
      seatWait: { tool: 'codex', resetAt },
    });
    const ui = renderFeature(
      <InputFooter
        width={120}
        byline={[{ text: 'Stopped at T002 — stopped by you', tone: 'warning' }]}
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Stopped at T002 — stopped by you');
    expect(frame).not.toContain('Waiting for codex');
    ui.unmount();
  });

  it('paints the wait line in the attention tone', () => {
    chalk.level = 3;
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const resetAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    lifecycleStore.__testReset({
      status: 'paused',
      phase: 'planning',
      seatWait: { tool: 'claude', resetAt },
    });
    const ui = renderFeature(<InputFooter width={120} />);
    const sentence = seatWaitSentence('claude', resetAt)!;
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.warning, `${glyph('statusPending')} ${sentence}`),
    );
    ui.unmount();
  });
});

describe.each([
  { seat: 'plan', phase: 'planning', tool: 'Claude Code CLI' },
  { seat: 'build', phase: 'implementing', tool: 'OpenAI Codex CLI' },
  { seat: 'review', phase: 'final-review', tool: 'Gemini CLI' },
] as const)('a $seat seat wait', ({ seat, phase, tool }) => {
  beforeEach(() => {
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/splitbrief-test' });
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
  });

  afterEach(() => {
    configStore.__testReset();
    resetWorkflow();
    terminalSizeStore.reset();
  });

  function waitLine(): string | undefined {
    const ui = renderFeature(<InputFooter width={120} />);
    const line = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .find((row) => row.includes('Waiting for'))
      ?.trim();
    ui.unmount();
    return line;
  }

  it('reads one line in the process that waits and in a reopened run that waits again', () => {
    const now = Date.now();
    const resetAt = new Date(now + 10 * 60 * 1000).toISOString();
    const started = { type: 'workflow_started', ts: now - 60_000, phase, feature: 'demo' } as const;
    const wait = { type: 'seat_wait_started', ts: now, phase, seat, resetAt, tool } as const;

    resetWorkflow();
    addEvent(started);
    addEvent(wait);
    const live = waitLine();

    resetWorkflow();
    loadEvents([started, { ...wait, ts: now - 30_000 }]);
    hydrateFromState(makeWorkflowState({ phase }));
    addEvent(wait);
    const reopened = waitLine();

    expect(live).toBe(`${glyph('statusPending')} Waiting for ${tool} · ${formatResetAt(resetAt)}`);
    expect(reopened).toBe(live);
  });
});
