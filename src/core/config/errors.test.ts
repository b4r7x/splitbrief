import { describe, expect, test } from 'vitest';
import { configError } from './errors.js';

describe('configError factories', () => {
  test('invalidYaml carries path and cause', () => {
    const cause = new Error('unexpected token');
    const err = configError.invalidYaml('/tmp/config.yaml', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('config-invalid-yaml');
    expect(err.message).toContain('/tmp/config.yaml');
    expect(err.data).toEqual({ path: '/tmp/config.yaml' });
    expect(err.cause).toBe(cause);
  });

  test('validationFailed joins issues into message', () => {
    const issues = ['planner.model required', 'implementer.apiBase required'];
    const err = configError.validationFailed('/tmp/config.yaml', issues);
    expect(err.kind).toBe('config-validation-failed');
    expect(err.message).toBe('planner.model required\nimplementer.apiBase required');
    expect(err.data).toEqual({ path: '/tmp/config.yaml', issues });
  });

  test('loadNotCalled names the operation', () => {
    const err = configError.loadNotCalled('useConfig');
    expect(err.kind).toBe('config-load-not-called');
    expect(err.message).toContain('useConfig');
    expect(err.data).toEqual({ operation: 'useConfig' });
  });

  test('saveFailed threads cause', () => {
    const cause = new Error('EACCES');
    const err = configError.saveFailed('/tmp/config.yaml', cause);
    expect(err.kind).toBe('config-save-failed');
    expect(err.cause).toBe(cause);
    expect(err.data).toEqual({ path: '/tmp/config.yaml' });
  });

  test('notAnObject records context', () => {
    const err = configError.notAnObject('root');
    expect(err.kind).toBe('config-not-an-object');
    expect(err.message).toBe('root must be an object');
    expect(err.data).toEqual({ context: 'root' });
  });

  test('unsupportedVersion stringifies unknown version', () => {
    const err = configError.unsupportedVersion(9);
    expect(err.kind).toBe('config-unsupported-version');
    expect(err.message).toContain('9');
    expect(err.message).toContain('Expected 2 or 3');
    expect(err.data).toEqual({ version: 9 });
  });

  test('runnerKindIndeterminate serializes opts', () => {
    const opts = { foo: 'bar' };
    const err = configError.runnerKindIndeterminate('planner', opts);
    expect(err.kind).toBe('config-runner-kind-indeterminate');
    expect(err.message).toContain('planner');
    expect(err.message).toContain('"foo":"bar"');
    expect(err.data).toEqual({ role: 'planner', opts });
  });

  test('runnerKindIndeterminate redacts secret-like fields recursively', () => {
    const err = configError.runnerKindIndeterminate('planner', {
      apiKey: 'sk-ant-secret',
      nested: {
        token: 'session-token',
        safe: 'visible',
      },
      items: [{ clientSecret: 'client-secret' }],
    });

    expect(err.message).toContain('"apiKey":"[REDACTED]"');
    expect(err.message).toContain('"token":"[REDACTED]"');
    expect(err.message).toContain('"clientSecret":"[REDACTED]"');
    expect(err.message).toContain('"safe":"visible"');
    expect(err.message).not.toContain('sk-ant-secret');
    expect(err.message).not.toContain('session-token');
    expect(err.message).not.toContain('client-secret');
    expect(err.data).toEqual({
      role: 'planner',
      opts: {
        apiKey: '[REDACTED]',
        nested: { token: '[REDACTED]', safe: 'visible' },
        items: [{ clientSecret: '[REDACTED]' }],
      },
    });
  });

  test('runnerMissingField records role, kind, field', () => {
    const err = configError.runnerMissingField('implementer', 'api', 'apiBase');
    expect(err.kind).toBe('config-runner-missing-field');
    expect(err.data).toEqual({ role: 'implementer', kind: 'api', field: 'apiBase' });
  });

  test('runnerMissingModel records role', () => {
    const err = configError.runnerMissingModel('implementer');
    expect(err.kind).toBe('config-runner-missing-model');
    expect(err.data).toEqual({ role: 'implementer' });
  });

  test('unknownCliTool lists allowed tools', () => {
    const allowed = ['claude-code', 'codex'];
    const err = configError.unknownCliTool('made-up', allowed);
    expect(err.kind).toBe('config-unknown-cli-tool');
    expect(err.message).toContain('claude-code, codex');
    expect(err.data).toEqual({ tool: 'made-up', allowed });
  });

  test('unknownProvider includes optional role', () => {
    const err = configError.unknownProvider('bogus', ['ollama'], 'planner');
    expect(err.kind).toBe('config-unknown-provider');
    expect(err.message).toContain('planner: ');
    expect(err.data).toEqual({ provider: 'bogus', allowed: ['ollama'], role: 'planner' });
  });

  test('invalidOverride includes field/value/reason', () => {
    const err = configError.invalidOverride('temperature', 'hot', 'must be a number');
    expect(err.kind).toBe('config-invalid-override');
    expect(err.message).toContain('temperature');
    expect(err.message).toContain('hot');
    expect(err.data).toEqual({ field: 'temperature', value: 'hot', reason: 'must be a number' });
  });
});

describe('configError predicates', () => {
  test('isInvalidYaml matches matching kind', () => {
    expect(configError.isInvalidYaml(configError.invalidYaml('/p', new Error('x')))).toBe(true);
    expect(configError.isInvalidYaml(configError.notAnObject('root'))).toBe(false);
    expect(configError.isInvalidYaml(new Error('plain'))).toBe(false);
    expect(configError.isInvalidYaml(null)).toBe(false);
  });

  test('predicates narrow type for data access', () => {
    const err: unknown = configError.runnerMissingField('planner', 'api', 'apiBase');
    if (configError.isRunnerMissingField(err)) {
      expect(err.data).toEqual({ role: 'planner', kind: 'api', field: 'apiBase' });
    } else {
      throw new Error('predicate should match');
    }
  });

  test('each predicate rejects a non-matching factory', () => {
    expect(configError.isValidationFailed(configError.invalidYaml('/p', new Error()))).toBe(false);
    expect(configError.isLoadNotCalled(configError.saveFailed('/p', new Error()))).toBe(false);
    expect(configError.isUnknownProvider(configError.unknownCliTool('x', []))).toBe(false);
  });
});
