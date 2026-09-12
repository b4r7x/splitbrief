import type { Command } from 'commander';
import ansis from 'ansis';
import { loadState } from '../../core/state/persistence.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
} from '../../core/state/selectors.js';
import { canonicalizeProjectDir } from '../setup.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { formatModelName } from '../../core/model-display.js';
import { stripTerminalControls } from '../../utils/display-text.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current workflow state')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (opts: { project?: string }) => {
      const projectDir = await canonicalizeProjectDir(opts);

      const sessionId = readActive(projectDir);
      const state = sessionId ? loadState({ projectDir, sessionId }) : null;

      if (!state) {
        console.log('No active workflow.');
      } else {
        console.log(
          `${ansis.dim('Feature:')}  ${ansis.bold(stripTerminalControls(state.feature))}`,
        );
        const phaseSuffix = state.awaitingContinue ? ` ${ansis.yellow('(awaiting continue)')}` : '';
        console.log(`${ansis.dim('Phase:')}    ${ansis.bold(state.phase)}${phaseSuffix}`);
        console.log(
          `${ansis.dim('Task:')}     ${state.currentTaskIndex + 1}/${state.tasks.length}`,
        );
        console.log(`${ansis.dim('Started:')}  ${state.startedAt}`);
        console.log(`${ansis.dim('Session:')}  ${sessionId}`);

        if (state.plannerTool) {
          const model = state.plannerModel
            ? ` (${stripTerminalControls(formatModelName(state.plannerModel))})`
            : '';
          console.log(
            `${ansis.dim('Planner:')}  ${stripTerminalControls(getProviderDisplayName(state.plannerTool))}${model}`,
          );
        }
        if (state.implementerTool) {
          const model = state.implementerModel
            ? ` (${stripTerminalControls(formatModelName(state.implementerModel))})`
            : '';
          console.log(
            `${ansis.dim('Impl:')}     ${stripTerminalControls(getProviderDisplayName(state.implementerTool))}${model}`,
          );
        }

        const completed = getCompletedTaskIds(state);
        const escalated = getEscalatedTaskIds(state);
        const failed = getFailedTaskIds(state);
        if (completed.length > 0) {
          console.log(`${ansis.dim('Done:')}     ${ansis.green(String(completed.length))}`);
        }
        if (escalated.length > 0) {
          console.log(`${ansis.dim('Escalated:')} ${ansis.yellow(String(escalated.length))}`);
        }
        if (failed.length > 0) {
          console.log(`${ansis.dim('Failed:')}   ${ansis.red(String(failed.length))}`);
        }
      }
    });
}
