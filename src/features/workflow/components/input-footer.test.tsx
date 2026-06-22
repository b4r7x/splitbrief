import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { adviseMode } from '../../../engine/orchestrator/planning/mode-advisor.js';
import type { AdvisorResult } from '../../../engine/orchestrator/planning/mode-advisor.js';
import { _eventsInternal, eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { buildInputFooterLayout, InputFooter } from './input-footer.js';

function publishAdvisory(advisory: AdvisorResult): void {
  if (advisory.kind === 'none') return;
  _eventsInternal.set((prev) => ({
    events: [
      ...prev.events,
      {
        type: 'mode_advice',
        ts: Date.now(),
        phase: 'planning',
        kind: advisory.kind,
        risk: advisory.risk,
        currentMode: advisory.currentMode,
        suggestedMode: advisory.suggestedMode,
        confidence: advisory.confidence,
        factors: advisory.factors,
        missing: advisory.missing,
      },
    ],
  }));
}

describe('buildInputFooterLayout', () => {
  it('keeps narrow footers focused on controls and task progress', () => {
    const layout = buildInputFooterLayout({
      cols: 44,
      isAttachedClient: false,
      advisoryText: 'advisor: likely instant · trivial edit',
      taskText: 'Task 2/8',
      queueCountText: 'queued: 3',
      queuePreviewText: null,
      gitLabel: 'git: branch+task',
    });

    expect(layout.left).toBe('Ctrl+C abort');
    expect(layout.right).toBe('Task 2/8 · queued: 3');
  });

  it('keeps wide footers split between left controls and right status', () => {
    const layout = buildInputFooterLayout({
      cols: 120,
      isAttachedClient: false,
      advisoryText: 'advisor: likely instant · trivial edit',
      taskText: 'Task 2/8 · 4m left',
      queueCountText: 'queued: 3',
      queuePreviewText: null,
      gitLabel: 'git: branch+task',
    });

    expect(layout.left).toContain('Ctrl+C abort');
    expect(layout.left).toContain('Ctrl+C again exit');
    expect(layout.left).toContain('advisor:');
    expect(layout.right).toBe('Task 2/8 · 4m left · queued: 3 pending · git: branch+task');
  });

  it('drops queue preview before queue count when compact', () => {
    const layout = buildInputFooterLayout({
      cols: 48,
      isAttachedClient: false,
      advisoryText: null,
      taskText: 'Task 2/8',
      queueCountText: 'queued: 3',
      queuePreviewText: 'latest pending change',
      gitLabel: 'git: branch+task',
    });

    expect(layout.right).toBe('Task 2/8 · queued: 3');
    expect(layout.right).not.toContain('latest pending change');
  });

  it('fits wide-character queue previews by terminal cell width', () => {
    const cols = 64;
    const layout = buildInputFooterLayout({
      cols,
      isAttachedClient: false,
      advisoryText: null,
      taskText: 'Task 2/8',
      queueCountText: 'queued: 3',
      queuePreviewText: '界語🙂界語🙂界語🙂界語🙂',
      gitLabel: 'git: branch+task',
    });

    expect(layout.right).toContain('queued: 3');
    expect(
      getTerminalCellWidth(layout.left) + getTerminalCellWidth(layout.right) + 4,
    ).toBeLessThanOrEqual(getChromeContentWidth(cols));
  });
});

describe('InputFooter advisory display', () => {
  beforeEach(() => {
    eventsStore.__testReset();
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/diptych-test' });
    routerStore.init({ screen: 'workflow', feature: 'demo' });
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
  });

  afterEach(() => {
    eventsStore.__testReset();
    configStore.__testReset();
    routerStore.init({ screen: 'home' });
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
  });

  it('renders downgrade advisory text when advisory state is set', () => {
    const advisory = adviseMode('fix typo in footer', 'standard');
    publishAdvisory(advisory);

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('advisor:');
    expect(frame).toContain('instant');

    ui.unmount();
  });

  it('omits advisory text when the advisor has no displayable warning', () => {
    const advisory = adviseMode('add auth with JWT refresh tokens', 'speckit');
    publishAdvisory(advisory);

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('advisor:');

    ui.unmount();
  });

  it('does not duplicate cost information already shown in the cost status line', () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 24, isSmall: true });
    tasksStore.__testReset({ currentTask: 1, totalTasks: 4 });
    tokensStore.__testReset({
      localCount: 1,
      escalatedCount: 0,
      tokenUsage: {
        plannerInput: 1000,
        plannerOutput: 500,
        implementerInput: 2000,
        implementerOutput: 1000,
        escalationInput: 0,
        escalationOutput: 0,
      },
    });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Task 1/4');
    expect(frame).not.toContain('Local rate');
    expect(frame).not.toContain('Spent:');
    expect(frame).not.toContain('Saved:');

    ui.unmount();
  });

  it('renders multiple pending queue previews with context', () => {
    terminalSizeStore.__testReset({ cols: 140, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'planning',
      queueDepth: 2,
      queuePreviews: [
        { id: 'q1', preview: 'older preview' },
        { id: 'q2', preview: 'latest redacted preview' },
      ],
    });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('queued: 2 pending - older preview; latest redacted preview');

    ui.unmount();
  });

  it('summarizes older queue previews when more than two are pending', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'planning',
      queueDepth: 4,
      queuePreviews: [
        { id: 'q1', preview: 'first preview' },
        { id: 'q2', preview: 'second preview' },
        { id: 'q3', preview: 'third preview' },
        { id: 'q4', preview: 'fourth preview' },
      ],
    });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('queued: 4 pending - third preview; fourth preview, +2 older');
    expect(frame).not.toContain('first preview');
    expect(frame).not.toContain('second preview');

    ui.unmount();
  });
});
