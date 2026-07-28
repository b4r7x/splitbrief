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
import { resumeSavedSession } from './continue/resume.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export interface ResumeDeps {
  checkServerStatus: typeof checkServerStatus;
  resumeSavedSession: typeof resumeSavedSession;
}

const defaultResumeDeps: ResumeDeps = {
  checkServerStatus,
  resumeSavedSession,
};

export async function resumeCommand(
  opts: { projectDir: string } & WorkflowOpts,
  deps: ResumeDeps = defaultResumeDeps,
): Promise<void> {
  assertModeFlagsExclusive(opts);
  assertWorktreeStartOnly(opts);
  const { projectDir } = opts;
  await maybeMigrateAndReport(projectDir, opts);

  const sessionId = readActive(projectDir);
  if (!sessionId) {
    throw cliError('no active session to resume.');
  }

  const status = await deps.checkServerStatus(sessionDir(projectDir, sessionId));
  if (status.alive) {
    throw cliError(
      `session '${sessionId}' is running — use \`splitbrief attach\` to view it or \`splitbrief continue\` to attach/resume.`,
      1,
    );
  }

  if (status.processAlive) {
    throw cliError(
      `server process ${status.data?.pid} exists but is unresponsive — kill it first`,
      1,
    );
  }

  const state = loadState({ projectDir, sessionId });

  if (!state) {
    throw cliError(
      `session '${sessionId}' has no usable state.json — cannot resume. Start a new workflow with \`splitbrief start\`.`,
    );
  }

  await deps.resumeSavedSession({ projectDir, sessionId, state, opts });
}

export function registerResumeCommand(program: Command): void {
  addWorkflowOptions(
    program.command('resume').description('Resume an interrupted workflow'),
  ).action(async (opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    await resumeCommand({ ...opts, projectDir });
  });
}
