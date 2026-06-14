import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Language } from 'web-tree-sitter';
import { getLanguageForExtension } from './languages.js';
import { initParser, parseFile } from './parse.js';

const manifest = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve('../../../package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

describe('language registry', () => {
  it('.ts returns TypeScript config', () => {
    const lang = getLanguageForExtension('.ts');
    expect(lang?.id).toBe('typescript');
  });

  it('.tsx returns TypeScript with tsx grammar', () => {
    const lang = getLanguageForExtension('.tsx');
    expect(lang?.resolveGrammarWasm('.tsx')).toBe('tree-sitter-tsx.wasm');
  });

  it('every TS/JS grammar package is an optional, not a hard, dependency', () => {
    const hard = new Set(Object.keys(manifest.dependencies ?? {}));
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
      const pkg = getLanguageForExtension(ext)?.grammarPackage;
      expect(pkg).not.toBeNull();
      expect(hard).not.toContain(pkg);
      expect(optional).toContain(pkg);
    }
  });

  it.each([
    ['.ts', 'typescript'],
    ['.tsx', 'typescript'],
    ['.js', 'javascript'],
    ['.jsx', 'javascript'],
    ['.mjs', 'javascript'],
    ['.cjs', 'javascript'],
  ])('%s grammar resolves to an installed, loadable wasm asset', async (ext, id) => {
    const require = createRequire(import.meta.url);
    const lang = getLanguageForExtension(ext)!;
    expect(lang.id).toBe(id);
    expect(lang.grammarPackage).not.toBeNull();

    const wasmFile = lang.resolveGrammarWasm(ext)!;
    const resolved = require.resolve(`${lang.grammarPackage}/${wasmFile}`);
    expect(existsSync(resolved)).toBe(true);

    await initParser();
    const grammar = await Language.load(resolved);
    expect(grammar).toBeDefined();
  });

  describe('configured TS/JS grammar parses every extension end-to-end', () => {
    let dir: string;
    beforeAll(async () => {
      await initParser();
      dir = mkdtempSync(join(tmpdir(), 'ts-grammar-'));
    });

    it.each([
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
    ])('parseFile extracts the exported symbol from a %s file', async (ext) => {
      const file = join(dir, `widget${ext}`);
      writeFileSync(file, "import './dep.js';\nexport function widget() {}\n");
      const node = await parseFile(file);
      expect(node).not.toBeNull();
      const widget = node?.symbols.find((s) => s.name === 'widget');
      expect(widget?.exported).toBe(true);
      expect(widget?.kind).toBe('function');
      expect(node?.imports).toContain('./dep.js');
      rmSync(file);
    });
  });

  it('.py returns Python config', () => {
    const lang = getLanguageForExtension('.py');
    expect(lang?.id).toBe('python');
  });

  it('.go returns Go config', () => {
    expect(getLanguageForExtension('.go')?.id).toBe('go');
  });

  it('.rs returns Rust config', () => {
    expect(getLanguageForExtension('.rs')?.id).toBe('rust');
  });

  it('.xyz returns null', () => {
    expect(getLanguageForExtension('.xyz')).toBeNull();
  });

  it('TypeScript import candidates match existing behavior', () => {
    const lang = getLanguageForExtension('.ts')!;
    const candidates = lang.resolveImportCandidates('./foo');
    expect(candidates).toEqual(['./foo.ts', './foo.tsx', './foo', './foo/index.ts']);
  });

  it('Go has no file-relative import candidates', () => {
    const lang = getLanguageForExtension('.go')!;
    expect(lang.resolveImportCandidates('./foo')).toEqual([]);
  });
});

describe('isExported per language', () => {
  it('Python: all top-level defs are exported', () => {
    const py = getLanguageForExtension('.py')!;
    expect(py.isExported?.('hello', 'def hello(): pass')).toBe(true);
  });

  it('Go: uppercase names are exported', () => {
    const go = getLanguageForExtension('.go')!;
    expect(go.isExported?.('HandleRequest', 'func HandleRequest() {}')).toBe(true);
    expect(go.isExported?.('handleRequest', 'func handleRequest() {}')).toBe(false);
  });

  it('Rust: pub items are exported', () => {
    const rs = getLanguageForExtension('.rs')!;
    expect(rs.isExported?.('hello', 'pub fn hello() {}')).toBe(true);
    expect(rs.isExported?.('hello', 'fn hello() {}')).toBe(false);
    expect(rs.isExported?.('hello', 'pub(crate) fn hello() {}')).toBe(true);
  });

  it('TypeScript: isExported is not defined (handled via export_statement)', () => {
    const ts = getLanguageForExtension('.ts')!;
    expect(ts.isExported).toBeUndefined();
  });
});

describe('Python importRegex excludes trailing punctuation', () => {
  it('captures first module from comma-separated import', () => {
    const py = getLanguageForExtension('.py')!;
    const matches = [...'import os, json'.matchAll(py.importRegex!)];
    expect(matches).toHaveLength(1);
    expect(matches[0]![1] ?? matches[0]![2]).toBe('os');
  });

  it('captures dotted module from "from" import', () => {
    const py = getLanguageForExtension('.py')!;
    const regex = py.importRegex!;
    regex.lastIndex = 0;
    const match = regex.exec('from os.path import join');
    expect(match).not.toBeNull();
    const captured = match![1] ?? match![2];
    expect(captured).toBe('os.path');
  });
});
