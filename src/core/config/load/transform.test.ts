import { describe, it, expect } from 'vitest';
import { toYaml } from './transform.js';

describe('toYaml', () => {
  it('converts camelCase to snake_case in output', () => {
    const obj = {
      workflow: { maxRetries: 3, persistTranscript: false, git: { commitStrategy: 'per-task' } },
    };
    const result = toYaml(obj);
    const workflow = result.workflow as Record<string, unknown>;
    expect(workflow.max_retries).toBe(3);
    expect(workflow.persist_transcript).toBe(false);
    expect((workflow.git as Record<string, unknown>).commit_strategy).toBe('per-task');
    expect(workflow.maxRetries).toBeUndefined();
  });
});
