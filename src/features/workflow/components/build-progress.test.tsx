import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeRunnerCallActivity,
  makeRunnerCallStarted,
  makeRunnerCallStalled,
} from '#testing/helpers/events/runner-call.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { defaultTheme, ThemeText as Text } from '../../../components/theme.js';
import { configStore } from '../../../stores/project/config.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { markWorkflowPaused } from '../../../stores/workflow/actions/pause.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { BuildProgressBlock } from './build-progress.js';

// Ink resolves chalk's colour level against the capture stdout unless FORCE_COLOR is set before
// ink first loads, so the colour assertion below would pass on a frame with no colour in it.
const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

const NOW = 1_783_958_400_000;

function colorOpen(color: string | undefined): string {
  const ui = renderFeature(<Text color={color}>x</Text>);
  const frame = ui.lastFrame();
  ui.unmount();
  return frame.slice(0, frame.indexOf('x'));
}

beforeEach(() => {
  resetAllStores();
  configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
  lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
  tasksStore.__testReset({
    totalTasks: 3,
    currentAttempt: 1,
    tasks: [
      { id: 'T001', title: 'One', status: 'done' },
      { id: 'T002', title: 'Two', status: 'in_progress' },
      { id: 'T003', title: 'Three', status: 'pending' },
    ],
  });
});

/** A brief on its second attempt, with a six-figure count the block would once have rounded. */
function seedRunningAttemptTokens(): void {
  tokensStore.__testReset({
    perTask: {
      T002: {
        totalTokens: 148_000,
        title: 'Two',
        attempts: [
          { method: 'local', retryCount: 0, implementerTokens: 24_000, escalationTokens: 0 },
          { method: 'local', retryCount: 1, implementerTokens: 124_000, escalationTokens: 0 },
        ],
      },
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  resetAllStores();
});

describe('BuildProgressBlock', () => {
  it('states the counts, and the attempt only once a retry has spent one', () => {
    const first = renderFeature(<BuildProgressBlock cols={120} />);
    expect(stripAnsiStyles(first.lastFrame())).toContain('1/3 briefs passed');
    expect(first.lastFrame()).toContain(`${colorOpen(defaultTheme.textDim)}1/3 briefs passed`);
    expect(first.lastFrame()).not.toContain(`${colorOpen(defaultTheme.success)}passed`);
    expect(first.lastFrame() ?? '').not.toContain('attempt');
    expect(first.lastFrame() ?? '').not.toContain('ETA');
    first.unmount();

    tasksStore.__testReset({ ...tasksStore.get(), currentAttempt: 2 });
    const retry = renderFeature(<BuildProgressBlock cols={120} />);
    expect(stripAnsiStyles(retry.lastFrame() ?? '')).toContain('1/3 briefs passed · attempt 2 of');
    retry.unmount();
  });

  it('spreads the same facts over more rows when the terminal is narrow', () => {
    const ui = renderFeature(<BuildProgressBlock cols={60} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(3);

    ui.unmount();
  });

  it('names no token count for a brief whose attempt booked one', () => {
    seedRunningAttemptTokens();

    for (const cols of [120, 80, 60]) {
      const ui = renderFeature(<BuildProgressBlock cols={cols} />);
      const frame = stripAnsiStyles(ui.lastFrame());

      expect(frame).toContain('1/3 briefs passed');
      expect(frame).toContain('Between calls');
      expect(frame).not.toMatch(/token/i);
      expect(frame).not.toContain('124k');
      expect(frame).not.toContain('0k');

      ui.unmount();
    }
  });

  it('counts the quiet up while nothing else repaints it, and stops with the run', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    addEvent(makeRunnerCallStarted({ ts: NOW - 2_000, runnerName: 'opencode' }));

    const ui = renderFeature(<BuildProgressBlock cols={120} />);
    expect(stripAnsiStyles(ui.lastFrame())).toContain('last event 2s ago');

    vi.advanceTimersByTime(3_000);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('last event 5s ago');

    markWorkflowPaused();
    await flushEffects();
    vi.advanceTimersByTime(3_000);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('last event 5s ago');

    ui.unmount();
  });

  it('paints a silent seat in the warning colour, and only the silence on its row', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    addEvent(makeRunnerCallStarted({ ts: NOW - 312_000, runnerName: 'opencode' }));
    addEvent(makeRunnerCallStalled({ ts: NOW - 12_000, silentMs: 300_000 }));
    const warning = colorOpen(defaultTheme.warning);

    const ui = renderFeature(<BuildProgressBlock cols={160} />, { cols: 160, rows: 24 });
    const frame = ui.lastFrame();

    expect(stripAnsiStyles(frame)).toContain(
      'OpenCode CLI · auto · working · No output for 5:12 · tools report when done',
    );
    expect(frame).toContain(`${warning}No output for 5:12`);
    expect(frame).toContain(`${colorOpen(defaultTheme.textDim)} · `);
    expect(frame).toContain(`${warning}tools report when done`);
    expect(frame).not.toContain(`${warning}OpenCode CLI · auto · working`);

    ui.unmount();
  });

  it('colors only the silence after a recorded identity sheds its model and axes', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    addEvent(
      makeRunnerCallStarted({
        ts: NOW - 312_000,
        runnerName: 'opencode',
        model: 'long-model-name-'.repeat(10),
        axes: ['high'],
      }),
    );
    addEvent(makeRunnerCallStalled({ ts: NOW - 12_000, silentMs: 300_000 }));
    const warning = colorOpen(defaultTheme.warning);
    for (const cols of [120, 80, 60]) {
      const ui = renderFeature(<BuildProgressBlock cols={cols} />, { cols, rows: 24 });
      const frame = ui.lastFrame();
      const silence =
        cols === 120 ? 'No output for 5:12' : 'No output for 5:12 · tools report when done';
      const separator = cols === 120 ? ' · ' : '\n';
      expect(stripAnsiStyles(frame)).toContain(`OpenCode CLI · working${separator}${silence}`);
      expect(frame).toContain(`${warning}No output for 5:12`);
      if (cols !== 120) {
        expect(frame).toContain(`${colorOpen(defaultTheme.textDim)} · `);
        expect(frame).toContain(`${warning}tools report when done`);
      }
      expect(frame).not.toContain(`${warning}OpenCode CLI`);
      if (cols === 120) expect(stripAnsiStyles(frame)).not.toContain('tools report when done');
      ui.unmount();
    }
  });

  it('colors only the silence after a full recorded identity and a cut command description', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    addEvent(
      makeRunnerCallStarted({
        ts: NOW - 312_000,
        runnerName: 'codex',
        model: 'gpt-5',
        axes: ['high'],
      }),
    );
    addEvent(
      makeRunnerCallActivity({
        ts: NOW - 311_000,
        callId: 'call-2',
        runnerName: 'codex',
        stage: 'updated',
        kind: 'command',
        label: 'bash',
        target: `npm test -- ${'src/features/workflow/'.repeat(8)}`,
      }),
    );
    addEvent(makeRunnerCallStalled({ ts: NOW - 12_000, silentMs: 300_000 }));
    const warning = colorOpen(defaultTheme.warning);

    for (const cols of [120, 80, 60]) {
      const ui = renderFeature(<BuildProgressBlock cols={cols} />, { cols, rows: 24 });
      const frame = ui.lastFrame();
      const separator = cols === 120 ? ' · ' : '\n';
      expect(stripAnsiStyles(frame)).toContain(
        `OpenAI Codex CLI · GPT-5 · high · working${separator}No output for 5:12 · running npm test`,
      );
      expect(frame).toContain(`${warning}No output for 5:12`);
      expect(frame).toContain(`${colorOpen(defaultTheme.textDim)} · `);
      expect(frame).toContain(`${warning}running npm test`);
      expect(frame).not.toContain(`${warning}OpenAI Codex CLI`);
      ui.unmount();
    }
  });

  it('keeps a shell command named claude literal in its activity line', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    addEvent(
      makeRunnerCallStarted({ ts: NOW - 312_000, runnerName: 'claude', backendKind: 'shell' }),
    );
    addEvent(makeRunnerCallStalled({ ts: NOW - 12_000, silentMs: 300_000 }));

    const ui = renderFeature(<BuildProgressBlock cols={160} />, { cols: 160, rows: 24 });
    const frame = stripAnsiStyles(ui.lastFrame());

    expect(frame).toContain('claude · auto · working · No output for 5:12');
    expect(frame).not.toContain('Claude Code CLI');

    ui.unmount();
  });

  it('keeps an API provider named claude-code literal in its activity line', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    addEvent(
      makeRunnerCallStarted({ ts: NOW - 312_000, runnerName: 'claude-code', backendKind: 'api' }),
    );
    addEvent(makeRunnerCallStalled({ ts: NOW - 12_000, silentMs: 300_000 }));

    const ui = renderFeature(<BuildProgressBlock cols={160} />, { cols: 160, rows: 24 });
    const frame = stripAnsiStyles(ui.lastFrame());

    expect(frame).toContain('claude-code · auto · working · No output for 5:12');
    expect(frame).not.toContain('Claude Code CLI');

    ui.unmount();
  });
});
