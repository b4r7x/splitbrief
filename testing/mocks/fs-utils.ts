import { vi } from 'vitest';

export function createMockFsUtils(overrides?: Partial<{
  ensureTinySpecDir: ReturnType<typeof vi.fn>;
  writeSpecFile: ReturnType<typeof vi.fn>;
  readSpecFile: ReturnType<typeof vi.fn>;
  validateTaskPath: ReturnType<typeof vi.fn>;
  readFileOrEmpty: ReturnType<typeof vi.fn>;
}>) {
  return {
    ensureTinySpecDir: vi.fn(),
    writeSpecFile: vi.fn(),
    readSpecFile: vi.fn().mockReturnValue(null),
    validateTaskPath: vi.fn().mockImplementation((_dir: string, filePath: string) => filePath),
    readFileOrEmpty: vi.fn().mockReturnValue(''),
    ...overrides,
  };
}
