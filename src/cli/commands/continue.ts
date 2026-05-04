import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { createElement } from 'react';
import { Command } from 'commander';
import { App } from '../../app.js';
import { setupWorkflow, resolveProjectDir } from '../setup.js';
import { initStores } from '../init-stores.js';
import { renderApp } from '../render.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../platform.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { showCrashDiagnostic } from '../../engine/ipc/crash-diagnostic.js';
import { sessionsRoot, sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { loadState } from '../../core/state/persistence.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { isResumable } from '../../core/phases.js';
import { routerStore } from '../../stores/navigation/router.js';
import { addWorkflowOptions } from '../options.js';
import { maybeMigrate } from '../../core/migration/executor.js';
import { printMigrationResult } from './migrate.js';
import { runHeadless } from '../headless.js';
import { runRpc } from '../rpc/run.js';
import { isNumericAlias, resolveNumericAlias } from '../session-aliases.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export async function resolveSessionInput(
  input: string | undefined,
  projectDir: string,
): Promise<string | undefined> {
  if (input === undefined) return undefined;

  if (isNumericAlias(input)) {
    return resolveNumericAlias(input, projectDir);
  }

  return input;
}

async function resolveTargetSession(
  sessionInput: string | undefined,
  projectDir: string,
): Promise<string> {
  const resolved = await resolveSessionInput(sessionInput, projectDir);
  if (resolved !== undefined) return resolved;

  // No explicit ID: use the active session pointer (same as resume).
  const active = readActive(projectDir);
  if (active) return active;

  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) {
    throw cliError('no session to continue; start one with `diptych start`.', 1);
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const running: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessDir = sessionDir(projectDir, entry.name);
    const status = await checkServerStatus(sessDir);
    if (status.alive) running.push(entry.name);
  }

  const [single] = running;
  if (running.length === 1 && single) return single;
  if (running.length > 1) {
    throw cliError(
      `multiple sessions found (${running.join(', ')}); pass a session ID or use \`diptych ps\` to list them.`,
      1,
    );
  }

  throw cliError('no session to continue; start one with `diptych start`.', 1);
}

export async function continueCommand(
  sessionInput: string | undefined,
  opts: { projectDir: string } & WorkflowOpts,
): Promise<void> {
  assertNotWindows();
  if (opts.json && opts.rpc) throw cliError('--json and --rpc cannot be combined');

  const sessionId = await resolveTargetSession(sessionInput, opts.projectDir);
  const sessDir = sessionDir(opts.projectDir, sessionId);

  const status = await checkServerStatus(sessDir);

  if (status.alive) {
    if (opts.rpc) throw cliError('--rpc cannot attach to a running detached session yet.');
    const sockPath = join(sessDir, IPC_SOCK_FILE);
    await initStores(opts.projectDir);
    routerStore.init({
      screen: 'workflow',
      feature: status.data.feature,
      sessionId,
      attach: { sockPath },
    });

    const useFullscreen = Boolean(process.stdout.isTTY) && !process.env['CI'];
    await renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useFullscreen });
    return;
  }

  if (status.crashed) {
    await showCrashDiagnostic(sessDir, status);
  }

  const migration = await maybeMigrate(opts.projectDir);
  if (!opts.json && !opts.rpc) printMigrationResult(migration);

  const state = loadState(opts.projectDir, sessionId);

  if (!state) {
    throw cliError(`session '${sessionId}' has no saved state and is not running — cannot continue.`, 1);
  }

  if (!('stateVersion' in state) || state.stateVersion < CURRENT_STATE_VERSION) {
    throw cliError(
      `session '${sessionId}' state is from an older version and cannot be resumed.\nStart a new workflow with \`diptych start\`.`,
      1,
    );
  }

  if (!isResumable(state)) {
    throw cliError(
      `session '${sessionId}' is in phase "${state.phase}" which cannot be resumed.`,
      1,
    );
  }

  if (opts.json) {
    await runHeadless(state.feature, opts.projectDir, opts, state, sessionId);
    return;
  }

  if (opts.rpc) {
    await runRpc(state.feature, opts.projectDir, opts, state, sessionId);
    return;
  }

  console.log(`Resuming: ${state.feature} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`);

  const { useFullscreen, useMouse } = await setupWorkflow(opts);

  await initStores(opts.projectDir, opts);
  routerStore.init({ screen: 'workflow', feature: state.feature, resumeState: state, sessionId });

  await renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useMouse });
}

export function registerContinueCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('continue [session-id]')
      .description('Continue a session: attaches if running, resumes if interrupted'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    await continueCommand(sessionId, { ...opts, projectDir });
  });
}
