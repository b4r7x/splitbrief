import type { Command } from 'commander';
import { canonicalizeProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { buildAliasedSessions } from '../sessions/aliases.js';
import { continueCommand } from './continue/command.js';
import { addWorkflowOptions, assertWorktreeStartOnly } from '../options.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export interface LastDeps {
  continueCommand: typeof continueCommand;
}

const defaultDeps: LastDeps = { continueCommand };

async function findMostRecentSession(projectDir: string): Promise<string> {
  const sessions = await buildAliasedSessions(projectDir);

  const newest = sessions[0];
  if (!newest) {
    throw cliError('no sessions found; start one with `splitbrief start`.', 1);
  }

  return newest.sessionId;
}

export async function lastCommand(
  opts: { projectDir: string } & WorkflowOpts,
  deps: LastDeps = defaultDeps,
): Promise<void> {
  assertWorktreeStartOnly(opts);

  const sessionId = await findMostRecentSession(opts.projectDir);
  await deps.continueCommand(sessionId, opts);
}

export function registerLastCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('last')
      .description(
        'Continue the most recent session (attaches if running, resumes if interrupted)',
      ),
  ).action(async (opts: WorkflowOpts) => {
    const projectDir = await canonicalizeProjectDir(opts);
    await lastCommand({ ...opts, projectDir });
  });
}
