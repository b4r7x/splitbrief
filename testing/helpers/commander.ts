import { Command } from 'commander';
import { registerStartCommand } from '../../src/cli/commands/start.js';
import { registerSpecCommand } from '../../src/cli/commands/spec.js';
import { registerInitCommand } from '../../src/cli/commands/init.js';
import { registerStatusCommand } from '../../src/cli/commands/status.js';
import { registerExplainCommand } from '../../src/cli/commands/explain.js';
import { registerResumeCommand } from '../../src/cli/commands/resume.js';
import { registerMigrateCommand } from '../../src/cli/commands/migrate.js';

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the diptych CLI in-process with the given args.
 *
 * Creates a fresh commander `Command` on each call, registers every subcommand,
 * installs `exitOverride()` so failing commands throw instead of killing the
 * process, and captures stdout/stderr via console spies.
 *
 * Passing `['start', 'feature']` behaves like `diptych start feature`.
 */
export async function runCommand(args: string[]): Promise<RunCommandResult> {
  const program = new Command();
  program.name('diptych').version('0.1.0').exitOverride();

  registerStartCommand(program);
  registerSpecCommand(program);
  registerInitCommand(program);
  registerStatusCommand(program);
  registerExplainCommand(program);
  registerResumeCommand(program);
  registerMigrateCommand(program);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  program.configureOutput({
    writeOut: (str) => { stdoutChunks.push(str); },
    writeErr: (str) => { stderrChunks.push(str); },
  });

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...parts: unknown[]) => { stdoutChunks.push(parts.map(String).join(' ') + '\n'); };
  console.error = (...parts: unknown[]) => { stderrChunks.push(parts.map(String).join(' ') + '\n'); };

  let exitCode = 0;
  try {
    await program.parseAsync(['node', 'diptych', ...args]);
  } catch (err) {
    const commanderErr = err as { exitCode?: number; code?: string; message?: string };
    exitCode = typeof commanderErr.exitCode === 'number' ? commanderErr.exitCode : 1;
    if (commanderErr.message && commanderErr.code !== 'commander.helpDisplayed') {
      stderrChunks.push(commanderErr.message + '\n');
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
