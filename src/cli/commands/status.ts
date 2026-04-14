import { Command } from 'commander';
import ansis from 'ansis';
import { loadState } from '../../core/state/persistence.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
} from '../../core/state/selectors.js';
import { resolveProjectDir } from '../workflow.js';
import { listSessions, getSessionDir } from '../../core/sessions/io.js';
import { aggregateSessionCosts } from '../../core/sessions/analytics.js';
import { formatCost, labelError } from '../../utils/format.js';
import { getProviderDisplayName } from '../../core/providers.js';
import { formatModelName } from '../../core/model-display.js';

function printCostHistory(projectDir: string): void {
  try {
    const projectSessions = listSessions(getSessionDir('project', projectDir));
    const globalSessions = listSessions(getSessionDir('global', projectDir));

    const seen = new Set(projectSessions.map(s => s.id));
    const merged = [...projectSessions];
    for (const s of globalSessions) {
      if (!seen.has(s.id)) merged.push(s);
    }

    const analytics = aggregateSessionCosts(merged);

    if (analytics.completedSessions === 0) {
      console.log(ansis.dim('No completed sessions with cost data.'));
      return;
    }

    console.log(
      `\n${ansis.bold(`Cost History (${analytics.completedSessions} session${analytics.completedSessions === 1 ? '' : 's'})`)}`,
    );
    console.log(`  ${ansis.dim('Total spent:')}    ${formatCost(analytics.totalCost)}`);
    console.log(`  ${ansis.dim('Total saved:')}    ~${formatCost(analytics.totalSavings)}`);
    console.log(
      `  ${ansis.dim('Avg savings:')}    ${Math.round(analytics.averageSavingsPercentage)}%`,
    );
    console.log(
      `  ${ansis.dim('Avg local rate:')} ${Math.round(analytics.averageLocalCompletionRate)}%`,
    );

    const providers = Object.entries(analytics.providerTotals);
    if (providers.length > 0) {
      console.log(`\n  ${ansis.bold('By Provider:')}`);
      for (const [id, data] of providers) {
        const name = getProviderDisplayName(id);
        console.log(
          `    ${ansis.dim(`${name}:`)}  ${formatCost(data.cost)} (${data.sessions} session${data.sessions === 1 ? '' : 's'})`,
        );
      }
    }
  } catch (err) {
    console.error(labelError('Cannot load session history', err));
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current workflow state')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--history', 'Show cost history across sessions')
    .action((opts: { project?: string; history?: boolean }) => {
      const projectDir = resolveProjectDir(opts.project);

      const state = loadState(projectDir);

      if (!state) {
        console.log('No active workflow.');
        if (!opts.history) {
          console.log(ansis.dim('  Run `tiny-spec status --history` to see past sessions.'));
        }
      } else {
        console.log(`${ansis.dim('Feature:')}  ${ansis.bold(state.feature)}`);
        console.log(`${ansis.dim('Phase:')}    ${ansis.bold(state.phase)}`);
        console.log(`${ansis.dim('Task:')}     ${state.currentTaskIndex + 1}/${state.tasks.length}`);
        console.log(`${ansis.dim('Started:')}  ${state.startedAt}`);

        if (state.plannerTool) {
          const model = state.plannerModel ? ` (${formatModelName(state.plannerModel)})` : '';
          console.log(`${ansis.dim('Planner:')}  ${getProviderDisplayName(state.plannerTool)}${model}`);
        }
        if (state.implementerTool) {
          const model = state.implementerModel ? ` (${formatModelName(state.implementerModel)})` : '';
          console.log(`${ansis.dim('Impl:')}     ${getProviderDisplayName(state.implementerTool)}${model}`);
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

      if (opts.history) {
        printCostHistory(projectDir);
      }
    });
}
