import { vi } from 'vitest';

export function createMockStatePersistence(overrides?: Partial<{
  saveState: ReturnType<typeof vi.fn>;
  loadState: ReturnType<typeof vi.fn>;
  appendEvent: ReturnType<typeof vi.fn>;
}>) {
  return {
    saveState: vi.fn(),
    loadState: vi.fn().mockReturnValue(null),
    appendEvent: vi.fn(),
    ...overrides,
  };
}
