import type { Command } from 'commander';
import { addWorkflowOptions } from '../../options.js';
import { canonicalizeProjectDir } from '../../setup.js';
import { initStores } from '../../init-stores.js';
import { runHeadless } from '../../headless.js';
import { renderApp } from '../../render/app.js';
import { parseAtFiles } from '../../parse-at-files.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { cliError } from '../../errors.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import { runHeadlessStart } from './streaming.js';
import { runInteractiveStart } from './interactive.js';
import type { StartDeps } from './types.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';

export const defaultStartDeps: StartDeps = {
  runHeadless,
  initStores,
  renderApp,
  prepareExecution,
};

export function registerStartCommand(program: Command, deps: StartDeps = defaultStartDeps): void {
  addWorkflowOptions(
    program
      .command('start [feature] [files...]', { isDefault: true })
      .description('Full workflow: the planner plans and reviews, the implementer executes'),
  ).action(async (feature: string | undefined, files: string[], opts: WorkflowOpts) => {
    const headlessMode = opts.json === true ? 'json' : opts.plain === true ? 'plain' : undefined;
    if (headlessMode !== undefined && !feature) {
      throw cliError(`--${headlessMode} requires a feature argument`);
    }

    const projectDir = await canonicalizeProjectDir(opts);

    let enrichedFeature = feature;
    let plannerContext: string | undefined;
    if (feature && files.length > 0) {
      const parsed = parseAtFiles(feature, files, projectDir);
      enrichedFeature = parsed.feature;
      if (parsed.textContext) plannerContext = parsed.textContext;
      for (const att of parsed.attachments) {
        attachmentsStore.add(att);
      }
      for (const err of parsed.errors) {
        console.error(`Warning: @${stripTerminalControls(err.path)}: ${err.reason}`);
      }
    }

    if (headlessMode !== undefined && feature) {
      await runHeadlessStart({
        deps,
        projectDir,
        feature,
        enrichedFeature,
        plannerContext,
        opts,
        mode: headlessMode,
      });
      return;
    }

    await runInteractiveStart({
      deps,
      projectDir,
      feature,
      enrichedFeature,
      plannerContext,
      opts,
    });
  });
}
