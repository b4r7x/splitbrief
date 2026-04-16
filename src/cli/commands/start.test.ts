import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const readActiveMock = vi.fn<(dir: string) => string | null>();
const writeActiveMock = vi.fn<(dir: string, id: string) => void>();
const isSessionLiveMock = vi.fn<(dir: string, id: string) => boolean>();
const generateSessionIdMock = vi.fn<(dir: string, feature: string) => string>();
const setupWorkflowMock = vi.fn();
const initStoresMock = vi.fn();
const renderAppMock = vi.fn();

const clearActiveMock = vi.fn<(dir: string) => void>();
vi.mock('../../core/sessions/active.js', () => ({
  readActive: (dir: string) => readActiveMock(dir),
  writeActive: (dir: string, id: string) => writeActiveMock(dir, id),
  isSessionLive: (dir: string, id: string) => isSessionLiveMock(dir, id),
  clearActive: (dir: string) => clearActiveMock(dir),
}));
vi.mock('../../core/sessions/id.js', () => ({
  generateSessionId: (dir: string, feature: string) => generateSessionIdMock(dir, feature),
}));
vi.mock('../../core/paths.js', () => ({
  sessionDir: vi.fn().mockReturnValue('/tmp/session'),
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
vi.mock('../../stores/router.js', () => ({ routerStore: { init: vi.fn() } }));
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));

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
    writeActiveMock.mockReset();
    isSessionLiveMock.mockReset();
    clearActiveMock.mockReset();
    generateSessionIdMock.mockReset();
    setupWorkflowMock.mockReset();
    initStoresMock.mockReset();
    renderAppMock.mockReset();

    readActiveMock.mockReturnValue(null);
    isSessionLiveMock.mockReturnValue(false);
    generateSessionIdMock.mockReturnValue('2024-01-01-add-auth');
    setupWorkflowMock.mockResolvedValue({ projectDir: '/cwd', useFullscreen: false, useMouse: false, needsSetup: false });
    initStoresMock.mockResolvedValue(undefined);
    renderAppMock.mockResolvedValue(undefined);
  });

  it('clears stale active session and proceeds', async () => {
    readActiveMock.mockReturnValue('2024-01-01-add-auth');
    isSessionLiveMock.mockReturnValue(true);

    await runStart(['add auth']);
    expect(clearActiveMock).toHaveBeenCalled();
    expect(renderAppMock).toHaveBeenCalled();
  });

  it('clears the correct session id when stale', async () => {
    readActiveMock.mockReturnValue('2024-01-01-my-feature');
    isSessionLiveMock.mockReturnValue(true);

    await runStart(['some feature']);
    expect(clearActiveMock).toHaveBeenCalledWith('/cwd');
  });

  it('proceeds when active file exists but session is not live (crashed / stale)', async () => {
    readActiveMock.mockReturnValue('2024-01-01-old-session');
    isSessionLiveMock.mockReturnValue(false);

    await runStart(['new feature']);
    expect(renderAppMock).toHaveBeenCalled();
  });

  it('proceeds when there is no active session', async () => {
    readActiveMock.mockReturnValue(null);

    await runStart(['add auth']);
    expect(renderAppMock).toHaveBeenCalled();
  });
});
