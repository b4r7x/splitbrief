import type { renderApp } from '../../render/app.js';
import type { runHeadless } from '../../headless.js';
import type { runRpc } from '../../rpc/run/host.js';
import type { initStores } from '../../init-stores.js';
import type { SpawnServerOptions, SpawnServerResult } from '../../../engine/ipc/spawn-server.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ApproveLevel } from '../../../core/schemas/enums.js';
import type { CollectedReadiness } from '../../../core/readiness/collect.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import type { CliReadinessResult } from '../../../core/schemas/readiness.js';
import type { CliStartGates } from '../../../engine/runners/start-gate.js';
import type { GitClient } from '../../../lib/git/client.js';

export interface StartDeps {
  spawnServer: (opts: SpawnServerOptions) => Promise<SpawnServerResult>;
  runHeadless: typeof runHeadless;
  runRpc: typeof runRpc;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  /** Live, uncached CLI readiness used to establish execution start gates. */
  detectCliReadiness?: DetectCliReadiness | undefined;
}

export type DetectCliReadiness = (input: {
  projectDir: string;
  config: Config;
  opts: WorkflowOpts;
}) => Promise<readonly CliReadinessResult[]>;

export interface CreatedWorktree {
  slug: string;
  baseProjectDir: string;
  git: GitClient;
}

export interface BootstrapSessionArgs {
  projectDir: string;
  feature: string;
  opts: WorkflowOpts;
  assertJson: boolean;
  emitReadiness: (report: ReadinessReport) => void;
  cliReadiness?: readonly CliReadinessResult[] | undefined;
  detectCliReadiness?: DetectCliReadiness | undefined;
  defaultApprove?: ApproveLevel | undefined;
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

export type BootstrapSessionResult = {
  sessionId: string;
  readiness: CollectedReadiness;
  trustedCliGates: CliStartGates;
};
