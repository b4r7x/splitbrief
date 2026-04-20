import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile } from './parse.js';
import { resolve } from 'node:path';

describe('parse', () => {
  beforeAll(async () => { await initParser(); });

  it('extracts exported symbols from a TS file', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/sample.ts'));
    const exportedNames = node.symbols.filter(s => s.exported).map(s => s.name).sort();
    expect(exportedNames).toEqual(['PI', 'Point', 'Vec', 'add']);
  });

  it('marks exported flag correctly and detects kind', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/sample.ts'));
    const add = node.symbols.find(s => s.name === 'add');
    expect(add?.exported).toBe(true);
    expect(add?.kind).toBe('function');

    const point = node.symbols.find(s => s.name === 'Point');
    expect(point?.kind).toBe('interface');
    expect(point?.exported).toBe(true);

    const vec = node.symbols.find(s => s.name === 'Vec');
    expect(vec?.kind).toBe('type');

    const pi = node.symbols.find(s => s.name === 'PI');
    expect(pi?.kind).toBe('const');
  });

  it('extracts import specifiers', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/sample.ts'));
    expect(node.imports).toContain('./other.js');
  });

  it('captures sizeBytes and mtimeMs from disk stat', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/sample.ts'));
    expect(node.sizeBytes).toBeGreaterThan(0);
    expect(node.mtimeMs).toBeGreaterThan(0);
  });
});
