import { join } from 'node:path';
import type { Command } from 'commander';
import { createElement } from 'react';
import { App } from '../../app/root.js';
import { bootstrapStoresSync } from '../init-stores.js';
import { canonicalizeProjectDir } from '../setup.js';
import { renderApp } from '../render/app.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../windows-guard.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import { assertStateAuthority, readStateAuthority } from '../../core/state/authority.js';
import { routerStore } from '../../stores/navigation/router.js';
import { resolveSessionAlias } from '../sessions/aliases.js';
import { resolveRunningSession, assertSessionExists } from '../sessions/resolve.js';
import { addWorkflowOptions } from '../options.js';
import type { ServerStatus } from '../../engine/ipc/lockfile.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { StateAuthorityReceipt } from '../../core/state/types.js';

export interface AttachDeps {
  checkServerStatus: (sessionDir: string) => Promise<ServerStatus>;
  renderApp: typeof renderApp;
  initObserverStores?: (projectDir: string) => void;
  readStateAuthority?: typeof readStateAuthority;
  assertStateAuthority?: typeof assertStateAuthority;
}

const defaultDeps: AttachDeps = {
  checkServerStatus,
  renderApp,
  initObserverStores: bootstrapStoresSync,
  readStateAuthority,
  assertStateAuthority,
};

export interface AttachRenderOptions {
  fullscreen: boolean;
  mouse: boolean;
  hover: boolean;
}

const PROCESS_START_TOLERANCE_MS = 2000;

export async function renderAttachClient(
  opts: {
    projectDir: string;
    sessionId: string;
    feature: string;
    sockPath: string;
    authToken: string;
  },
  deps: Pick<AttachDeps, 'renderApp'> & Pick<AttachDeps, 'initObserverStores'>,
  render: AttachRenderOptions,
): Promise<void> {
  (deps.initObserverStores ?? bootstrapStoresSync)(opts.projectDir);
  routerStore.init({
    screen: 'workflow',
    execution: {
      kind: 'attached',
      feature: opts.feature,
      sessionId: opts.sessionId,
      attach: { sockPath: opts.sockPath, authToken: opts.authToken },
    },
  });

  await deps.renderApp(createElement(App), {
    fullscreen: render.fullscreen,
    mouse: render.mouse,
    hover: render.hover,
  });
}

function attachRenderOptions(opts: WorkflowOpts): AttachRenderOptions {
  const interactive = Boolean(process.stdout.isTTY) && !process.env.CI;
  const fullscreen = opts.fullscreen !== false && interactive;
  const mouse = opts.mouse !== false && fullscreen;
  return {
    fullscreen,
    mouse,
    hover: opts.hover === true && mouse,
  };
}

export function assertAttachOwner(
  ref: SessionRef,
  deps: Pick<AttachDeps, 'readStateAuthority' | 'assertStateAuthority'>,
): StateAuthorityReceipt {
  const read = deps.readStateAuthority ?? readStateAuthority;
  const assert = deps.assertStateAuthority ?? assertStateAuthority;
  let receipt: StateAuthorityReceipt | null;
  try {
    receipt = read(ref);
  } catch {
    throw cliError(
      `cannot attach to session ${ref.sessionId}: state authority is missing or invalid`,
      1,
    );
  }
  if (receipt === null || receipt.sessionId !== ref.sessionId) {
    throw cliError(
      `cannot attach to session ${ref.sessionId}: no matching live owner authority`,
      1,
    );
  }
  try {
    assert({ ref, receipt });
  } catch {
    throw cliError(
      `cannot attach to session ${ref.sessionId}: owner authority is dead or mismatched`,
      1,
    );
  }
  return receipt;
}

export function assertServerIdentity(
  sessionId: string,
  status: ServerStatus,
  receipt: StateAuthorityReceipt,
): { feature: string; authToken: string } {
  const data = status.data;
  if (
    data === null ||
    data.sessionId !== sessionId ||
    data.authToken === undefined ||
    data.pid !== receipt.pid ||
    Math.abs(data.startTimeMs - Number(receipt.processStart)) > PROCESS_START_TOLERANCE_MS
  ) {
    throw cliError(
      `cannot attach to session ${sessionId}: server and owner authority identities do not match`,
      1,
    );
  }
  return { feature: data.feature, authToken: data.authToken };
}

export async function attachCommand(
  sessionId: string | undefined,
  opts: { projectDir: string } & WorkflowOpts,
  deps: AttachDeps = defaultDeps,
): Promise<void> {
  assertNotWindows();

  const resolvedDeps: AttachDeps = { ...defaultDeps, ...deps };

  const resolvedId = sessionId ?? (await resolveRunningSession(opts.projectDir, resolvedDeps));
  assertSessionExists(opts.projectDir, resolvedId);
  const sessDir = sessionDir(opts.projectDir, resolvedId);

  const status = await resolvedDeps.checkServerStatus(sessDir);
  const authority = assertAttachOwner(
    { projectDir: opts.projectDir, sessionId: resolvedId },
    resolvedDeps,
  );
  const server = assertServerIdentity(resolvedId, status, authority);

  await renderAttachClient(
    {
      projectDir: opts.projectDir,
      sessionId: resolvedId,
      feature: server.feature,
      sockPath: join(sessDir, IPC_SOCK_FILE),
      authToken: server.authToken,
    },
    resolvedDeps,
    attachRenderOptions(opts),
  );
}

export function registerAttachCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('attach [session-id]')
      .description('Connect a TUI client to a running background session'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    const projectDir = await canonicalizeProjectDir(opts);
    const resolvedId = await resolveSessionAlias(sessionId, projectDir);
    await attachCommand(resolvedId, { ...opts, projectDir });
  });
}
