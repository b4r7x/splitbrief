import { describe, expect, it } from 'vitest';
import { rustStack } from './rust.js';

describe('rustStack', () => {
  it('rust: inlineTests matches #[cfg(test)]', () => {
    expect(rustStack.inlineTests?.test('#[cfg(test)]\nmod tests {}')).toBe(true);
    expect(rustStack.inlineTests?.test('fn main() {}')).toBe(false);
  });

  it('rust: the test command is a constant', () => {
    expect(rustStack.test('/anywhere')).toBe('cargo test');
  });

  it('declares Cargo.toml, the integration test pattern and cargo-target narrowing', () => {
    expect(rustStack.markers).toEqual(['Cargo.toml']);
    expect(rustStack.testFilePatterns).toEqual(['tests/*.rs']);
    expect(rustStack.narrowing).toEqual({ kind: 'cargo-target' });
    expect(rustStack.allowedCommands).toEqual(['cargo']);
  });
});
