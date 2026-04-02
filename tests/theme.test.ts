import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.equal(theme.accent, 'cyan');
  });

  it('returns terminal theme with ANSI named colors', () => {
    const theme = getTheme('terminal');
    assert.equal(theme.accent, 'cyan');
    assert.equal(theme.success, 'green');
    assert.equal(theme.error, 'red');
    assert.ok(!theme.accent.startsWith('#'));
  });

  it('returns mono theme with hex color values', () => {
    const theme = getTheme('mono');
    assert.ok(theme.accent.startsWith('#'));
    assert.ok(theme.success.startsWith('#'));
    assert.ok(theme.error.startsWith('#'));
  });

  it('terminal theme text is white', () => {
    assert.equal(getTheme('terminal').text, 'white');
  });

  it('mono theme text is #c0c0c0', () => {
    assert.equal(getTheme('mono').text, '#c0c0c0');
  });

  it('terminal theme has all required fields', () => {
    const theme = getTheme('terminal');
    for (const field of requiredFields) {
      assert.ok(field in theme, `missing field: ${field}`);
    }
  });

  it('mono theme has all required fields', () => {
    const theme = getTheme('mono');
    for (const field of requiredFields) {
      assert.ok(field in theme, `missing field: ${field}`);
    }
  });

  it('terminal diff has all sub-fields', () => {
    const { diff } = getTheme('terminal');
    for (const field of diffFields) {
      assert.ok(field in diff, `missing diff field: ${field}`);
    }
  });

  it('mono diff has all sub-fields', () => {
    const { diff } = getTheme('mono');
    for (const field of diffFields) {
      assert.ok(field in diff, `missing diff field: ${field}`);
    }
  });
});
