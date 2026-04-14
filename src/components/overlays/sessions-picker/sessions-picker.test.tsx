import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import type { Session } from '../../../types.js';

const loadAll = vi.fn();
const overlayClose = vi.fn();
const routerNavigate = vi.fn();
const feedbackSetMessage = vi.fn();

vi.mock('../../../stores/sessions.js', () => ({
  sessionsStore: {
    loadAll,
    use: <T,>(selector: (state: { allSessions: [] }) => T) => selector({ allSessions: [] }),
  },
}));

vi.mock('../../../stores/config.js', () => ({
  configStore: {
    use: <T,>(selector: (state: { projectDir: string; config: { sessions: { scope: 'global' } } }) => T) =>
      selector({
        projectDir: '/tmp/project',
        config: { sessions: { scope: 'global' } },
      }),
  },
}));

vi.mock('../../../stores/overlay.js', () => ({
  overlayStore: { close: overlayClose },
}));

vi.mock('../../../stores/router.js', () => ({
  routerStore: { navigate: routerNavigate },
}));

vi.mock('../../../stores/feedback.js', () => ({
  feedbackStore: { setMessage: feedbackSetMessage },
}));

vi.mock('../../../ui/theme.js', () => ({
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

vi.mock('../../../stores/terminal-size.js', () => ({
  terminalSizeStore: { use: <T,>(selector: (state: { cols: number; rows: number; isSmall: boolean }) => T) => selector({ cols: 120, rows: 40, isSmall: false }) },
  getResponsivePanelWidth: () => 110,
}));

vi.mock('../../pickers/filterable-list.js', () => ({
  FilterableList: () => null,
}));

const makeSession = (overrides?: Partial<Session>): Session => ({
  id: 'sess-1',
  feature: 'add auth',
  startedAt: 1_700_000_000,
  completedAt: null,
  stateVersion: 1,
  stateFile: null,
  status: 'interrupted',
  summary: null,
  ...overrides,
} as Session);

describe('SessionsPicker', () => {
  afterEach(() => {
    loadAll.mockClear();
    overlayClose.mockClear();
    routerNavigate.mockClear();
    feedbackSetMessage.mockClear();
  });

  it('loads sessions using the configured scope', async () => {
    const { SessionsPicker } = await import('./sessions-picker.js');
    const instance = render(React.createElement(SessionsPicker), {
      stdout: new PassThrough() as unknown as NodeJS.WriteStream,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(loadAll).toHaveBeenCalledWith('global', '/tmp/project');
    instance.unmount();
  });

  describe('handleSelect', () => {
    it('navigates to workflow for interrupted sessions', async () => {
      const { handleSelectForTest } = await import('./sessions-picker.js');
      const session = makeSession({ status: 'interrupted', summary: null });

      handleSelectForTest(session);

      expect(overlayClose).toHaveBeenCalledOnce();
      expect(routerNavigate).toHaveBeenCalledWith('workflow', { feature: 'add auth' });
      expect(feedbackSetMessage).not.toHaveBeenCalled();
    });

    it('navigates to summary when session has a summary', async () => {
      const { handleSelectForTest } = await import('./sessions-picker.js');
      const summary = { totalCost: 0.5, totalSavings: 0.3, localCompletionRate: 60, durationMs: 10000, taskCount: 2, escalatedCount: 0, plannerTokens: { input: 100, output: 200 }, implementerTokens: { input: 50, output: 100 } };
      const session = makeSession({ status: 'complete', summary } as unknown as Session);

      handleSelectForTest(session);

      expect(overlayClose).toHaveBeenCalledOnce();
      expect(routerNavigate).toHaveBeenCalledWith('summary', { summary });
      expect(feedbackSetMessage).not.toHaveBeenCalled();
    });

    it('shows feedback and keeps overlay open for failed sessions without a summary', async () => {
      const { handleSelectForTest } = await import('./sessions-picker.js');
      const session = makeSession({ status: 'failed', summary: null });

      handleSelectForTest(session);

      expect(overlayClose).not.toHaveBeenCalled();
      expect(routerNavigate).not.toHaveBeenCalled();
      expect(feedbackSetMessage).toHaveBeenCalledWith(
        expect.stringContaining('add auth'),
      );
    });
  });
});
