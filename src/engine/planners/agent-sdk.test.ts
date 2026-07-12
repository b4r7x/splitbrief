import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunnerCallEvent } from '../calls/types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createAgentSdkPlanner } from './agent-sdk.js';

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: unknown) => queryMock(opts),
}));

let projectDir: string;

beforeEach(() => {
  queryMock.mockReset();
  projectDir = createTempDir('agent-sdk-planner');
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createAgentSdkPlanner', () => {
  it('threads a configured idleWarnMs override into the SDK backend', async () => {
    queryMock.mockImplementationOnce(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      await new Promise((resolve) => setTimeout(resolve, 150));
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'slow response' }] },
      };
      yield {
        type: 'result',
        result: 'slow response',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    const events: RunnerCallEvent[] = [];
    const planner = createAgentSdkPlanner({ idleWarnMs: 30 });

    const result = await planner.review('prompt', projectDir, {
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    expect(result.text).toContain('slow response');
    expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
  });
});
