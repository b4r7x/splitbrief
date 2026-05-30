import { describe, expect, it, vi, afterEach } from 'vitest';
import { sanitizeDiscoveredValidation } from './sanitize-discovered-validation.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';

const warnSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

afterEach(() => {
  warnSpy.mockClear();
});

describe('sanitizeDiscoveredValidation', () => {
  it('returns undefined for null input', () => {
    expect(sanitizeDiscoveredValidation(null)).toBeUndefined();
    expect(sanitizeDiscoveredValidation(undefined)).toBeUndefined();
  });

  it('passes through safe commands unchanged', () => {
    const input: DiscoveredValidation = {
      typecheckCommand: 'npx tsc --noEmit',
      lintCommand: 'npx biome check',
      testCommand: 'npm test',
      language: 'typescript',
      testPattern: '*.test.ts',
    };
    const result = sanitizeDiscoveredValidation(input);
    expect(result).toEqual(input);
  });

  it('allows cargo, go, and pytest commands', () => {
    const rust: DiscoveredValidation = {
      typecheckCommand: 'cargo check',
      lintCommand: 'cargo clippy --no-deps',
      testCommand: 'cargo test',
      language: 'rust',
    };
    expect(sanitizeDiscoveredValidation(rust)).toEqual(rust);

    const go: DiscoveredValidation = {
      typecheckCommand: 'go vet ./...',
      testCommand: 'go test ./...',
      language: 'go',
    };
    expect(sanitizeDiscoveredValidation(go)).toEqual(go);

    const python: DiscoveredValidation = {
      testCommand: 'pytest',
      language: 'python',
    };
    expect(sanitizeDiscoveredValidation(python)).toEqual(python);
  });

  it('blocks commands with relative paths like ./evil-script', () => {
    const input: DiscoveredValidation = {
      testCommand: './scripts/evil',
      language: 'javascript',
    };
    const result = sanitizeDiscoveredValidation(input);
    expect(result?.testCommand).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('./scripts/evil'));
  });

  it('blocks commands with parent-relative paths', () => {
    const input: DiscoveredValidation = {
      typecheckCommand: '../other-repo/typecheck.sh',
    };
    const result = sanitizeDiscoveredValidation(input);
    expect(result).toBeUndefined();
  });

  it('blocks commands with absolute paths', () => {
    const input: DiscoveredValidation = {
      lintCommand: '/usr/local/bin/custom-linter',
    };
    const result = sanitizeDiscoveredValidation(input);
    expect(result).toBeUndefined();
  });

  it('blocks commands with shell operators', () => {
    const cases = [
      'npm test | grep pass',
      'npm test && echo done',
      'npm test; rm -rf /',
      'npm test `whoami`',
      'npm test $(whoami)',
    ];
    for (const cmd of cases) {
      const result = sanitizeDiscoveredValidation({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('blocks unrecognized commands', () => {
    const input: DiscoveredValidation = {
      testCommand: 'custom-test-tool --all',
    };
    const result = sanitizeDiscoveredValidation(input);
    expect(result?.testCommand).toBeUndefined();
  });

  it('keeps safe fields when some commands are blocked', () => {
    const input: DiscoveredValidation = {
      typecheckCommand: 'npx tsc --noEmit',
      testCommand: './evil-script',
      language: 'typescript',
      testPattern: '*.test.ts',
    };
    const result = sanitizeDiscoveredValidation(input);
    expect(result?.typecheckCommand).toBe('npx tsc --noEmit');
    expect(result?.testCommand).toBeUndefined();
    expect(result?.language).toBe('typescript');
    expect(result?.testPattern).toBe('*.test.ts');
  });

  it('preserves language and testPattern even when all commands are blocked', () => {
    const input: DiscoveredValidation = {
      testCommand: './evil',
      language: 'javascript',
      testPattern: '*.spec.js',
    };
    const result = sanitizeDiscoveredValidation(input);
    expect(result?.testCommand).toBeUndefined();
    expect(result?.language).toBe('javascript');
    expect(result?.testPattern).toBe('*.spec.js');
  });
});
