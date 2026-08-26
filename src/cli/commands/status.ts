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
import { listAllSessions, readSessionPersistTranscript } from '../../core/sessions/io.js';
import { aggregateSessionCosts } from '../../core/sessions/analytics.js';
import { formatCost } from '../../core/formatting.js';
import { countNoun } from '../../utils/pluralize.js';
import { labelError } from '../../utils/format-errors.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { formatModelName } from '../../core/model-display.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { loadConfig } from '../../core/config/load/io.js';
import { consoleWorkflowFeature } from '../../core/transcript-policy.js';

function printCostHistory(projectDir: string): void {
  try {
    const sessions = listAllSessions(projectDir);

    const analytics = aggregateSessionCosts(sessions);

    if (analytics.completedSessions === 0) {
      console.log(ansis.dim('No completed sessions with cost data.'));
      return;
    }

    console.log(
      `\n${ansis.bold(`Cost History (${countNoun(analytics.completedSessions, 'session')})`)}`,
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
        const name = stripTerminalControls(getProviderDisplayName(id));
        console.log(
          `    ${ansis.dim(`${name}:`)}  ${formatCost(data.cost)} (${countNoun(data.sessions, 'session')})`,
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
    .action(async (opts: { project?: string; history?: boolean }) => {
      const projectDir = await canonicalizeProjectDir(opts);

      const sessionId = readActive(projectDir);
      const state = sessionId ? loadState({ projectDir, sessionId }) : null;
      const persistTranscript = sessionId
        ? loadConfig(projectDir).config.workflow.persistTranscript &&
          readSessionPersistTranscript({ projectDir, sessionId })
        : true;

      if (!state) {
        console.log('No active workflow.');
        if (!opts.history) {
          console.log(ansis.dim('  Run `splitbrief status --history` to see past sessions.'));
        }
      } else {
        console.log(
          `${ansis.dim('Feature:')}  ${ansis.bold(consoleWorkflowFeature({ feature: state.feature, persistTranscript }))}`,
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

      if (opts.history) {
        printCostHistory(projectDir);
      }
    });
}
