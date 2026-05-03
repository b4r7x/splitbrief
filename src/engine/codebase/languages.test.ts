import { describe, it, expect } from 'vitest';
import { getLanguageForExtension } from './languages.js';

describe('language registry', () => {
  it('.ts returns TypeScript config', () => {
    const lang = getLanguageForExtension('.ts');
    expect(lang?.id).toBe('typescript');
  });

  it('.tsx returns TypeScript with tsx grammar', () => {
    const lang = getLanguageForExtension('.tsx');
    expect(lang?.resolveGrammarWasm('.tsx')).toBe('tree-sitter-tsx.wasm');
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
