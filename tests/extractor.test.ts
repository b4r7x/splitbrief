import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCode, stripMarkdownFences, isCodeLine, looksLikeTypeScript } from '../src/orchestrator/extractor.js';

describe('extractCode', () => {
  it('extracts code from ```typescript fenced block with high confidence', () => {
    const response = '```typescript\nconst x = 1;\nexport function foo() { return x; }\n```';
    const result = extractCode(response);
    assert('code' in result);
    assert.equal(result.confidence, 'high');
    assert(result.code.includes('const x = 1;'));
    assert(result.code.includes('export function foo()'));
  });

  it('extracts code from bare ``` fenced block with high confidence', () => {
    const response = '```\nimport { something } from "./mod.js";\nconsole.log(something);\n```';
    const result = extractCode(response);
    assert('code' in result);
    assert.equal(result.confidence, 'high');
    assert(result.code.includes('import { something }'));
  });

  it('uses the longest block when multiple code blocks exist', () => {
    const short = 'const a = 1;';
    const long = 'import fs from "node:fs";\n\nexport function readFile(path: string) {\n  return fs.readFileSync(path, "utf-8");\n}\n\nexport function writeFile(path: string, data: string) {\n  fs.writeFileSync(path, data);\n}';
    const response = `Here is a helper:\n\n\`\`\`ts\n${short}\n\`\`\`\n\nAnd the main code:\n\n\`\`\`typescript\n${long}\n\`\`\``;
    const result = extractCode(response);
    assert('code' in result);
    assert.equal(result.confidence, 'high');
    assert(result.code.includes('readFile'));
    assert(result.code.includes('writeFile'));
  });

  it('extracts raw code starting with import as high confidence', () => {
    const response = 'import { join } from "node:path";\n\nexport const base = join("/tmp", "test");';
    const result = extractCode(response);
    assert('code' in result);
    assert.equal(result.confidence, 'high');
    assert.equal(result.code, response);
  });

  it('strips surrounding explanation text and extracts code with medium confidence', () => {
    const code = 'import { foo } from "./foo.js";\n\nexport interface Bar {\n  name: string;\n}\n\nexport const bar: Bar = { name: "test" };';
    const response = `Here is the implementation:\n\n${code}\n\nThis should work for your use case.`;
    const result = extractCode(response);
    assert('code' in result);
    assert.equal(result.confidence, 'medium');
    assert(result.code.includes('import { foo }'));
    assert(result.code.includes('export const bar'));
  });

  it('returns error for empty response', () => {
    const result = extractCode('');
    assert('error' in result);
  });

  it('returns error for pure natural language', () => {
    const result = extractCode(
      'Here is a description of how the module works. The system processes data and returns results. You can configure it with options.'
    );
    assert('error' in result);
  });
});

describe('stripMarkdownFences', () => {
  it('removes ```typescript fence', () => {
    const input = '```typescript\nconst x = 1;\n```';
    assert.equal(stripMarkdownFences(input), 'const x = 1;');
  });

  it('removes ```ts fence', () => {
    const input = '```ts\nconst x = 1;\n```';
    assert.equal(stripMarkdownFences(input), 'const x = 1;');
  });

  it('removes bare ``` fence', () => {
    const input = '```\nconst x = 1;\n```';
    assert.equal(stripMarkdownFences(input), 'const x = 1;');
  });
});

describe('isCodeLine', () => {
  it('returns true for import statement', () => {
    assert.equal(isCodeLine('import { foo } from "./foo.js";'), true);
  });

  it('returns true for export statement', () => {
    assert.equal(isCodeLine('export const bar = 1;'), true);
  });

  it('returns true for const declaration', () => {
    assert.equal(isCodeLine('const x = 42;'), true);
  });

  it('returns true for opening brace', () => {
    assert.equal(isCodeLine('{'), true);
  });

  it('returns true for closing brace', () => {
    assert.equal(isCodeLine('}'), true);
  });

  it('returns true for empty line', () => {
    assert.equal(isCodeLine(''), true);
  });

  it('returns false for natural language', () => {
    assert.equal(isCodeLine('Here is the code'), false);
  });
});

describe('looksLikeTypeScript', () => {
  it('returns true for code with imports, exports, and types', () => {
    const code = 'import { join } from "node:path";\n\nexport interface Config {\n  name: string;\n}\n\nexport const config: Config = { name: "test" };';
    assert.equal(looksLikeTypeScript(code), true);
  });

  it('returns false for plain English text', () => {
    const text = 'This is a description of how something works. It does not contain any code at all. Just regular English prose.';
    assert.equal(looksLikeTypeScript(text), false);
  });
});
