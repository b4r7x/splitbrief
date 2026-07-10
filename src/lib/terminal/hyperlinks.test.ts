import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osc8Hyperlink, terminalSupportsHyperlinks } from './hyperlinks.js';

describe('terminalSupportsHyperlinks', () => {
  it.each([
    {
      name: 'FORCE_HYPERLINK=1 forces true even in Apple Terminal',
      env: { FORCE_HYPERLINK: '1', TERM_PROGRAM: 'Apple_Terminal' },
      expected: true,
    },
    {
      name: 'FORCE_HYPERLINK=0 forces false even in iTerm',
      env: { FORCE_HYPERLINK: '0', TERM_PROGRAM: 'iTerm.app' },
      expected: false,
    },
    {
      name: 'FORCE_HYPERLINK=false forces false even under kitty',
      env: { FORCE_HYPERLINK: 'false', KITTY_WINDOW_ID: '1' },
      expected: false,
    },
    {
      name: 'Apple_Terminal is unsupported even with KITTY_WINDOW_ID set',
      env: { TERM_PROGRAM: 'Apple_Terminal', KITTY_WINDOW_ID: '1' },
      expected: false,
    },
    { name: 'TERM_PROGRAM iTerm.app', env: { TERM_PROGRAM: 'iTerm.app' }, expected: true },
    { name: 'TERM_PROGRAM WezTerm', env: { TERM_PROGRAM: 'WezTerm' }, expected: true },
    { name: 'TERM_PROGRAM ghostty', env: { TERM_PROGRAM: 'ghostty' }, expected: true },
    { name: 'TERM_PROGRAM vscode', env: { TERM_PROGRAM: 'vscode' }, expected: true },
    { name: 'TERM_PROGRAM Hyper', env: { TERM_PROGRAM: 'Hyper' }, expected: true },
    { name: 'unknown TERM_PROGRAM', env: { TERM_PROGRAM: 'MysteryTerm' }, expected: false },
    { name: 'VTE_VERSION 6003', env: { VTE_VERSION: '6003' }, expected: true },
    { name: 'VTE_VERSION 4999 is too old', env: { VTE_VERSION: '4999' }, expected: false },
    { name: 'non-numeric VTE_VERSION', env: { VTE_VERSION: 'abc' }, expected: false },
    { name: 'KITTY_WINDOW_ID set', env: { KITTY_WINDOW_ID: '3' }, expected: true },
    { name: 'WT_SESSION set', env: { WT_SESSION: 'a1b2c3' }, expected: true },
    { name: 'TERM xterm-kitty', env: { TERM: 'xterm-kitty' }, expected: true },
    { name: 'TERM foot', env: { TERM: 'foot' }, expected: true },
    { name: 'TERM alacritty', env: { TERM: 'alacritty' }, expected: true },
    { name: 'TERM xterm-256color', env: { TERM: 'xterm-256color' }, expected: false },
    { name: 'empty env', env: {}, expected: false },
  ])('$name → $expected', ({ env, expected }) => {
    expect(terminalSupportsHyperlinks(env)).toBe(expected);
  });

  describe('default env argument', () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env['FORCE_HYPERLINK'];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env['FORCE_HYPERLINK'];
      else process.env['FORCE_HYPERLINK'] = saved;
    });

    it('reads process.env when no env is passed', () => {
      process.env['FORCE_HYPERLINK'] = '1';
      expect(terminalSupportsHyperlinks()).toBe(true);

      process.env['FORCE_HYPERLINK'] = '0';
      expect(terminalSupportsHyperlinks()).toBe(false);
    });
  });
});

describe('osc8Hyperlink', () => {
  it('wraps the label in an OSC 8 sequence when support is forced on', () => {
    expect(terminalSupportsHyperlinks({ FORCE_HYPERLINK: '1' })).toBe(true);

    const output = osc8Hyperlink({
      label: 'src/app.ts',
      href: 'file:///repo/src/app.ts',
    });

    expect(output).toContain('\x1b]8;;');
    expect(output).toBe('\x1b]8;;file:///repo/src/app.ts\x1b\\src/app.ts\x1b]8;;\x1b\\');
  });

  it('carries non-file hrefs unchanged', () => {
    expect(osc8Hyperlink({ label: 'docs', href: 'https://example.com/docs' })).toBe(
      '\x1b]8;;https://example.com/docs\x1b\\docs\x1b]8;;\x1b\\',
    );
  });
});
