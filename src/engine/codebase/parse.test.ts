import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { initParser, parseFile, kindForNodeType } from './parse.js';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('parse', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts exported symbols from a TS file', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/sample.ts'));
    expect(node).not.toBeNull();
    if (node === null) return;
    const exportedNames = node.symbols
      .filter((s) => s.exported)
      .map((s) => s.name)
      .sort();
    expect(exportedNames).toEqual(['PI', 'Point', 'Vec', 'add']);
  });

  it('marks exported flag correctly and detects kind', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/sample.ts'));
    expect(node).not.toBeNull();
    if (node === null) return;
    const add = node.symbols.find((s) => s.name === 'add');
    expect(add?.exported).toBe(true);
    expect(add?.kind).toBe('function');

    const point = node.symbols.find((s) => s.name === 'Point');
    expect(point?.kind).toBe('interface');
    expect(point?.exported).toBe(true);

    const vec = node.symbols.find((s) => s.name === 'Vec');
    expect(vec?.kind).toBe('type');

    const pi = node.symbols.find((s) => s.name === 'PI');
    expect(pi?.kind).toBe('const');
  });

  it('extracts import specifiers', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/sample.ts'));
    expect(node).not.toBeNull();
    if (node === null) return;
    expect(node.imports).toContain('./other.js');
  });

  it('captures sizeBytes and mtimeMs from disk stat', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/sample.ts'));
    expect(node).not.toBeNull();
    if (node === null) return;
    expect(node.sizeBytes).toBeGreaterThan(0);
    expect(node.mtimeMs).toBeGreaterThan(0);
  });

  it('returns null when filesystem access fails', async () => {
    const node = await parseFile(resolve('testing/fixtures/codebase/does-not-exist.ts'));
    expect(node).toBeNull();
  });
});

describe('parseFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parse-'));
    await initParser();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true }));

  it('returns null for unknown extension', async () => {
    const file = join(tmpDir, 'test.xyz');
    writeFileSync(file, 'some content');
    const node = await parseFile(file);
    expect(node).toBeNull();
  });

  it('returns filename-only node when grammar package is missing', async () => {
    const file = join(tmpDir, 'test.py');
    writeFileSync(file, 'def hello(): pass');
    const node = await parseFile(file);
    expect(node).toBeTruthy();
    expect(node?.symbols).toEqual([]);
    expect(node?.imports).toEqual([]);
    expect(node?.path).toBe(file);
  });
});

describe('kindForNodeType polyglot', () => {
  it.each([
    ['function_definition', 'function'],
    ['class_definition', 'class'],
    ['method_declaration', 'function'],
    ['struct_item', 'class'],
    ['trait_item', 'interface'],
    ['enum_item', 'enum'],
    ['type_item', 'type'],
    ['type_declaration', 'type'],
    ['function_item', 'function'],
    ['something_random', 'const'],
  ] as const)('maps %s to %s', (nodeType, kind) => {
    expect(kindForNodeType(nodeType)).toBe(kind);
  });
});
