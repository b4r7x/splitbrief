import { describe, expect, it } from 'vitest';
import { resolveEditorKeyAction } from './editor.js';
import { type KeyLike, normalizeKeySignature } from './normalize.js';

function resolve(input: string, key: KeyLike = {}) {
  return resolveEditorKeyAction(normalizeKeySignature({ input, key }));
}

describe('resolveEditorKeyAction', () => {
  it('inserts a newline for both Enter and Ctrl+J on every terminal', () => {
    expect(resolve('', { return: true })).toEqual({ kind: 'insert', text: '\n' });
    expect(resolve('j', { ctrl: true })).toEqual({ kind: 'insert', text: '\n' });
    expect(resolve('\r')).toEqual({ kind: 'insert', text: '\n' });
    expect(resolve('\n')).toEqual({ kind: 'insert', text: '\n' });
  });

  it('binds save to Ctrl+S and cancel to Escape (no dependence on Enter meaning commit)', () => {
    expect(resolve('s', { ctrl: true })).toEqual({ kind: 'save' });
    expect(resolve('', { escape: true })).toEqual({ kind: 'cancel' });
  });

  it('maps Ctrl+O to open-external without disturbing neighboring chords (REQ-140)', () => {
    expect(resolve('o', { ctrl: true })).toEqual({ kind: 'open-external' });
    // Neighboring chords stay put: Ctrl+S saves, Ctrl+J inserts a newline.
    expect(resolve('s', { ctrl: true })).toEqual({ kind: 'save' });
    expect(resolve('j', { ctrl: true })).toEqual({ kind: 'insert', text: '\n' });
    // Ctrl+G remains unbound in the editor resolver (reserved for cost-drilldown).
    expect(resolve('g', { ctrl: true })).toBeNull();
  });

  it('binds copy, cut, and select-all away from Ctrl+C', () => {
    expect(resolve('c', { meta: true })).toEqual({ kind: 'copy' });
    expect(resolve('y', { ctrl: true })).toEqual({ kind: 'copy' });
    expect(resolve('x', { meta: true })).toEqual({ kind: 'cut' });
    expect(resolve('x', { ctrl: true })).toEqual({ kind: 'cut' });
    expect(resolve('a', { meta: true })).toEqual({ kind: 'select-all' });
  });

  it('never maps Ctrl+C to copy, cut, or select-all (interrupt semantics retained)', () => {
    const action = resolve('c', { ctrl: true });
    expect(action).toBeNull();
    expect(action).not.toEqual({ kind: 'copy' });
    expect(action).not.toEqual({ kind: 'cut' });
    expect(action).not.toEqual({ kind: 'select-all' });
  });

  it('marks shifted motions as selecting and unshifted motions as collapsing', () => {
    expect(resolve('', { shift: true, leftArrow: true })).toEqual({
      kind: 'motion',
      motion: 'char-left',
      select: true,
    });
    expect(resolve('', { shift: true, rightArrow: true })).toEqual({
      kind: 'motion',
      motion: 'char-right',
      select: true,
    });
    expect(resolve('', { leftArrow: true })).toEqual({
      kind: 'motion',
      motion: 'char-left',
      select: false,
    });
  });

  it('moves by word for Alt+arrow and Ctrl+arrow', () => {
    expect(resolve('', { meta: true, leftArrow: true })).toMatchObject({
      motion: 'word-left',
    });
    expect(resolve('', { ctrl: true, rightArrow: true })).toMatchObject({
      motion: 'word-right',
    });
  });

  it('recaptures Home, End, PageUp, and PageDown as the four editor motions (REQ-031)', () => {
    expect(resolve('', { home: true })).toEqual({
      kind: 'motion',
      motion: 'line-start',
      select: false,
    });
    expect(resolve('', { end: true })).toEqual({
      kind: 'motion',
      motion: 'line-end',
      select: false,
    });
    expect(resolve('', { pageUp: true })).toEqual({
      kind: 'motion',
      motion: 'page-up',
      select: false,
    });
    expect(resolve('', { pageDown: true })).toEqual({
      kind: 'motion',
      motion: 'page-down',
      select: false,
    });
  });

  it('promotes Ctrl+Home/End to document motions', () => {
    expect(resolve('', { ctrl: true, home: true })).toMatchObject({ motion: 'doc-start' });
    expect(resolve('', { ctrl: true, end: true })).toMatchObject({ motion: 'doc-end' });
  });
});
