import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, versionGte, type SemVer } from '../src/utils/version.js';

describe('parseVersion', () => {
  it('parses standard semver string', () => {
    assert.deepEqual(parseVersion('2.1.84'), [2, 1, 84]);
  });

  it('parses version with prefix text', () => {
    assert.deepEqual(parseVersion('codex-cli 0.111.0'), [0, 111, 0]);
  });

  it('parses version with v prefix', () => {
    assert.deepEqual(parseVersion('aider v0.82.1'), [0, 82, 1]);
  });

  it('parses version with suffix text', () => {
    assert.deepEqual(parseVersion('2.1.84 (Claude Code)'), [2, 1, 84]);
  });

  it('returns null for non-version string', () => {
    assert.equal(parseVersion('no version here'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseVersion(''), null);
  });

  it('returns null for partial version', () => {
    assert.equal(parseVersion('1.2'), null);
  });

  it('parses version from multiline output', () => {
    assert.deepEqual(parseVersion('1.2.27\nsome other output'), [1, 2, 27]);
  });
});

describe('versionGte', () => {
  it('returns true for equal versions', () => {
    assert.equal(versionGte([2, 1, 84], [2, 1, 84]), true);
  });

  it('returns true when major is greater', () => {
    assert.equal(versionGte([3, 0, 0], [2, 9, 9]), true);
  });

  it('returns true when minor is greater', () => {
    assert.equal(versionGte([2, 2, 0], [2, 1, 84]), true);
  });

  it('returns true when patch is greater', () => {
    assert.equal(versionGte([2, 1, 85], [2, 1, 84]), true);
  });

  it('returns false when major is less', () => {
    assert.equal(versionGte([1, 9, 9], [2, 0, 0]), false);
  });

  it('returns false when minor is less', () => {
    assert.equal(versionGte([2, 0, 99], [2, 1, 0]), false);
  });

  it('returns false when patch is less', () => {
    assert.equal(versionGte([2, 1, 83], [2, 1, 84]), false);
  });
});

describe('planner version display formatting', () => {
  it('formats tool name with version', () => {
    const tool = 'claude-code';
    const version = '2.1.84';
    const display = version ? `${tool} v${version}` : tool;
    assert.equal(display, 'claude-code v2.1.84');
  });

  it('formats tool name without version', () => {
    const tool = 'shell';
    const version: string | null = null;
    const display = version ? `${tool} v${version}` : tool;
    assert.equal(display, 'shell');
  });
});
