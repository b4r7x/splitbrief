import type { DraftSubmission } from '../../../core/composer/submission.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Text } from 'ink';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { clearAllHandlers, setResumeHandler } from '../handlers.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { WORKFLOW_GUTTER_X } from '../layout/chrome-rows.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { WorkflowFooter, WorkflowHeader } from './chrome.js';
import { ConversationFlow } from './conversation-flow/flow.js';
import type { RouteData } from '../../../stores/navigation/router.js';

const RAIL_STAGES = ['Plan', 'Build', 'Review'];
// The workflow composer wears the round frame; its top-left corner is what marks the box's left
// edge.
const COMPOSER_TOP_LEFT = '╭';
const WORKFLOW_ROUTE = {
  screen: 'workflow',
  run: makeRunRecord(),
  execution: {
    kind: 'local',
    prepared: makePreparedExecution({
      projectDir: '/tmp/splitbrief-test',
      sessionId: 'chrome-test-session',
      feature: 'test feature',
      config: makeConfig(),
      gates: () => [],
    }),
  },
} satisfies RouteData;

describe('WorkflowHeader', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    routerStore.init(WORKFLOW_ROUTE);
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'researching', status: 'running', startedAt: 0 });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders the full rail/chrome frame: three stages, no retired dot labels, one divider', async () => {
    const ui = renderFeature(<WorkflowHeader />);
    await tick();
    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n');
    const rule = glyph('divider', 'unicode');
    const dividerLines = lines.filter((line) => stripAnsiStyles(line).includes(rule.repeat(20)));

    for (const stage of RAIL_STAGES) expect(frame).toContain(stage);
    expect(frame).not.toContain('res ');
    expect(frame).not.toContain('impl');
    expect(frame).not.toContain('rev');
    expect(dividerLines).toHaveLength(1);
    ui.unmount();
  });

  it('does not duplicate the latest user message in workflow chrome', async () => {
    const userText = 'single visible user message';
    eventsStore.__testReset({
      events: [
        {
          type: 'user_message',
          ts: 1,
          phase: 'implementing',
          text: userText,
        },
      ],
    });

    const ui = renderFeature(
      <>
        <WorkflowHeader />
        <ConversationFlow height={6} conversationWidth={80} contentWidth={80} />
      </>,
    );
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame.match(new RegExp(userText, 'g')) ?? []).toHaveLength(1);
    ui.unmount();
  });
});

describe('WorkflowFooter', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    routerStore.init(WORKFLOW_ROUTE);
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/splitbrief-test' });
  });

  afterEach(() => {
    resetAllStores();
    clearAllHandlers();
  });

  function renderFooter(
    props: Partial<{
      mode: 'normal' | 'question' | 'review';
      inputHint: string;
      questionEpoch: number;
      reviewEpoch: number;
      handleInput: (submission: Extract<DraftSubmission, { ok: true }>) => void;
    }> = {},
  ) {
    const { cols, rows } = terminalSizeStore.get();
    return renderFeature(
      <WorkflowFooter
        handleInput={props.handleInput ?? (() => {})}
        onRuntimeCommand={() => {}}
        commands={[]}
        mode={props.mode ?? 'normal'}
        inputHint={props.inputHint ?? ''}
        questionEpoch={props.questionEpoch ?? 0}
        reviewEpoch={props.reviewEpoch}
        disabled={false}
      />,
      { cols, rows },
    );
  }

  // A run whose tokens carry a price: before /usage the footer painted `$3.00` next to the keys
  // from exactly this fixture.
  function seedPricedRun(): void {
    tokensStore.__testReset({
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
    });
    configStore.__testReset({
      projectDir: '/tmp/splitbrief-test',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'custom-endpoint',
          model: 'priced-model',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
        },
      }),
    });
    modelCacheStore.hydrateModelsDevCatalog({
      catalog: {
        vendor: {
          id: 'vendor',
          models: { 'priced-model': { id: 'priced-model', cost: { input: 1, output: 2 } } },
        },
      },
      fetchedAt: 1,
      validatedAt: 1,
    });
  }

  it.each([
    ['implementing', 'Message BUILD on T003 · read when its call ends…'],
    ['planning', 'Message PLAN · read at its next call…'],
    ['final-review', 'Message REVIEW · read at its verdict call…'],
  ] as const)(
    'shows the queue destination in the composer while %s',
    async (phase, placeholder) => {
      lifecycleStore.__testReset({ phase, status: 'running' });
      tasksStore.__testReset({
        currentTask: 1,
        totalTasks: 1,
        tasks: [{ id: 'T003', title: 'Running brief', status: 'in_progress' }],
      });
      const ui = renderFooter();
      await flushEffects();
      expect(ui.lastFrame()).toContain(placeholder);
      ui.unmount();
    },
  );

  it.each([
    ['question', 'Type your answer…'],
    ['review', 'Type a comment…'],
  ] as const)(
    'keeps the %s invitation while a prompt owns the composer',
    async (mode, placeholder) => {
      lifecycleStore.__testReset({ phase: 'planning', status: 'running' });
      const ui = renderFooter({ mode });
      await flushEffects();
      expect(ui.lastFrame()).toContain(placeholder);
      expect(ui.lastFrame()).not.toContain('Message PLAN');
      ui.unmount();
    },
  );

  it.each([
    ['implementing', 'build', 'BUILD on T003'],
    ['planning', 'plan', 'PLAN'],
    ['final-review', 'review', 'REVIEW'],
  ] as const)(
    'keeps the steerable %s placeholder on one row at 60 columns',
    async (phase, seat, target) => {
      terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: false });
      lifecycleStore.__testReset({ phase, status: 'running' });
      tasksStore.__testReset({
        currentTask: 1,
        totalTasks: 1,
        tasks: [{ id: 'T003', title: 'Running brief', status: 'in_progress' }],
      });
      addEvent({ type: 'steerable_call', ts: 1, phase, seat, taskId: 'T003' });
      const ui = renderFooter();
      await flushEffects();
      expect(ui.lastFrame()).toContain(`Message ${target} · read after this tool…`);
      addEvent({ type: 'steerable_call', ts: 2, phase });
      await flushEffects();
      expect(ui.lastFrame()).not.toContain('read after this tool');
      ui.unmount();
    },
  );

  it('keeps wave 1 copy when the attached call belongs to another seat', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
    addEvent({ type: 'steerable_call', ts: 1, phase: 'implementing', seat: 'plan' });
    const ui = renderFooter();
    await flushEffects();
    expect(ui.lastFrame()).toContain('Message BUILD · read when its call ends…');
    ui.unmount();
  });

  it('keeps the composer silent while stopping', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
    stopStore.__testReset({ intent: 'stop-now', phase: 'requested' });
    const ui = renderFooter();
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('Message BUILD');
    expect(ui.lastFrame()).not.toContain('Describe a change');
    ui.unmount();
  });

  it('routes ctrl+enter through steer to resume a stopped run with the draft', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'paused' });
    stopStore.__testReset({ phase: 'parked' });
    const resumed: string[] = [];
    const queued: string[] = [];
    stopStore.__testReset({
      phase: 'parked',
      parked: {
        kind: 'mid-brief',
        taskId: 'T003',
        resolve: (message) => resumed.push(message.text),
        kept: [],
      },
    });
    setResumeHandler((message) => resumed.push(message.text));
    const ui = renderFooter({ handleInput: (submission) => queued.push(submission.message.text) });
    await flushEffects();
    ui.stdin.write('smaller diffs');
    await flushEffects();
    ui.stdin.write('\x1b[13;5u');
    await flushEffects();
    expect(resumed).toEqual(['smaller diffs']);
    expect(queued).toEqual([]);
    expect(lifecycleStore.get().status).toBe('running');
    ui.unmount();
  });

  it('preserves the draft when ctrl+enter is rejected during stopping', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
    stopStore.__testReset({ intent: 'stop-now', phase: 'terminating' });
    const queued: string[] = [];
    const ui = renderFooter({ handleInput: (submission) => queued.push(submission.message.text) });
    await flushEffects();
    ui.stdin.write('keep every word');
    await flushEffects();
    ui.stdin.write('\x1b[13;5u');
    await flushEffects();

    expect(feedbackStore.get().message).toBe('Finish stopping before steering.');
    expect(ui.lastFrame()).toContain('keep every word');
    expect(queued).toEqual([]);
    ui.unmount();
  });

  it('paints no money or token total for a priced run, with or without override keys', async () => {
    seedPricedRun();
    const { cols, rows } = terminalSizeStore.get();
    const ui = renderFeature(
      <WorkflowFooter
        handleInput={() => {}}
        onRuntimeCommand={() => {}}
        commands={[]}
        mode="normal"
        inputHint=""
        boxHintOverride={{ keys: 'ctrl+d diff' }}
        disabled={false}
      />,
      { cols, rows },
    );
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('ctrl+d diff');
    expect(frame).not.toContain('$');
    expect(frame).not.toContain('3.00');
    expect(frame).not.toContain('1,000,000');
    expect(frame).not.toMatch(/\btokens?\b/i);
    ui.unmount();
  });

  // A complete run can still be waiting on a correction after a failed review: a done mark beside
  // the caret would contradict it, and the closed block and the rail already state the outcome.
  it('paints no done mark in the composer once the phase is complete', async () => {
    seedPricedRun();
    lifecycleStore.__testReset({ phase: 'complete', status: 'complete', startedAt: 0, endedAt: 1 });
    const ui = renderFooter();
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain(glyph('check'));
    expect(frame).not.toContain('$');
    ui.unmount();
  });

  it('drops the ⏎ keys hint in question mode but keeps the feedback hint in the footer', async () => {
    const ui = renderFooter({
      mode: 'question',
      inputHint: 'answer prompt shown above',
    });
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('⏎');
    expect(frame).not.toContain('send');
    expect(frame).toContain('answer prompt shown above');
    ui.unmount();
  });

  it('omits the ⏎ hint while the workflow is still running', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const ui = renderFooter();
    await tick();

    expect(ui.lastFrame() ?? '').not.toContain('⏎');
    ui.unmount();
  });

  it('keeps the review composer at the full width inside the gutter', async () => {
    const cols = 160;
    terminalSizeStore.__testReset({ cols, rows: 30, isSmall: false });
    const ui = renderFooter({ mode: 'review', inputHint: 'y approve · c comment · q reject' });
    await tick();

    const topBorder = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .find((line) => line.trimStart().startsWith(COMPOSER_TOP_LEFT));

    expect(topBorder).toBeDefined();
    // The box stands on the gutter line and stops one gutter short of the right edge.
    expect(topBorder?.indexOf(COMPOSER_TOP_LEFT)).toBe(WORKFLOW_GUTTER_X);
    expect(getTerminalCellWidth((topBorder ?? '').trimStart())).toBe(cols - WORKFLOW_GUTTER_X * 2);
    ui.unmount();
  });

  it('puts the border, the live pip and the legend mark on the mark column, the keys on the text one', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const ui = renderFooter();
    await tick();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const legend = lines.find((line) => line.includes('esc stop options')) ?? '';
    const topBorder = lines.find((line) => line.includes(COMPOSER_TOP_LEFT)) ?? '';
    const byline = lines.at(-1) ?? '';

    expect(topBorder.indexOf(COMPOSER_TOP_LEFT)).toBe(WORKFLOW_GUTTER_X);
    // A live byline opens with its pip, so it keeps the mark column the border stands on.
    expect(byline.search(/\S/)).toBe(WORKFLOW_GUTTER_X);
    // The legend's mark shares that column and its first key opens on the text column.
    expect(legend.search(/\S/)).toBe(WORKFLOW_GUTTER_X);
    expect(legend.indexOf('esc')).toBe(WORKFLOW_GUTTER_X + MARK_SLOT_CELLS);
    ui.unmount();
  });

  it('clears a stale answer when questionEpoch advances in question mode', async () => {
    const submits: string[] = [];
    const ui = renderFooter({
      mode: 'question',
      inputHint: 'first question',
      questionEpoch: 1,
      handleInput: (submission) => submits.push(submission.message.displayText),
    });
    await flushEffects();
    ui.stdin.write('stale answer');
    await tick(20);
    expect(ui.lastFrame()).toContain('stale answer');

    ui.rerender(
      <WorkflowFooter
        handleInput={(submission) => submits.push(submission.message.displayText)}
        onRuntimeCommand={() => {}}
        commands={[]}
        mode="question"
        inputHint="second question"
        questionEpoch={2}
        disabled={false}
      />,
    );
    await tick(20);
    expect(ui.lastFrame()).not.toContain('stale answer');

    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);
    expect(submits).not.toContain('stale answer');
    ui.unmount();
  });

  it('preserves a review draft across rerenders and clears it when the review owner changes', async () => {
    const ui = renderFooter({ mode: 'review', reviewEpoch: 1 });
    await flushEffects();
    ui.stdin.write('owner one draft');
    await tick(20);
    expect(ui.lastFrame()).toContain('owner one draft');

    ui.rerender(
      <WorkflowFooter
        handleInput={() => {}}
        onRuntimeCommand={() => {}}
        commands={[]}
        mode="review"
        inputHint=""
        reviewEpoch={1}
        disabled={false}
      />,
    );
    await tick(20);
    expect(ui.lastFrame()).toContain('owner one draft');

    ui.rerender(
      <WorkflowFooter
        handleInput={() => {}}
        onRuntimeCommand={() => {}}
        commands={[]}
        mode="review"
        inputHint=""
        reviewEpoch={2}
        disabled={false}
      />,
    );
    await tick(20);
    expect(ui.lastFrame()).not.toContain('owner one draft');
    ui.unmount();
  });

  // The reachable production state behind the blank row: a question (or review gate) owns the run,
  // so the feedback row resolves no word — and the stop sheet hides that panel while it is up.
  it('paints no blank row above the stop sheet while a question owns the run', async () => {
    lifecycleStore.__testReset({ phase: 'researching', status: 'running', startedAt: 0 });
    controlsStore.setInputMode('question');
    const ui = renderFeature(
      <WorkflowFooter
        handleInput={() => {}}
        onRuntimeCommand={() => {}}
        commands={[]}
        mode="question"
        inputHint=""
        disabled={false}
        beforeComposer={<Text>Stop options</Text>}
      />,
      { cols: 100, rows: 24 },
    );
    await tick();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    expect(lines.findIndex((line) => line.includes('Stop options'))).toBe(0);
    ui.unmount();
  });

  // The sheet's own legend says what esc does while it is open; the running legend would say
  // `esc stop options` for a sheet already on screen.
  it('leaves the legend to the stop sheet while a build runs', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const ui = renderFeature(
      <WorkflowFooter
        handleInput={() => {}}
        onRuntimeCommand={() => {}}
        commands={[]}
        mode="normal"
        inputHint=""
        disabled={false}
        beforeComposer={<Text>Stop options</Text>}
      />,
      { cols: 100, rows: 24 },
    );
    await tick();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    expect(lines.findIndex((line) => line.includes('Stop options'))).toBe(0);
    ui.unmount();
  });
});
