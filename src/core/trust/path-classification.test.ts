import { describe, expect, it } from 'vitest';
import { commandTokensAfterInterpreter, isPathLike, isRepoLocal } from './path-classification.js';

describe('isPathLike', () => {
  it('treats tokens with slashes as path-like', () => {
    expect(isPathLike('./scripts/runner')).toBe(true);
    expect(isPathLike('scripts/runner.sh')).toBe(true);
    expect(isPathLike('bin\\tool')).toBe(true);
  });

  it('treats bare executable names as not path-like', () => {
    expect(isPathLike('claude')).toBe(false);
    expect(isPathLike('node')).toBe(false);
    expect(isPathLike('python3')).toBe(false);
  });
});

describe('isRepoLocal', () => {
  it('flags explicit relative paths', () => {
    expect(isRepoLocal('./scripts/runner', '/tmp/project')).toBe(true);
    expect(isRepoLocal('../other/runner', '/tmp/project')).toBe(true);
  });

  it('flags bare repo-relative script paths', () => {
    expect(isRepoLocal('scripts/runner.sh', '/tmp/project')).toBe(true);
  });

  it('flags absolute paths inside the project dir', () => {
    expect(isRepoLocal('/tmp/project/bin/runner', '/tmp/project')).toBe(true);
  });

  it('does not flag absolute paths outside the project dir', () => {
    expect(isRepoLocal('/usr/local/bin/tool', '/tmp/project')).toBe(false);
  });

  it('does not flag a sibling dir whose name is a prefix of the project dir', () => {
    expect(isRepoLocal('/tmp/project-evil/runner', '/tmp/project')).toBe(false);
  });

  it('does not flag bare system command names', () => {
    expect(isRepoLocal('claude', '/tmp/project')).toBe(false);
  });
});

describe('commandTokensAfterInterpreter', () => {
  it('drops a leading code-loading interpreter token', () => {
    expect(commandTokensAfterInterpreter(['node', 'scripts/malicious.js'])).toEqual([
      'scripts/malicious.js',
    ]);
    expect(commandTokensAfterInterpreter(['tsx', './run.ts'])).toEqual(['./run.ts']);
  });

  it('keeps tokens when the leading token is not a code-loading interpreter', () => {
    expect(commandTokensAfterInterpreter(['scripts/runner.sh'])).toEqual(['scripts/runner.sh']);
    expect(commandTokensAfterInterpreter(['claude'])).toEqual(['claude']);
  });

  it('keeps a lone interpreter token when there is nothing after it', () => {
    expect(commandTokensAfterInterpreter(['node'])).toEqual(['node']);
  });
});
