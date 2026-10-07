import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paint } from './paint.js';

const initialLevel = chalk.level;
beforeEach(() => {
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = initialLevel;
});

describe('paint', () => {
  it('leaves the terminal default foreground unchanged', () => {
    expect(paint(undefined, 'text')).toBe('text');
  });

  it('paints truecolor without faint', () => {
    expect(paint('#b4bad0', 'text')).toBe('\u001b[38;2;180;186;208mtext\u001b[39m');
  });

  it('keeps a resolved 256 index at level 2', () => {
    chalk.level = 2;
    expect(paint('ansi256(250)', 'text')).toBe('\u001b[38;5;250mtext\u001b[39m');
  });

  it('paints a named ANSI colour through the terminal palette', () => {
    chalk.level = 1;
    expect(paint('white', 'text')).toBe('\u001b[37mtext\u001b[39m');
  });

  it('paints nothing at level 0', () => {
    chalk.level = 0;
    expect(paint('#b4bad0', 'text')).toBe('text');
    expect(paint('ansi256(250)', 'text')).toBe('text');
    expect(paint('white', 'text')).toBe('text');
  });
});
