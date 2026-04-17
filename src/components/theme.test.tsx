import { describe, it, expect } from 'vitest';
import { getTheme } from './theme.js';

function extractKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(path);
    if (value !== null && typeof value === 'object') {
      keys.push(...extractKeys(value, path));
    }
  }
  return keys.sort();
}

describe('theme', () => {
  it('terminal and mono themes expose identical key sets', () => {
    const terminal = getTheme('terminal');
    const mono = getTheme('mono');
    expect(extractKeys(terminal)).toEqual(extractKeys(mono));
  });

  it('getTheme defaults to terminal', () => {
    expect(getTheme()).toEqual(getTheme('terminal'));
  });
});
