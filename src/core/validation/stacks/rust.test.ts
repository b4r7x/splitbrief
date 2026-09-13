import { describe, expect, it } from 'vitest';
import { rustStack } from './rust.js';

describe('rustStack', () => {
  it('rust: inlineTests matches #[cfg(test)]', () => {
    expect(rustStack.inlineTests?.test('#[cfg(test)]\nmod tests {}')).toBe(true);
    expect(rustStack.inlineTests?.test('fn main() {}')).toBe(false);
  });

  it('rust: cargo commands are constants', () => {
    expect(rustStack.typecheck('/anywhere')).toBe('cargo check');
    expect(rustStack.lint('/anywhere')).toBe('cargo clippy --no-deps');
    expect(rustStack.test('/anywhere')).toBe('cargo test');
  });

  it('rust: missingSubcommand is exit 101 with a no-such-command stderr', () => {
    expect(rustStack.missingSubcommand?.exitCode).toBe(101);
    expect(rustStack.missingSubcommand?.stderr.test('error: no such command: `clippy`')).toBe(true);
  });

  it('declares Cargo.toml, no test file patterns and name-filter narrowing', () => {
    expect(rustStack.markers).toEqual(['Cargo.toml']);
    expect(rustStack.testFilePatterns).toEqual([]);
    expect(rustStack.narrowing).toEqual({ kind: 'name-filter', flag: '--' });
    expect(rustStack.allowedCommands).toEqual(['cargo']);
  });
});
