import { describe, expect, test } from 'vitest';
import { runnerConfigError } from './errors.js';

describe('runnerConfigError factories', () => {
  test('missingToolConfig formats planner vs implementer differently', () => {
    const planner = runnerConfigError.missingToolConfig('claude-code', 'planner');
    expect(planner.message).toBe("CLI tool 'claude-code' has no planner configuration");
    expect(planner.data).toEqual({ toolName: 'claude-code', role: 'planner' });

    const implementer = runnerConfigError.missingToolConfig('aider', 'implementer');
    expect(implementer.message).toBe('Tool aider has no implementer buildArgs in CLI_TOOLS');
    expect(implementer.data).toEqual({ toolName: 'aider', role: 'implementer' });
  });
});
