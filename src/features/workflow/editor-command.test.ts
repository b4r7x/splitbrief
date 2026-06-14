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

  it('prefers VISUAL over EDITOR', () => {
    vi.stubEnv('VISUAL', 'nvim --clean');
    vi.stubEnv('EDITOR', 'vim');
    expect(resolveEditorArgv()).toEqual({ command: 'nvim', args: ['--clean'] });
  });

  it('falls back to EDITOR when VISUAL is empty', () => {
    vi.stubEnv('VISUAL', '   ');
    vi.stubEnv('EDITOR', 'emacs -nw');
    expect(resolveEditorArgv()).toEqual({ command: 'emacs', args: ['-nw'] });
  });
});
