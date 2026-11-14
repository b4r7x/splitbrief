import { describe, expect, it } from 'vitest';
import { boundRunnerCallToolUse } from './bounded-payload.js';

describe('boundRunnerCallToolUse', () => {
  it('names a tool call output past its byte limit', () => {
    const bounded = boundRunnerCallToolUse({
      id: 'tool-1',
      name: 'read',
      input: {},
      output: 'y'.repeat(300 * 1024),
    });

    expect(bounded.limit).toMatchObject({
      code: 'runner_call_tool_output_limit',
      message: 'A tool call output was larger than 256 KB and was not kept in full.',
    });
  });
});
