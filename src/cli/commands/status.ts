import { Command } from 'commander';
import { loadState } from '../../core/state/persistence.js';
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

      console.log(`Feature:  ${state.feature}`);
      console.log(`Phase:    ${state.phase}`);
      console.log(`Task:     ${state.currentTaskIndex + 1}/${state.tasks.length}`);
      console.log(`Started:  ${state.startedAt}`);

      if (state.completedTasks.length > 0) {
        console.log(`Done:     ${state.completedTasks.length}`);
      }
      if (state.escalatedTasks.length > 0) {
        console.log(`Escalated: ${state.escalatedTasks.length}`);
      }
      if (state.failedTasks.length > 0) {
        console.log(`Failed:   ${state.failedTasks.length}`);
      }
    });
}
