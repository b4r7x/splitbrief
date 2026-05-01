import { describe, it, expect } from 'vitest';
import { OtelConfigSchema } from './otel.js';

describe('OtelConfigSchema', () => {
  it('defaults enabled to false and serviceName to diptych', () => {
    const result = OtelConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.serviceName).toBe('diptych');
  });
});
