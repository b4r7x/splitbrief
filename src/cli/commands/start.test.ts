import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const readActiveMock = vi.fn<(dir: string) => string | null>();
const isSessionLiveMock = vi.fn<(dir: string, id: string) => boolean>();
const beginSessionMock = vi.fn<(dir: string, feature: string) => string>();
const setupWorkflowMock = vi.fn();
const initStoresMock = vi.fn();
const renderAppMock = vi.fn();

const clearActiveMock = vi.fn<(dir: string) => void>();
vi.mock('../../core/sessions/active.js', () => ({
  readActive: (dir: string) => readActiveMock(dir),
  isSessionLive: (dir: string, id: string) => isSessionLiveMock(dir, id),
  clearActive: (dir: string) => clearActiveMock(dir),
}));
vi.mock('../../core/sessions/begin.js', () => ({
  beginSession: (dir: string, feature: string) => beginSessionMock(dir, feature),
}));
vi.mock('../workflow.js', () => ({
  addWorkflowOptions: (cmd: Command) => cmd,
  setupWorkflow: (opts: unknown) => setupWorkflowMock(opts),
  resolveProjectDir: () => '/cwd',
}));
vi.mock('./migrate.js', () => ({ maybeMigrate: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../init-stores.js', () => ({ initStores: (dir: string, opts: unknown) => initStoresMock(dir, opts) }));
vi.mock('../../app.js', () => ({ App: vi.fn() }));
vi.mock('../render.js', () => ({ renderApp: (el: unknown, fs: unknown) => renderAppMock(el, fs) }));
vi.mock('../../stores/navigation/router.js', () => ({ routerStore: { init: vi.fn() } }));

const { registerStartCommand } = await import('./start.js');

async function runStart(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStartCommand(program);
  await program.parseAsync(['node', 'diptych', 'start', ...args]);
}

describe('start command — concurrency lock', () => {
  beforeEach(() => {
    readActiveMock.mockReset();
    isSessionLiveMock.mockReset();
    clearActiveMock.mockReset();
    beginSessionMock.mockReset();
    setupWorkflowMock.mockReset();
    initStoresMock.mockReset();
    renderAppMock.mockReset();

    readActiveMock.mockReturnValue(null);
    isSessionLiveMock.mockReturnValue(false);
    beginSessionMock.mockReturnValue('2024-01-01-add-auth');
    setupWorkflowMock.mockResolvedValue({ projectDir: '/cwd', useFullscreen: false, useMouse: false, needsSetup: false });
    initStoresMock.mockResolvedValue(undefined);
    renderAppMock.mockResolvedValue(undefined);
  });

  it('blocks when a live session is active', async () => {
    readActiveMock.mockReturnValue('2024-01-01-add-auth');
    isSessionLiveMock.mockReturnValue(true);

    await expect(runStart(['add auth'])).rejects.toThrow(/still active/);
    expect(clearActiveMock).not.toHaveBeenCalled();
    expect(renderAppMock).not.toHaveBeenCalled();
  });

  it('clears stale session and proceeds when active file exists but session is not live', async () => {
    readActiveMock.mockReturnValue('2024-01-01-my-feature');
    isSessionLiveMock.mockReturnValue(false);

    await runStart(['some feature']);
    expect(clearActiveMock).toHaveBeenCalledWith('/cwd');
    expect(renderAppMock).toHaveBeenCalled();
  });

  it('proceeds silently when there is no active session file', async () => {
    readActiveMock.mockReturnValue(null);

    await runStart(['new feature']);
    expect(clearActiveMock).not.toHaveBeenCalled();
    expect(renderAppMock).toHaveBeenCalled();
  });

});
