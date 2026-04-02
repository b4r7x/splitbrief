import { vi } from 'vitest';

export function createMockGit(overrides?: Partial<{
  getGit: ReturnType<typeof vi.fn>;
  isGitRepo: ReturnType<typeof vi.fn>;
  commitChanges: ReturnType<typeof vi.fn>;
  getCurrentDiff: ReturnType<typeof vi.fn>;
  hasExternalChanges: ReturnType<typeof vi.fn>;
  discardTaskChanges: ReturnType<typeof vi.fn>;
}>) {
  return {
    getGit: vi.fn().mockReturnValue({}),
    isGitRepo: vi.fn().mockResolvedValue(true),
    commitChanges: vi.fn().mockResolvedValue('abc1234'),
    getCurrentDiff: vi.fn().mockResolvedValue(''),
    hasExternalChanges: vi.fn().mockResolvedValue(false),
    discardTaskChanges: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
