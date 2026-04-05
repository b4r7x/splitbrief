import { vi } from 'vitest';

export function mockPlannerBase() {
  return {
    createPlannerBase: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
      name: config.name,
      conversational: config.conversational ?? false,
      plan: vi.fn(),
      regenerate: vi.fn(),
      escalateHint: vi.fn(),
      escalateFull: vi.fn(),
      isAvailable: config.isAvailable,
      getVersion: config.getVersion,
      getPricing: vi.fn(),
      _config: config,
    })),
    createIsAvailable: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(false)),
    createGetVersion: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(null)),
  };
}
