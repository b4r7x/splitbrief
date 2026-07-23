import { describe, it, expect } from 'vitest';
import { toYaml } from './transform.js';

describe('toYaml', () => {
  it('converts camelCase to snake_case in output', () => {
    const obj = {
      workflow: { maxRetries: 3, commitStrategy: 'per-task', autoApproveSpec: false },
    };
    const result = toYaml(obj);
    const workflow = result.workflow as Record<string, unknown>;
    expect(workflow.max_retries).toBe(3);
    expect(workflow.commit_strategy).toBe('per-task');
    expect(workflow.auto_approve_spec).toBe(false);
    expect(workflow.maxRetries).toBeUndefined();
  });
});
