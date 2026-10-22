import type { Command } from 'commander';
import { canonicalizeProjectDir } from '../../setup.js';
import { addWorkflowOptions } from '../../options.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import { continueCommand, defaultContinueDeps, type ContinueDeps } from './command.js';
import { withHeldDiagnostics } from '../../../lib/warn.js';

export function registerContinueCommand(
  program: Command,
  deps: ContinueDeps = defaultContinueDeps,
): void {
  addWorkflowOptions(
    program
      .command('continue [session-id]')
      .description('Continue a run by id, with recovery and Apply actions'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    // The screen shows what an interactive continue raises from its first step.
    const resume = async () =>
      continueCommand(sessionId, { ...opts, projectDir: await canonicalizeProjectDir(opts) }, deps);
    await (opts.json === true || opts.plain === true ? resume() : withHeldDiagnostics(resume));
  });
}
