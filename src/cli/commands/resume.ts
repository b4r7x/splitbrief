import type { Command } from 'commander';
import { loadState } from '../../core/state/persistence.js';
import {
  addWorkflowOptions,
  assertModeFlagsExclusive,
  assertWorktreeStartOnly,
} from '../options.js';
import { resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { sessionDir } from '../../core/paths.js';
import { maybeMigrateAndReport } from './migrate.js';
import { resumeSavedSession } from './continue.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export function registerResumeCommand(program: Command): void {
  addWorkflowOptions(
    program.command('resume').description('Resume an interrupted workflow'),
  ).action(async (opts: WorkflowOpts) => {
    assertModeFlagsExclusive(opts);
    assertWorktreeStartOnly(opts);
    const projectDir = resolveProjectDir(opts.project);
    await maybeMigrateAndReport(projectDir, opts);

    const sessionId = readActive(projectDir);
    if (!sessionId) {
      throw cliError('no active session to resume.');
    }

    const status = await checkServerStatus(sessionDir(projectDir, sessionId));
    if (status.alive) {
      throw cliError(
        `session '${sessionId}' is running — use \`diptych attach\` to view it or \`diptych continue\` to attach/resume.`,
        1,
      );
    }

    const state = loadState({ projectDir, sessionId });

    if (!state) {
      throw cliError(
        `session '${sessionId}' has no usable state.json — cannot resume. Start a new workflow with \`diptych start\`.`,
      );
    }

    await resumeSavedSession({ projectDir, sessionId, state, opts });
  });
}
