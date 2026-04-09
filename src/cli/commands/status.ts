import { Command } from 'commander';
import ansis from 'ansis';
import { loadState } from '../../core/state/persistence.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
} from '../../core/state/selectors.js';
import { resolveProjectDir } from '../workflow.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current workflow state')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action((opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      const state = loadState(projectDir);

      if (!state) {
        console.log('No active workflow.');
        return;
      }

      console.log(`${ansis.dim('Feature:')}  ${ansis.bold(state.feature)}`);
      console.log(`${ansis.dim('Phase:')}    ${ansis.bold(state.phase)}`);
      console.log(`${ansis.dim('Task:')}     ${state.currentTaskIndex + 1}/${state.tasks.length}`);
      console.log(`${ansis.dim('Started:')}  ${state.startedAt}`);

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
    });
}
