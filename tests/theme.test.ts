import { describe, it, expect } from 'vitest';
import { getTheme } from '../src/theme.js';

const requiredFields = [
  'text', 'textDim', 'accent', 'success', 'error', 'warning',
  'info', 'planner', 'implementer', 'validator', 'border', 'panelBg', 'diff',
] as const;

const diffFields = [
  'added', 'addedBg', 'removed', 'removedBg', 'context', 'contextBg',
] as const;

describe('getTheme', () => {
  it('returns terminal theme by default (no argument)', () => {
    const theme = getTheme();
    expect(theme.accent).toBe('cyan');
  });

  it('returns terminal theme with ANSI named colors', () => {
    const theme = getTheme('terminal');
    expect(theme.accent).toBe('cyan');
    expect(theme.success).toBe('green');
    expect(theme.error).toBe('red');
    expect(theme.accent).not.toMatch(/^#/);
  });

  it('returns mono theme with hex color values', () => {
    const theme = getTheme('mono');
    expect(theme.accent).toMatch(/^#/);
    expect(theme.success).toMatch(/^#/);
    expect(theme.error).toMatch(/^#/);
  });

  it('terminal theme text is white', () => {
    expect(getTheme('terminal').text).toBe('white');
  });

  it('mono theme text is #c0c0c0', () => {
    expect(getTheme('mono').text).toBe('#c0c0c0');
  });

  it('terminal theme has all required fields', () => {
    const theme = getTheme('terminal');
    for (const field of requiredFields) {
      expect(theme).toHaveProperty(field);
    }
  });

  it('mono theme has all required fields', () => {
    const theme = getTheme('mono');
    for (const field of requiredFields) {
      expect(theme).toHaveProperty(field);
    }
  });

  it('terminal diff has all sub-fields', () => {
    const { diff } = getTheme('terminal');
    for (const field of diffFields) {
      expect(diff).toHaveProperty(field);
    }
  });

  it('mono diff has all sub-fields', () => {
    const { diff } = getTheme('mono');
    for (const field of diffFields) {
      expect(diff).toHaveProperty(field);
    }
  });
});
