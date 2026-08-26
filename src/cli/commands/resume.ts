import type { Command } from 'commander';
import { loadOwnerWorkflowState } from '../../core/state/resume-hydration.js';
import {
  addWorkflowOptions,
  assertModeFlagsExclusive,
  assertWorktreeStartOnly,
} from '../options.js';
import { canonicalizeProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { sessionDir } from '../../core/paths.js';
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

  const hydrated = loadOwnerWorkflowState({ projectDir, sessionId });

  if (hydrated.kind === 'invalid') {
    throw cliError(`session '${sessionId}' has invalid saved state: ${hydrated.message}`, 1);
  }

  if (hydrated.kind === 'missing') {
    throw cliError(
      `session '${sessionId}' has no usable state.json — cannot resume. Start a new workflow with \`splitbrief start\`.`,
    );
  }

  await deps.resumeSavedSession({ projectDir, sessionId, state: hydrated.state, opts });
}

export function registerResumeCommand(program: Command): void {
  addWorkflowOptions(
    program.command('resume').description('Resume an interrupted workflow'),
  ).action(async (opts: WorkflowOpts) => {
    const projectDir = await canonicalizeProjectDir(opts);
    await resumeCommand({ ...opts, projectDir });
  });
}
