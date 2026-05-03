import { describe, it, expect } from 'vitest';
import { parseDiscoveredValidation } from './parse-validation.js';

describe('parseDiscoveredValidation', () => {
  it('extracts validation tools from h2 research markdown', () => {
    const markdown = `## Project Overview
Some overview.

## Validation Tools

- **Language**: rust
- **Type checker**: \`cargo check\`
- **Linter**: \`cargo clippy --no-deps\`
- **Test runner**: \`cargo test\`
- **Test file pattern**: \`*_test.rs\`

## Architecture
Some architecture.`;

    const result = parseDiscoveredValidation(markdown);
    expect(result).toEqual({
      language: 'rust',
      typecheckCommand: 'cargo check',
      lintCommand: 'cargo clippy --no-deps',
      testCommand: 'cargo test',
      testPattern: '*_test.rs',
    });
  });

  it('extracts validation tools from h3 headings (actual prompt output format)', () => {
    const markdown = `### Project Overview
Some overview.

### Validation Tools

- **Language**: typescript
- **Type checker**: \`npx tsc --noEmit\`
- **Linter**: \`npx biome check\`
- **Test runner**: \`npm test\`
- **Test file pattern**: \`*.test.ts\`

### Architecture
Some architecture.`;

    const result = parseDiscoveredValidation(markdown);
    expect(result).toEqual({
      language: 'typescript',
      typecheckCommand: 'npx tsc --noEmit',
      lintCommand: 'npx biome check',
      testCommand: 'npm test',
      testPattern: '*.test.ts',
    });
  });

  it('handles "none" values by returning undefined', () => {
    const markdown = `## Validation Tools

- **Language**: python
- **Type checker**: none
- **Linter**: \`ruff check\`
- **Test runner**: \`pytest\`
- **Test file pattern**: \`test_*.py\``;

    const result = parseDiscoveredValidation(markdown);
    expect(result?.typecheckCommand).toBeUndefined();
    expect(result?.lintCommand).toBe('ruff check');
  });

  it('treats "none" test runner as undefined testCommand', () => {
    const markdown = `### Validation Tools

- **Language**: javascript
- **Type checker**: none
- **Linter**: \`eslint .\`
- **Test runner**: none
- **Test file pattern**: \`*.test.js\``;

    const result = parseDiscoveredValidation(markdown);
    expect(result?.testCommand).toBeUndefined();
    expect(result?.lintCommand).toBe('eslint .');
  });

  it('returns null when section is absent', () => {
    const markdown = `## Project Overview\nSome overview.\n## Architecture\nSome arch.`;
    expect(parseDiscoveredValidation(markdown)).toBeNull();
  });

  it('returns null when section is empty', () => {
    const markdown = `## Validation Tools\n\n## Architecture`;
    expect(parseDiscoveredValidation(markdown)).toBeNull();
  });

  it('returns non-null with language only and no tool commands', () => {
    const markdown = `## Validation Tools

- **Language**: python

## Architecture
Some architecture.`;

    const result = parseDiscoveredValidation(markdown);
    expect(result).toEqual({ language: 'python' });
  });
});
