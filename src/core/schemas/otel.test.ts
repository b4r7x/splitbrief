import { describe, it, expect } from 'vitest';
import { OtelConfigSchema } from './otel.js';

describe('OtelConfigSchema', () => {
  it('defaults enabled to false and serviceName to diptych', () => {
    const result = OtelConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.serviceName).toBe('diptych');
  });

  it('accepts enabled: true with custom serviceName', () => {
    const result = OtelConfigSchema.parse({ enabled: true, serviceName: 'my-service' });
    expect(result.enabled).toBe(true);
    expect(result.serviceName).toBe('my-service');
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => OtelConfigSchema.parse({ enabled: false, unknown: 'x' })).toThrow();
  });
});
