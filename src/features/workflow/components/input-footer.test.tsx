import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import { makeConfig } from '../../../../testing/helpers/factories/config.js';
import {
  adviseMode,
  setAdvisory,
} from '../../../engine/orchestrator/planning/mode-advisor.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { buildInputFooterLayout, InputFooter } from './input-footer.js';

describe('buildInputFooterLayout', () => {
  it('keeps narrow footers focused on controls and task progress', () => {
    const layout = buildInputFooterLayout({
      cols: 44,
      isAttachedClient: false,
      advisoryText: 'advisor: likely instant · trivial edit',
      taskText: 'Task 2/8',
      queueText: 'queue: 3',
      gitLabel: 'git: branch+task',
    });

    expect(layout.left).toBe('Ctrl+C abort');
    expect(layout.right).toBe('Task 2/8');
  });

  it('keeps wide footers split between left controls and right status', () => {
    const layout = buildInputFooterLayout({
      cols: 120,
      isAttachedClient: false,
      advisoryText: 'advisor: likely instant · trivial edit',
      taskText: 'Task 2/8 · 4m left',
      queueText: 'queue: 3',
      gitLabel: 'git: branch+task',
    });

    expect(layout.left).toContain('Ctrl+C abort');
    expect(layout.left).toContain('Ctrl+C again exit');
    expect(layout.left).toContain('advisor:');
    expect(layout.right).toBe('Task 2/8 · 4m left · queue: 3 · git: branch+task');
  });
});

describe('InputFooter advisory display', () => {
  beforeEach(() => {
    setAdvisory(null);
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/diptych-test' });
    routerStore.init({ screen: 'workflow', feature: 'demo' });
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
  });

  afterEach(() => {
    setAdvisory(null);
    configStore.__testReset();
    routerStore.init({ screen: 'home' });
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
  });

  it('renders downgrade advisory text when advisory state is set', () => {
    const advisory = adviseMode('fix typo in footer', 'standard');
    setAdvisory(advisory.kind !== 'none' ? advisory : null);

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('advisor:');
    expect(frame).toContain('instant');

    ui.unmount();
  });

  it('omits advisory text when the advisor has no displayable warning', () => {
    const advisory = adviseMode('add auth with JWT refresh tokens', 'speckit');
    setAdvisory(advisory.kind !== 'none' ? advisory : null);

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
});
