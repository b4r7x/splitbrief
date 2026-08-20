import { describe, expect, it } from 'vitest';
import { parseCliSemanticVector, validateCliArgs } from './validate-args.js';

const BASE_ARGS = ['run', '<PROMPT>'];

function validateWithTail(tail: readonly string[]) {
  return validateCliArgs({
    invocationArgs: [...BASE_ARGS, ...tail],
    baseArgs: BASE_ARGS,
    protectedFlags: new Set(['--model', '-m', '-p']),
    protectedShortValueFlags: new Set(['-m']),
    promptTransport: 'argv',
  });
}

describe('validateCliArgs', () => {
  it('recognizes only explicitly value-taking short flags as attached protected values', () => {
    expect(validateWithTail(['-mclaude'])).toEqual({ valid: false, conflicts: ['-m'] });
    expect(validateWithTail(['--model=claude'])).toEqual({ valid: false, conflicts: ['--model'] });
  });

  it('rejects the -c short config alias in split and attached forms', () => {
    expect(validateWithTail(['-c', 'config.yaml'])).toEqual({ valid: false, conflicts: ['-c'] });
    expect(validateWithTail(['-cpath.yaml'])).toEqual({ valid: false, conflicts: ['-c'] });
  });

  it('rejects profile forms in split, equal, and single-dash long shapes', () => {
    expect(validateWithTail(['--profile', 'work'])).toEqual({
      valid: false,
      conflicts: ['--profile'],
    });
    expect(validateWithTail(['--profile=work'])).toEqual({
      valid: false,
      conflicts: ['--profile'],
    });
    expect(validateWithTail(['-profile'])).toEqual({ valid: false, conflicts: ['-p'] });
  });

  it('rejects alias forms of authority flags', () => {
    expect(validateWithTail(['-y'])).toEqual({ valid: false, conflicts: ['-y'] });
    expect(validateWithTail(['--agent', 'plan'])).toEqual({ valid: false, conflicts: ['--agent'] });
  });

  it('a positional separator does not hide an authority flag', () => {
    expect(validateWithTail(['--', '--profile', 'work'])).toEqual({
      valid: false,
      conflicts: ['--profile'],
    });
  });

  it('rejects bypass and added-root override forms', () => {
    expect(validateWithTail(['--dangerously-skip-permissions'])).toEqual({
      valid: false,
      conflicts: ['--dangerously-skip-permissions'],
    });
    expect(validateWithTail(['--add-root', '/tmp/other'])).toEqual({
      valid: false,
      conflicts: ['--add-root'],
    });
    expect(validateWithTail(['--cwd', '/tmp/other'])).toEqual({
      valid: false,
      conflicts: ['--cwd'],
    });
  });

  it('rejects plural and camelCase authority spellings', () => {
    expect(validateWithTail(['--hooks', 'pre.js'])).toEqual({
      valid: false,
      conflicts: ['--hooks'],
    });
    expect(validateWithTail(['--plugins', 'one'])).toEqual({
      valid: false,
      conflicts: ['--plugins'],
    });
    expect(validateWithTail(['--tools', 'x'])).toEqual({ valid: false, conflicts: ['--tools'] });
    expect(validateWithTail(['--permissions', 'x'])).toEqual({
      valid: false,
      conflicts: ['--permissions'],
    });
    expect(validateWithTail(['--approvals', 'x'])).toEqual({
      valid: false,
      conflicts: ['--approvals'],
    });
    expect(validateWithTail(['--approve-for-me'])).toEqual({
      valid: false,
      conflicts: ['--approve-for-me'],
    });
    expect(validateWithTail(['--allowedTools', 'Write'])).toEqual({
      valid: false,
      conflicts: ['--allowedTools'],
    });
    expect(validateWithTail(['--dangerouslySkipPermissions'])).toEqual({
      valid: false,
      conflicts: ['--dangerouslySkipPermissions'],
    });
  });

  it('leaves ordinary configured flags alone', () => {
    expect(validateWithTail(['--verbose', '--max-turns', '5'])).toEqual({ valid: true });
    expect(validateWithTail([])).toEqual({ valid: true });
  });
});

describe('parseCliSemanticVector', () => {
  it('classifies authority-bearing long flags by category', () => {
    expect(
      parseCliSemanticVector(['--permission-mode', 'acceptEdits', '--sandbox=read-only']),
    ).toEqual([
      { token: '--permission-mode', category: 'permission' },
      { token: 'acceptEdits', category: null },
      { token: '--sandbox', category: 'sandbox' },
    ]);
    expect(parseCliSemanticVector(['--mcp-config', 'x.json', '--resume', 's1'])).toEqual([
      { token: '--mcp-config', category: 'hooks-mcp' },
      { token: 'x.json', category: null },
      { token: '--resume', category: 'session' },
      { token: 's1', category: null },
    ]);
    expect(parseCliSemanticVector(['--output-format', 'text', '--update'])).toEqual([
      { token: '--output-format', category: 'output' },
      { token: 'text', category: null },
      { token: '--update', category: 'update' },
    ]);
  });

  it('classifies short and attached short authority flags', () => {
    expect(parseCliSemanticVector(['-y', '-cvalue', '-mclaude'])).toEqual([
      { token: '-y', category: 'approval' },
      { token: '-c', category: 'config' },
      { token: '-m', category: null },
    ]);
  });

  it('classifies plural and camelCase authority spellings', () => {
    expect(parseCliSemanticVector(['--hooks', 'pre.js', '--tools'])).toEqual([
      { token: '--hooks', category: 'hooks-mcp' },
      { token: 'pre.js', category: null },
      { token: '--tools', category: 'tools' },
    ]);
    expect(parseCliSemanticVector(['--plugins', '--permissions', '--approvals'])).toEqual([
      { token: '--plugins', category: 'hooks-mcp' },
      { token: '--permissions', category: 'permission' },
      { token: '--approvals', category: 'approval' },
    ]);
    expect(
      parseCliSemanticVector([
        '--approve-for-me',
        '--allowedTools',
        '--dangerouslySkipPermissions',
      ]),
    ).toEqual([
      { token: '--approve-for-me', category: 'approval' },
      { token: '--allowedTools', category: 'tools' },
      { token: '--dangerouslySkipPermissions', category: 'permission' },
    ]);
  });

  it('keeps benign, separator, and value tokens unclassified', () => {
    expect(parseCliSemanticVector(['--model=gpt-5', '--verbose', '--', 'plan'])).toEqual([
      { token: '--model', category: null },
      { token: '--verbose', category: null },
      { token: '--', category: null },
      { token: 'plan', category: null },
    ]);
  });
});
