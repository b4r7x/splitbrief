import { describe, it, expect } from 'vitest';
import { selectRelevantExamples, formatExamplesSection } from './escalation-examples.js';
import { buildLanguageContext } from './language-context.js';

describe('selectRelevantExamples', () => {
  const tsCtx = buildLanguageContext('typescript');

  it('selects import-related example for module error', () => {
    const examples = selectRelevantExamples(
      "Cannot find module './utils.js' imported from src/foo.ts",
      tsCtx,
    );
    expect(examples.length).toBeGreaterThanOrEqual(1);
    expect(examples[0]!.label).toContain('extension');
  });

  it('selects type-related example for type error', () => {
    const examples = selectRelevantExamples(
      "Type 'string | undefined' is not assignable to parameter of type 'string'",
      tsCtx,
    );
    expect(examples.length).toBeGreaterThanOrEqual(1);
    expect(examples.some(e => e.label.includes('type'))).toBe(true);
  });

  it('returns empty array when no keywords match', () => {
    const examples = selectRelevantExamples(
      'completely novel error xyz123',
      tsCtx,
    );
    expect(examples).toEqual([]);
  });

  it('returns Python examples for Python context', () => {
    const pyCtx = buildLanguageContext('python');
    const examples = selectRelevantExamples(
      "ModuleNotFoundError: No module named 'foo'",
      pyCtx,
    );
    expect(examples[0]!.label).toContain('Import');
  });

  it('returns generic examples for unknown language context', () => {
    const haskellCtx = buildLanguageContext('Haskell');
    const examples = selectRelevantExamples('SyntaxError: Unexpected token near line 5', haskellCtx);
    expect(examples.length).toBeGreaterThanOrEqual(1);
    expect(examples[0]!.label).toBe('Syntax error');
  });

  it('caps at maxExamples', () => {
    const examples = selectRelevantExamples('error', tsCtx, 1);
    expect(examples.length).toBeLessThanOrEqual(1);
  });
});

describe('formatExamplesSection', () => {
  it('formats examples with numbered labels', () => {
    const formatted = formatExamplesSection([
      { label: 'Test', error: 'err', rootCause: 'cause', fix: 'fix it' },
    ]);
    expect(formatted).toContain('**Example 1: Test**');
    expect(formatted).toContain('Root cause: cause');
  });
});
