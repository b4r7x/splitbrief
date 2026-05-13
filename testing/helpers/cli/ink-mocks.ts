import { vi } from 'vitest';

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: () => ({
      waitUntilExit: async () => {},
      unmount: () => {},
      clear: () => {},
      rerender: () => {},
      cleanup: () => {},
    }),
  };
});

vi.mock('fullscreen-ink', () => ({
  withFullScreen: () => ({ start: async () => {}, waitUntilExit: async () => {} }),
}));
