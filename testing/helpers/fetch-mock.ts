import { beforeEach, afterEach, vi } from 'vitest';

export function setupFetchMock(): void {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
