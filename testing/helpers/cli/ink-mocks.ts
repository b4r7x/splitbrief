import { vi } from 'vitest';

vi.mock('../../../src/cli/render/app.js', () => ({
  renderApp: vi.fn(async () => {}),
}));
