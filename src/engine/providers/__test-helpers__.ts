import { beforeEach, afterEach, vi } from 'vitest';

export function setupFetchMock(): void {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });
}

export function setupEnvMock(key: string, value: string): void {
  let original: string | undefined;
  beforeEach(() => { original = process.env[key]; process.env[key] = value; });
  afterEach(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });
}
