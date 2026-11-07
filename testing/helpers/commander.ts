import { Command, CommanderError } from 'commander';
import { defaultStartDeps, registerStartCommand } from '../../src/cli/commands/start/register.js';
import type { StartDeps } from '../../src/cli/commands/start/types.js';
import { registerSpecCommand } from '../../src/cli/commands/spec.js';
import { registerInitCommand } from '../../src/cli/commands/init.js';
import { registerStatusCommand } from '../../src/cli/commands/status.js';
import { registerResumeCommand } from '../../src/cli/commands/resume.js';
import { registerReviewCommand } from '../../src/cli/commands/review.js';
import { registerContinueCommand } from '../../src/cli/commands/continue/register.js';

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  args: string[],
  startDeps: Partial<StartDeps> = {},
): Promise<RunCommandResult> {
  const program = new Command();
  program.name('splitbrief').version('0.1.0').exitOverride();

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  program.configureOutput({
    writeOut: (str) => {
      stdoutChunks.push(str);
    },
    writeErr: (str) => {
      stderrChunks.push(str);
    },
  });

  registerStartCommand(program, { ...defaultStartDeps, ...startDeps });
  registerSpecCommand(program);
  registerInitCommand(program);
  registerStatusCommand(program);
  registerResumeCommand(program);
  registerReviewCommand(program);
  registerContinueCommand(program);

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...parts: unknown[]) => {
    stdoutChunks.push(parts.map(String).join(' ') + '\n');
  };
  console.error = (...parts: unknown[]) => {
    stderrChunks.push(parts.map(String).join(' ') + '\n');
  };

  let exitCode = 0;
  try {
    await program.parseAsync(['node', 'splitbrief', ...args]);
  } catch (err) {
    const failure = err as { exitCode?: number; message?: string };
    exitCode = typeof failure.exitCode === 'number' ? failure.exitCode : 1;
    if (!(err instanceof CommanderError) && failure.message) {
      stderrChunks.push(failure.message + '\n');
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
}
