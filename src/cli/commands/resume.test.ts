import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerResumeCommand } from './resume.js';

async function runResume(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerResumeCommand(program);
  await program.parseAsync(['node', 'diptych', 'resume', ...args]);
}

describe('resume command', () => {
  it('rejects --worktree as a start-only flag instead of silently ignoring it', async () => {
    await expect(runResume(['--worktree', 'feature-x'])).rejects.toThrow(
      /--worktree is only supported by `diptych start`/,
    );
  });
});
