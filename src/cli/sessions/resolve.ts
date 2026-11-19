import { existsSync } from 'node:fs';
import { sessionDir } from '../../core/paths.js';
import { deriveRunStatus } from '../../core/sessions/run/status.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import { continueRunCommand } from '../../core/recovery/resume-command.js';
import { cliError } from '../errors.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import { listSessions } from '../../core/sessions/io.js';
import { readRunRecord } from '../../core/sessions/run/record-io.js';
import type { RunRecord } from '../../core/sessions/run/record.js';
import { resolveSessionAlias } from './aliases.js';

function isOpenDefault(record: RunRecord): boolean {
  return record.hydration.kind === 'loaded' && record.status.kind !== 'closed';
}

export async function resolveTargetRun({
  sessionInput,
  projectDir,
  checkLiveness,
  defaultSelection = 'saved-run',
}: {
  sessionInput?: string | undefined;
  projectDir: string;
  checkLiveness?: Parameters<typeof readRunRecord>[2];
  defaultSelection?: 'saved-run' | 'active-pointer';
}): Promise<RunRecord | null> {
  const read = (sessionId: string) =>
    readRunRecord({ projectDir, sessionId }, false, checkLiveness);
  const selected = await resolveSessionAlias(sessionInput, projectDir);
  if (selected !== undefined) {
    assertSessionExists(projectDir, selected);
    return read(selected);
  }

  const active = readActive(projectDir);
  const current = active === null ? null : read(active);
  if (defaultSelection === 'active-pointer' || (current !== null && isOpenDefault(current))) {
    return current;
  }

  for (const run of listSessions(projectDir)) {
    if (run.status !== 'open' || run.id === active) continue;
    const candidate = read(run.id);
    if (isOpenDefault(candidate)) return candidate;
  }
  return current;
}

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
