import type { renderApp } from '../../render/app.js';
import type { runHeadless } from '../../headless.js';
import type { initStores } from '../../init-stores.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';

export interface StartDeps {
  runHeadless: typeof runHeadless;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  prepareExecution?: typeof prepareExecution | undefined;
}

export interface DispatchArgs {
  deps: StartDeps;
  projectDir: string;
  feature: string | undefined;
  enrichedFeature: string | undefined;
  plannerContext: string | undefined;
  opts: WorkflowOpts;
}

export type RequiredFeatureDispatchArgs = DispatchArgs & { feature: string };

export type InteractiveDispatchArgs = DispatchArgs;
