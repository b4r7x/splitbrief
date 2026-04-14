import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn<(p: string) => boolean>();
const isGitRepoMock = vi.fn<(p: string) => Promise<boolean>>();
const initConfigMock = vi.fn();
const configPathMock = vi.fn<(p: string) => string>((p) => `${p}/.diptych/config.yml`);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => existsSyncMock(p) };
});
vi.mock('../utils/git.js', () => ({ isGitRepo: (p: string) => isGitRepoMock(p) }));
vi.mock('../core/config/index.js', () => ({
  loadConfig: vi.fn(),
  initConfig: () => initConfigMock(),
  configPath: (p: string) => configPathMock(p),
}));

const { setupWorkflow } = await import('./workflow.js');

describe('setupWorkflow', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    isGitRepoMock.mockReset();
    initConfigMock.mockReset();
    isGitRepoMock.mockResolvedValue(true);
  });

  describe('when config exists', () => {
    beforeEach(() => {
      existsSyncMock.mockReturnValue(true);
    });

    it('returns needsSetup=undefined when no overrides', async () => {
      const result = await setupWorkflow({ fullscreen: false });
      expect(result.needsSetup).toBeUndefined();
    });

    it('never calls initConfig when config already exists', async () => {
      await setupWorkflow({ fullscreen: false });
      expect(initConfigMock).not.toHaveBeenCalled();
    });
  });

  describe('when config does not exist', () => {
    beforeEach(() => {
      existsSyncMock.mockReturnValue(false);
    });

    it('returns needsSetup=true when no runner overrides', async () => {
      const result = await setupWorkflow({ fullscreen: false });
      expect(result.needsSetup).toBe(true);
    });

    it('skips setup when runner overrides are provided', async () => {
      const result = await setupWorkflow({ planner: 'claude-code', fullscreen: false });
      expect(result.needsSetup).toBeUndefined();
    });

    it('skips setup when implementer override is provided', async () => {
      const result = await setupWorkflow({ implementer: 'ollama', fullscreen: false });
      expect(result.needsSetup).toBeUndefined();
    });

    it('does NOT skip setup when only --mode is provided (not a runner override)', async () => {
      const result = await setupWorkflow({ mode: 'quick', fullscreen: false });
      expect(result.needsSetup).toBe(true);
    });

    it('does NOT skip setup when only --auto is provided (not a runner override)', async () => {
      const result = await setupWorkflow({ auto: true, fullscreen: false });
      expect(result.needsSetup).toBe(true);
    });

    it('does NOT skip setup when only --budget is provided (not a runner override)', async () => {
      const result = await setupWorkflow({ budget: 5, fullscreen: false });
      expect(result.needsSetup).toBe(true);
    });

    it('calls initConfig in all branches', async () => {
      await setupWorkflow({ fullscreen: false });
      expect(initConfigMock).toHaveBeenCalledOnce();
    });
  });
});
