import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { makeSession, makeSummary } from '#testing/helpers/fixtures.js';

const loadAll = vi.fn();
const overlayClose = vi.fn();
const routerNavigate = vi.fn();
const feedbackSetMessage = vi.fn();

const sessionsState = { allSessions: [] as unknown[] };
vi.mock('../../stores/project/sessions.js', () => ({
  sessionsStore: {
    loadAll,
    use: <T,>(selector: (state: typeof sessionsState) => T) => selector(sessionsState),
    get: () => sessionsState,
    subscribe: () => () => {},
  },
}));

const configState = {
  projectDir: '/tmp/project',
  config: { sessions: { scope: 'global' } },
};
vi.mock('../../stores/project/config.js', () => ({
  configStore: {
    use: <T,>(selector: (state: typeof configState) => T) => selector(configState),
    get: () => configState,
    subscribe: () => () => {},
  },
}));

vi.mock('../../stores/ui/overlay.js', () => ({
  overlayStore: { close: overlayClose },
}));

vi.mock('../../stores/navigation/router.js', () => ({
  routerStore: { navigate: routerNavigate },
}));

vi.mock('../../stores/ui/feedback.js', () => ({
  feedbackStore: { setMessage: feedbackSetMessage },
}));

vi.mock('../../components/theme.js', () => ({
  useTheme: () => ({
    accent: 'cyan',
    text: 'white',
    textDim: 'gray',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    implementer: 'green',
    planner: 'blue',
    border: 'gray',
  }),
}));

const terminalState = { cols: 120, rows: 40, isSmall: false };
vi.mock('../../stores/ui/terminal-size.js', () => ({
  terminalSizeStore: {
    use: <T,>(selector: (state: typeof terminalState) => T) => selector(terminalState),
    get: () => terminalState,
    subscribe: () => () => {},
  },
}));
vi.mock('../../core/layout/terminal-width.js', () => ({
  getResponsivePanelWidth: () => 110,
  getClampedTerminalWidth: () => 110,
}));

vi.mock('../../components/pickers/filterable-list.js', () => ({
  FilterableList: () => null,
}));

describe('SessionsPicker', () => {
  afterEach(() => {
    loadAll.mockClear();
    overlayClose.mockClear();
    routerNavigate.mockClear();
    feedbackSetMessage.mockClear();
  });

  it('loads sessions using the configured scope', async () => {
    const { SessionsPicker } = await import('./picker.js');
    const instance = render(React.createElement(SessionsPicker), {
      stdout: new PassThrough() as unknown as NodeJS.WriteStream,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(loadAll).toHaveBeenCalledWith('/tmp/project');
    instance.unmount();
  });

  describe('handleSelect', () => {
    it('navigates to workflow for interrupted sessions', async () => {
      const { handleSelect: handleSelectForTest } = await import('./picker-select.js');
      const session = makeSession({ feature: 'add auth', status: 'interrupted', summary: null });

      handleSelectForTest(session);

      expect(overlayClose).toHaveBeenCalledOnce();
      expect(routerNavigate).toHaveBeenCalledWith({ to: 'workflow', feature: 'add auth' });
      expect(feedbackSetMessage).not.toHaveBeenCalled();
    });

    it('navigates to summary when session has a summary', async () => {
      const { handleSelect: handleSelectForTest } = await import('./picker-select.js');
      const summary = makeSummary();
      const session = makeSession({ status: 'complete', summary });

      handleSelectForTest(session);

      expect(overlayClose).toHaveBeenCalledOnce();
      expect(routerNavigate).toHaveBeenCalledWith({ to: 'summary', summary });
      expect(feedbackSetMessage).not.toHaveBeenCalled();
    });

    it('shows feedback and keeps overlay open for failed sessions without a summary', async () => {
      const { handleSelect: handleSelectForTest } = await import('./picker-select.js');
      const session = makeSession({ feature: 'add auth', status: 'failed', summary: null });

      handleSelectForTest(session);

      expect(overlayClose).not.toHaveBeenCalled();
      expect(routerNavigate).not.toHaveBeenCalled();
      expect(feedbackSetMessage).toHaveBeenCalledWith(
        expect.stringContaining('add auth'),
      );
    });
  });
});
