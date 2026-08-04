import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { glyph } from '../../../lib/glyphs.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { WorkflowFooter, WorkflowHeader } from './chrome.js';
import { ConversationFlow } from './conversation-flow/flow.js';
import type { RouteData } from '../../../stores/navigation/router.js';

const RAIL_STAGES = ['Spec', 'Plan', 'Briefs', 'Build', 'Verify'];
const WORKFLOW_ROUTE = {
  screen: 'workflow',
  execution: {
    kind: 'attached',
    feature: 'test feature',
    sessionId: 'chrome-test-session',
    attach: { sockPath: '/tmp/chrome-test.sock', authToken: 'test-token' },
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

  it('renders the full rail/chrome frame: five stages, no retired dot labels, one divider', async () => {
    const ui = renderFeature(<WorkflowHeader startedAt={new Date().toISOString()} />);
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
        <WorkflowHeader startedAt={new Date().toISOString()} />
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
  });

  function renderFooter(
    props: Partial<{
      mode: 'normal' | 'question' | 'review';
      inputHint: string;
      questionEpoch: number;
      reviewEpoch: number;
      handleInput: (text: string) => void;
    }> = {},
  ) {
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
    );
  }

  it('appends a done token to the footer key cluster when the phase is complete', async () => {
    lifecycleStore.__testReset({ phase: 'complete', status: 'complete', startedAt: 0, endedAt: 1 });
    const ui = renderFooter();
    await tick();

    expect(ui.lastFrame() ?? '').toContain(glyph('check'));
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

  it('omits the done token and the ⏎ hint while the workflow is still running', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const ui = renderFooter();
    await tick();

    expect(ui.lastFrame() ?? '').not.toContain(glyph('check'));
    expect(ui.lastFrame() ?? '').not.toContain('⏎');
    ui.unmount();
  });

  it('clears a stale answer when questionEpoch advances in question mode', async () => {
    const submits: string[] = [];
    const ui = renderFooter({
      mode: 'question',
      inputHint: 'first question',
      questionEpoch: 1,
      handleInput: (text) => submits.push(text),
    });
    await flushEffects();
    ui.stdin.write('stale answer');
    await tick(20);
    expect(ui.lastFrame()).toContain('stale answer');

    ui.rerender(
      <WorkflowFooter
        handleInput={(text) => submits.push(text)}
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
});
