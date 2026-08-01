import type { Command } from 'commander';
import { resolveProjectDir } from '../../setup.js';
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
      .description('Continue a session: attaches if running, resumes if interrupted'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    await continueCommand(sessionId, { ...opts, projectDir }, deps);
  });
}
