import { describe, expect, it } from 'vitest';
import { goStack } from './go.js';

describe('goStack', () => {
  it('declares go.mod, the test command and package-arg narrowing', () => {
    expect(goStack.markers).toEqual(['go.mod']);
    expect(goStack.test('/anywhere')).toBe('go test ./...');
    expect(goStack.testFilePatterns).toEqual(['*_test.go']);
    expect(goStack.narrowing).toEqual({ kind: 'package-arg' });
  });
});
