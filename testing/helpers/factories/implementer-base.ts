import { vi } from 'vitest';
import type { ImplementerBaseConfig } from '../../../src/engine/implementers/pipeline/run.js';
import { makeRunnerCallResult } from './runner-call.js';

export function makeBaseConfig(overrides?: Partial<ImplementerBaseConfig>): ImplementerBaseConfig {
  return {
    extractsCode: true,
    invoke: vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nconst x = 1;\n```',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    ),
    ...overrides,
  };
}
