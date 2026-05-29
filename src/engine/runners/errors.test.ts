import { describe, expect, test } from 'vitest';
import { runnerConfigError } from './errors.js';

describe('runnerConfigError factories', () => {
  test('invalidKind records kind + role', () => {
    const err = runnerConfigError.invalidKind('weird', 'planner');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('runner-invalid-kind');
    expect(err.message).toBe('Unknown planner kind: weird');
    expect(err.data).toEqual({ kind: 'weird', role: 'planner' });
  });

  test('kindMismatch records expected + actual + role', () => {
    const err = runnerConfigError.kindMismatch('cli', 'api', 'implementer');
    expect(err.kind).toBe('runner-kind-mismatch');
    expect(err.message).toContain('IMPLEMENTER');
    expect(err.message).toContain("'cli'");
    expect(err.message).toContain("'api'");
    expect(err.data).toEqual({ expected: 'cli', actual: 'api', role: 'implementer' });
  });

  test('missingToolConfig formats planner vs implementer differently', () => {
    const planner = runnerConfigError.missingToolConfig('claude-code', 'planner');
    expect(planner.message).toBe("CLI tool 'claude-code' has no planner configuration");
    expect(planner.data).toEqual({ toolName: 'claude-code', role: 'planner' });

    const implementer = runnerConfigError.missingToolConfig('aider', 'implementer');
    expect(implementer.message).toBe('Tool aider has no implementer buildArgs in CLI_TOOLS');
    expect(implementer.data).toEqual({ toolName: 'aider', role: 'implementer' });
  });
});
