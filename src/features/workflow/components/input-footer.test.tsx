import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import { makeConfig } from '../../../../testing/helpers/factories/config.js';
import {
  adviseMode,
  setAdvisory,
  __resetAdvisoryForTests,
} from '../../../engine/orchestrator/planning/mode-advisor.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { InputFooter } from './input-footer.js';

describe('InputFooter advisory display', () => {
  beforeEach(() => {
    __resetAdvisoryForTests();
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/diptych-test' });
    routerStore.init({ screen: 'workflow', feature: 'demo' });
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
  });

  afterEach(() => {
    __resetAdvisoryForTests();
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
});
