import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, createDefaultConfig } from '../src/config.js';

describe('validateConfig', () => {
  it('returns no errors for valid default config', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    const errors = validateConfig(config);
    assert.equal(errors.length, 0);
  });

  it('rejects invalid provider', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.provider = 'invalid-provider';
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'implementer.provider');
    assert.ok(errors[0].message.includes('invalid-provider'));
  });

  it('rejects non-number temperature', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.temperature = 'hot';
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'implementer.temperature');
  });

  it('rejects temperature out of range', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.temperature = 3;
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'implementer.temperature');
  });

  it('rejects negative maxRetries', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).workflow.maxRetries = -1;
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'workflow.maxRetries');
  });

  it('rejects non-boolean validation fields', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).validation.typecheck = 'yes';
    (config as any).workflow.commitPerTask = 1;
    const errors = validateConfig(config);
    assert.equal(errors.length, 2);
    const paths = errors.map((e) => e.path);
    assert.ok(paths.includes('validation.typecheck'));
    assert.ok(paths.includes('workflow.commitPerTask'));
  });

  it('collects multiple errors at once', () => {
    const config = createDefaultConfig() as unknown as Record<string, unknown>;
    (config as any).implementer.provider = 'bad';
    (config as any).implementer.model = '';
    (config as any).workflow.maxRetries = -5;
    const errors = validateConfig(config);
    assert.equal(errors.length, 3);
  });
});
