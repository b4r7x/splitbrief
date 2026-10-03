import { describe, expect, it } from 'vitest';
import { formatCopyResult, REMOVED_COMMANDS } from './types.js';

describe('formatCopyResult', () => {
  it.each([
    {
      result: 'osc52' as const,
      message: 'Copy escape sent; verify your clipboard (some terminals block it)',
    },
    { result: 'native' as const, message: 'Copied (native)' },
    { result: 'tmux-buffer' as const, message: 'Copied (tmux-buffer)' },
    { result: 'unavailable' as const, message: 'Could not copy' },
    { result: 'empty' as const, message: 'Nothing to copy' },
  ])('$result → $message', ({ result, message }) => {
    expect(formatCopyResult(result)).toBe(message);
  });
});

describe('REMOVED_COMMANDS', () => {
  it.each(['/attach', '/detach'])('points %s at /image', (name) => {
    expect(REMOVED_COMMANDS[name]).toContain('/image');
  });

  it.each(['/revise-spec', '/revise-plan'])('points %s at the plan approval', (name) => {
    expect(REMOVED_COMMANDS[name]).toBe('request changes on the plan');
  });

  it('says why /mode is gone', () => {
    expect(REMOVED_COMMANDS['/mode']).toContain('one session');
  });

  it('says how protected writes ask now that /approval is gone', () => {
    expect(`/approval was removed: ${REMOVED_COMMANDS['/approval']}`.length).toBeLessThanOrEqual(
      60,
    );
    expect(REMOVED_COMMANDS['/approval']).toContain('once per run');
  });

  it('says in one line that only a protected write asks now that /yolo is gone', () => {
    expect(`/yolo was removed: ${REMOVED_COMMANDS['/yolo']}`.length).toBeLessThanOrEqual(60);
    expect(REMOVED_COMMANDS['/yolo']).toBe('only a write to a protected path asks');
  });
});
