import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveEditorArgv } from './editor-command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveEditorArgv', () => {
  it('splits EDITOR values with arguments', () => {
    vi.stubEnv('EDITOR', 'code --wait');
    expect(resolveEditorArgv()).toEqual({ command: 'code', args: ['--wait'] });
  });

  it('defaults to vi when EDITOR is empty', () => {
    vi.stubEnv('EDITOR', '   ');
    expect(resolveEditorArgv()).toEqual({ command: 'vi', args: [] });
  });
});
