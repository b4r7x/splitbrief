import type { Command } from 'commander';
import { canonicalizeProjectDir } from '../../setup.js';
import { addWorkflowOptions } from '../../options.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import { continueCommand, defaultContinueDeps, type ContinueDeps } from './command.js';

export function registerContinueCommand(
  program: Command,
  deps: ContinueDeps = defaultContinueDeps,
): void {
  addWorkflowOptions(
    program
      .command('continue [session-id]')
      .description('Continue an interrupted session where it stopped'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    const projectDir = await canonicalizeProjectDir(opts);
    await continueCommand(sessionId, { ...opts, projectDir }, deps);
  });
}
