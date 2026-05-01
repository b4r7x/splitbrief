import { describe, expect, it, vi } from 'vitest';
import { invokeCommandBasedRunner } from './command-based.js';

describe('invokeCommandBasedRunner', () => {
  it('writes prompt to stdin when no placeholder present', async () => {
    // Use 'cat' to echo stdin back
    const result = await invokeCommandBasedRunner(
      { command: 'cat', extractsCode: false, detectChanges: async () => ({ changed: true, output: '' }) },
      'test prompt',
      process.cwd(),
    );
    expect(result.stdout).toContain('test prompt');
  });

  it('substitutes {prompt} placeholder in args', async () => {
    const result = await invokeCommandBasedRunner(
      {
        command: 'echo',
        args: ['{prompt}'],
        extractsCode: false,
        detectChanges: async () => ({ changed: true, output: '' }),
        supportPromptPlaceholder: true,
      },
      'hello world',
      process.cwd(),
    );
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('substitutes {prompt} placeholder in command', async () => {
    // Use sh -c to run a command that includes the prompt
    const result = await invokeCommandBasedRunner(
      {
        command: 'sh',
        args: ['-c', 'echo "{prompt}"'],
        extractsCode: false,
        detectChanges: async () => ({ changed: true, output: '' }),
        supportPromptPlaceholder: true,
      },
      'substituted text',
      process.cwd(),
    );
    expect(result.stdout.trim()).toBe('substituted text');
  });

  it('uses stdin when supportPromptPlaceholder is false', async () => {
    // Even with {prompt} in args, if supportPromptPlaceholder is false, use stdin
    const result = await invokeCommandBasedRunner(
      {
        command: 'cat',
        args: [], // no placeholder
        extractsCode: false,
        detectChanges: async () => ({ changed: true, output: '' }),
        supportPromptPlaceholder: false,
      },
      'stdin content',
      process.cwd(),
    );
    expect(result.stdout).toContain('stdin content');
  });

  it('extracts code when extractsCode is true', async () => {
    const codeBlock = '```js\nconsole.log("hi")\n```';
    const result = await invokeCommandBasedRunner(
      { command: 'echo', args: [codeBlock], extractsCode: true },
      '',
      process.cwd(),
    );
    expect(result.code).toContain('console.log');
  });

  it('returns undefined code when no code block found', async () => {
    const result = await invokeCommandBasedRunner(
      { command: 'echo', args: ['no code here'], extractsCode: true },
      '',
      process.cwd(),
    );
    expect(result.code).toBeUndefined();
    expect(result.stdout).toContain('no code here');
  });

  it('reports changed files via detectChanges when extractsCode is false', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: true, output: '' });
    const result = await invokeCommandBasedRunner(
      { command: 'echo', args: ['done'], extractsCode: false, detectChanges },
      '',
      process.cwd(),
    );
    expect(result.hasChanges).toBe(true);
  });

  it('returns hasChanges: false when detectChanges returns false', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: false, output: 'no changes' });
    const result = await invokeCommandBasedRunner(
      { command: 'echo', args: ['done'], extractsCode: false, detectChanges },
      '',
      process.cwd(),
    );
    expect(result.hasChanges).toBe(false);
  });

  it('propagates command-not-found error', async () => {
    await expect(
      invokeCommandBasedRunner(
        { command: 'nonexistent-command-xyz', extractsCode: true },
        'prompt',
        process.cwd(),
      ),
    ).rejects.toThrow(/Command not found/);
  });

  it('streams stdout chunks to the output subscriber', async () => {
    const chunks: string[] = [];
    await invokeCommandBasedRunner(
      { command: 'echo', args: ['hello'], extractsCode: false },
      '',
      process.cwd(),
      (text: string) => { chunks.push(text); },
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('hello');
  });

  it('captures stderr', async () => {
    const result = await invokeCommandBasedRunner(
      { command: 'sh', args: ['-c', 'echo error >&2'], extractsCode: false },
      '',
      process.cwd(),
    );
    expect(result.stderr).toContain('error');
  });

  it('returns stdout and stderr when no extractsCode or detectChanges', async () => {
    const result = await invokeCommandBasedRunner(
      { command: 'echo', args: ['output'], extractsCode: false },
      '',
      process.cwd(),
    );
    expect(result.stdout).toContain('output');
    expect(result.hasChanges).toBeUndefined();
    expect(result.code).toBeUndefined();
  });
});
