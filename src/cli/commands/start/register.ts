import type { Command } from 'commander';
import { addWorkflowOptions, assertModeFlagsExclusive } from '../../options.js';
import { canonicalizeProjectDir } from '../../setup.js';
import { initStores } from '../../init-stores.js';
import { runHeadless } from '../../headless.js';
import { runRpc } from '../../rpc/run/host.js';
import { renderApp } from '../../render/app.js';
import { spawnServer } from '../../../engine/ipc/spawn-server.js';
import { parseAtFiles } from '../../parse-at-files.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { cliError } from '../../errors.js';
import { assertNotWindows } from '../../windows-guard.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import { applyWorktreeOption, rollbackCreatedWorktree } from './worktree.js';
import { runDetachedStart } from './detached.js';
import { runJsonStart, runRpcStart } from './streaming.js';
import { runInteractiveStart } from './interactive.js';
import type { StartDeps } from './types.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution.js';

export const defaultStartDeps: StartDeps = {
  spawnServer,
  runHeadless,
  runRpc,
  initStores,
  renderApp,
  prepareExecution,
};

export function registerStartCommand(program: Command, deps: StartDeps = defaultStartDeps): void {
  addWorkflowOptions(
    program
      .command('start [feature] [files...]', { isDefault: true })
      .description('Full workflow: the planner plans and reviews, the implementer executes')
      .option('--detach', 'spawn workflow as background server and exit', false),
  ).action(async (feature: string | undefined, files: string[], opts: WorkflowOpts) => {
    if (opts.detach) {
      assertNotWindows();
      if (!feature) throw cliError('--detach requires a feature argument');
      if (opts.json) throw cliError('--detach and --json cannot be combined');
      if (opts.rpc) throw cliError('--detach and --rpc cannot be combined');
    }
    assertModeFlagsExclusive(opts);
    if (opts.rpc && !feature) throw cliError('--rpc requires a feature argument');
    if (opts.json && !feature) throw cliError('--json requires a feature argument');

    let createdWorktree = await applyWorktreeOption(feature, opts);
    const handOffCreatedWorktree = (): void => {
      createdWorktree = null;
    };
    const runDeps: StartDeps = {
      ...deps,
      runHeadless: (options) => {
        handOffCreatedWorktree();
        return deps.runHeadless(options);
      },
      runRpc: (options) => {
        handOffCreatedWorktree();
        return deps.runRpc(options);
      },
    };

    try {
      const projectDir = await canonicalizeProjectDir(opts);

      let enrichedFeature = feature;
      let plannerContext: string | undefined;
      const parsedAttachments: Array<{ id: string; path: string; mimeType: string }> = [];
      if (feature && files.length > 0) {
        const parsed = parseAtFiles(feature, files, projectDir);
        enrichedFeature = parsed.feature;
        if (parsed.textContext) plannerContext = parsed.textContext;
        for (const att of parsed.attachments) {
          attachmentsStore.add(att);
          parsedAttachments.push({ id: att.id, path: att.path, mimeType: att.mimeType });
        }
        for (const err of parsed.errors) {
          console.error(`Warning: @${stripTerminalControls(err.path)}: ${err.reason}`);
        }
      }

      if ((opts.detach || opts.json || opts.rpc) && feature) {
        const dispatch = {
          deps: runDeps,
          projectDir,
          feature,
          enrichedFeature,
          plannerContext,
          opts,
          ...(parsedAttachments.length > 0 && { attachments: parsedAttachments }),
        };
        if (opts.detach) {
          await runDetachedStart(dispatch);
          return;
        }
        if (opts.json) {
          await runJsonStart(dispatch);
          return;
        }
        await runRpcStart(dispatch);
        return;
      }

      await runInteractiveStart({
        deps: runDeps,
        projectDir,
        feature,
        enrichedFeature,
        plannerContext,
        opts,
        handOffWorktree: handOffCreatedWorktree,
      });
    } catch (err) {
      if (createdWorktree) await rollbackCreatedWorktree(createdWorktree);
      throw err;
    }
  });
}
