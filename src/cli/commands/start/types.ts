import type { renderApp } from '../../render/app.js';
import type { runHeadless } from '../../headless.js';
import type { runRpc } from '../../rpc/run/host.js';
import type { initStores } from '../../init-stores.js';
import type { SpawnServerResult } from '../../../engine/ipc/detached-handshake.js';
import type { SpawnServerOptions } from '../../../engine/ipc/server-invocation.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { GitClient } from '../../../lib/git/client.js';
import type { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';

export interface StartDeps {
  spawnServer: (opts: SpawnServerOptions) => Promise<SpawnServerResult>;
  runHeadless: typeof runHeadless;
  runRpc: typeof runRpc;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  prepareExecution?: typeof prepareExecution | undefined;
}

export interface CreatedWorktree {
  slug: string;
  baseProjectDir: string;
  git: GitClient;
}

export interface DispatchArgs {
  deps: StartDeps;
  projectDir: string;
  feature: string | undefined;
  enrichedFeature: string | undefined;
  plannerContext: string | undefined;
  opts: WorkflowOpts;
  attachments?: Array<{ id: string; path: string; mimeType: string }>;
}

export type RequiredFeatureDispatchArgs = DispatchArgs & { feature: string };

/**
 * Interactive starts mount Ink before preparation resolves, so the mount is not
 * the run dispatch: `handOffWorktree` marks the point where a `--worktree` run
 * stops being eligible for startup rollback.
 */
export type InteractiveDispatchArgs = DispatchArgs & { handOffWorktree: () => void };
