import { describe, it, expect } from 'vitest';
import { parseVersion, type SemVer } from './format.js';

describe('parseVersion', () => {
  it('parses standard semver string', () => {
    expect(parseVersion('2.1.84')).toEqual([2, 1, 84]);
  });

  it('parses version with prefix text', () => {
    expect(parseVersion('codex-cli 0.111.0')).toEqual([0, 111, 0]);
  });

  it('parses version with v prefix', () => {
    expect(parseVersion('aider v0.82.1')).toEqual([0, 82, 1]);
  });

  it('parses version with suffix text', () => {
    expect(parseVersion('2.1.84 (Claude Code)')).toEqual([2, 1, 84]);
  });

  it('returns null for non-version string', () => {
    expect(parseVersion('no version here')).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(parseVersion('')).toBe(null);
  });

  it('returns null for partial version', () => {
    expect(parseVersion('1.2')).toBe(null);
  });

  it('parses version from multiline output', () => {
    expect(parseVersion('1.2.27\nsome other output')).toEqual([1, 2, 27]);
  });
});

describe('planner version display formatting', () => {
  it('formats tool name with version', () => {
    const tool = 'claude-code';
    const version = '2.1.84';
    const display = version ? `${tool} v${version}` : tool;
    expect(display).toBe('claude-code v2.1.84');
  });

  it('formats tool name without version', () => {
    const tool = 'shell';
    const version: string | null = null;
    const display = version ? `${tool} v${version}` : tool;
    expect(display).toBe('shell');
  });
});
