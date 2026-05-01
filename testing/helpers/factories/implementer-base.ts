import { vi } from 'vitest';
import type { ImplementerBaseConfig } from '../../../src/engine/implementers/base.js';
import type { InvokeResult } from '../../../src/engine/runners/types.js';

export function makeBaseConfig(overrides?: Partial<ImplementerBaseConfig>): ImplementerBaseConfig {
  return {
    extractsCode: true,
    invoke: vi.fn<(opts: unknown) => Promise<InvokeResult>>().mockResolvedValue({
      text: '```ts\nconst x = 1;\n```',
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
    ...overrides,
  };
}
