import type { Command } from 'commander';
import { loadState } from '../../core/state/persistence.js';
import { addWorkflowOptions } from '../options.js';
import { resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { maybeMigrateAndReport } from './migrate.js';
import { resumeSavedSession } from './continue.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export function registerResumeCommand(program: Command): void {
  addWorkflowOptions(
    program.command('resume').description('Resume an interrupted workflow'),
  ).action(async (opts: WorkflowOpts) => {
    if (opts.json && opts.rpc) throw cliError('--json and --rpc cannot be combined');
    const projectDir = resolveProjectDir(opts.project);
    await maybeMigrateAndReport(projectDir, opts);

    const sessionId = readActive(projectDir);
    if (!sessionId) {
      throw cliError('no active session to resume.');
    }

    const state = loadState(projectDir, sessionId);

    if (!state) {
      throw cliError(`session '${sessionId}' has no state.json — cannot resume.`);
    }

    await resumeSavedSession({ projectDir, sessionId, state, opts });
  });
}
