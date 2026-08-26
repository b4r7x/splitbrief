import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../stores/project/config.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { Router } from './router.js';

function renderRouter() {
  return renderFeature(
    <Router
      screen="home"
      overlayActive={overlayStore.get().active}
      commands={[]}
      onRuntime={() => {}}
      copyTarget={async () => 'empty'}
    />,
  );
}

describe('Router overlays', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 100, rows: 40 });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders the reviewer picker for the reviewer-picker overlay', async () => {
    overlayStore.open('reviewer-picker');
    const ui = renderRouter();
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    expect(frame).toContain('Reviewer');
  });
});
