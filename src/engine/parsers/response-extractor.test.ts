import { describe, it, expect } from 'vitest';
import { extractCode } from './response-extractor.js';
import { stripMarkdownFences } from './code-patterns.js';

describe('extractCode', () => {
  it('extracts code from ```typescript fenced block with high confidence', () => {
    const response = '```typescript\nconst x = 1;\nexport function foo() { return x; }\n```';
    const result = extractCode(response);
    if (!('code' in result)) throw new Error('expected code result');
    expect(result.confidence).toBe('high');
    expect(result.code).toContain('const x = 1;');
    expect(result.code).toContain('export function foo()');
  });

  it('extracts code from bare ``` fenced block with high confidence', () => {
    const response = '```\nimport { something } from "./mod.js";\nconsole.log(something);\n```';
    const result = extractCode(response);
    if (!('code' in result)) throw new Error('expected code result');
    expect(result.confidence).toBe('high');
    expect(result.code).toContain('import { something }');
  });

  it('uses the longest block when multiple code blocks exist', () => {
    const short = 'const a = 1;';
    const long = 'import fs from "node:fs";\n\nexport function readFile(path: string) {\n  return fs.readFileSync(path, "utf-8");\n}\n\nexport function writeFile(path: string, data: string) {\n  fs.writeFileSync(path, data);\n}';
    const response = `Here is a helper:\n\n\`\`\`ts\n${short}\n\`\`\`\n\nAnd the main code:\n\n\`\`\`typescript\n${long}\n\`\`\``;
    const result = extractCode(response);
    if (!('code' in result)) throw new Error('expected code result');
    expect(result.confidence).toBe('high');
    expect(result.code).toContain('readFile');
    expect(result.code).toContain('writeFile');
  });

  it('extracts raw code starting with import as high confidence', () => {
    const response = 'import { join } from "node:path";\n\nexport const base = join("/tmp", "test");';
    const result = extractCode(response);
    if (!('code' in result)) throw new Error('expected code result');
    expect(result.confidence).toBe('high');
    expect(result.code).toBe(response);
  });

  it('strips surrounding explanation text and extracts code with medium confidence', () => {
    const code = 'import { foo } from "./foo.js";\n\nexport interface Bar {\n  name: string;\n}\n\nexport const bar: Bar = { name: "test" };';
    const response = `Here is the implementation:\n\n${code}\n\nThis should work for your use case.`;
    const result = extractCode(response);
    if (!('code' in result)) throw new Error('expected code result');
    expect(result.confidence).toBe('medium');
    expect(result.code).toContain('import { foo }');
    expect(result.code).toContain('export const bar');
  });

  it('returns error for empty response', () => {
    const result = extractCode('');
    expect('error' in result).toBeTruthy();
  });

  it('returns error for pure natural language', () => {
    const result = extractCode(
      'Here is a description of how the module works. The system processes data and returns results. You can configure it with options.'
    );
    expect('error' in result).toBeTruthy();
  });
});

describe('stripMarkdownFences', () => {
  it('removes ```typescript fence', () => {
    const input = '```typescript\nconst x = 1;\n```';
    expect(stripMarkdownFences(input)).toBe('const x = 1;');
  });

  it('removes ```ts fence', () => {
    const input = '```ts\nconst x = 1;\n```';
    expect(stripMarkdownFences(input)).toBe('const x = 1;');
  });

  it('removes bare ``` fence', () => {
    const input = '```\nconst x = 1;\n```';
    expect(stripMarkdownFences(input)).toBe('const x = 1;');
  });
});

