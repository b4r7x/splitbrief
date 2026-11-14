import { existsSync } from 'node:fs';
import { sessionDir } from '../../core/paths.js';
import { deriveRunStatus } from '../../core/sessions/run/status.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import { continueRunCommand } from '../../core/recovery/resume-command.js';
import { cliError } from '../errors.js';
import { sessionError } from '../../core/sessions/errors.js';
import { clearStaleSession, assertNoLiveSession } from '../../core/sessions/guards.js';

export function assertSessionExists(projectDir: string, sessionId: string): void {
  if (!existsSync(sessionDir(projectDir, sessionId))) {
    throw cliError(
      `session '${sessionId}' not found. Open \`/sessions\` in the TUI to browse runs, or run \`splitbrief status\` for the active run.`,
      1,
    );
  }
}

/** The command that applies a ready run: a run that was accepted as is takes `apply-as-is`. */
export function applyCommand(sessionId: string, state: WorkflowState): string {
  return `${continueRunCommand(sessionId)} --action ${state.acceptedAsIs === undefined ? 'apply' : 'apply-as-is'}`;
}

export function discardCommand(sessionId: string): string {
  return `${continueRunCommand(sessionId)} --action discard`;
}

export function readyToApplyMessage(sessionId: string, state: WorkflowState): string {
  return `Run ${sessionId} is ready to apply.\nApply with: ${applyCommand(sessionId, state)}\nDiscard with: ${discardCommand(sessionId)}`;
}

export function assertResumableState(state: WorkflowState, sessionId: string): void {
  const status = deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false });
  if (status.kind === 'closed') {
    throw cliError(`Run ${sessionId} is closed (${status.as}); nothing to resume.`, 1);
  }
  if (status.kind === 'ready-to-apply') {
    throw cliError(readyToApplyMessage(sessionId, state), 1);
  }
}

// A live session is left in place: preparation readiness reports it as the
// `repo.active-session-live` blocker with its remediation.
export function clearStaleSessionForCli(projectDir: string): void {
  try {
    clearStaleSession(projectDir);
  } catch (err) {
    if (sessionError.isStillActive(err)) return;
    throw err;
  }
}

// For surfaces that only open the TUI (home, setup): refuse to run alongside a
// live session, but never touch the active pointer — deleting it would break
// `splitbrief resume` for the stale-but-resumable case.
export function assertNoLiveSessionForCli(projectDir: string): void {
  try {
    assertNoLiveSession(projectDir);
  } catch (err) {
    if (sessionError.isStillActive(err)) throw cliError(err.message, 1);
    throw err;
  }
}
