import type { Command } from 'commander';
import ansis from 'ansis';
import { resolveProjectDir } from '../setup.js';
import { readStats, rebuildStats } from '../../core/stats/persistence.js';
import { formatCost } from '../../core/formatting.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { listAllSessions } from '../../core/sessions/io.js';
import { withCliErrors } from '../errors.js';
import { writeJsonLine } from '../json-line.js';
import { countNoun } from '../../utils/pluralize.js';
import type { StatsUpdateInput } from '../../core/stats/persistence.js';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show cumulative cost savings across all sessions')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--rebuild', 'Rebuild stats from session history')
    .option('--json', 'Emit machine-readable JSON output', false)
    .action((opts: { project?: string; rebuild?: boolean; json?: boolean }) =>
      withCliErrors(() => {
        const projectDir = resolveProjectDir(opts.project);

        if (opts.rebuild) {
          const sessions = listAllSessions(projectDir);
          const inputs: StatsUpdateInput[] = [];
          for (const session of sessions) {
            if (session.status !== 'complete') continue;
            if (!session.summary?.costBreakdown) continue;
            inputs.push({
              costBreakdown: session.summary.costBreakdown,
              totalTasks: session.summary.totalTasks,
              completedByLocal: session.summary.completedByLocal,
              escalatedToPlanner: session.summary.escalatedToPlanner,
              providerCosts: session.summary.costBreakdown.providerCosts,
            });
          }
          rebuildStats(projectDir, inputs);
          if (!opts.json) console.log(`Rebuilt stats from ${inputs.length} session(s).`);
        }

        const stats = readStats(projectDir);

        if (opts.json) {
          writeJsonLine({ type: 'stats', stats });
          return;
        }

        if (stats.totalSessions === 0) {
          console.log('No completed sessions with cost data yet.');
          console.log(ansis.dim('Run a workflow to start tracking savings.'));
          return;
        }

        console.log(
          ansis.bold.green(
            `\n  SPLITBRIEF savings: ${formatCost(stats.totalSavings)} saved across ${countNoun(stats.totalSessions, 'session')}\n`,
          ),
        );
        console.log(`  ${ansis.dim('Total spent:')}          ${formatCost(stats.totalCost)}`);
        console.log(
          `  ${ansis.dim('All-planner would be:')} ${formatCost(stats.totalHypotheticalCost)}`,
        );
        console.log(
          `  ${ansis.dim('Savings rate:')}         ${Math.round(stats.averageSavingsPercentage)}%`,
        );
        console.log(
          `  ${ansis.dim('Tasks completed:')}      ${stats.totalTasks} (${stats.totalLocalTasks} local, ${stats.totalEscalatedTasks} escalated)`,
        );

        const providers = Object.entries(stats.providerTotals);
        if (providers.length > 0) {
          console.log(`\n  ${ansis.bold('By Provider:')}`);
          for (const [id, data] of providers) {
            const name = getProviderDisplayName(id);
            console.log(
              `    ${ansis.dim(`${name}:`)}  ${formatCost(data.cost)} (${countNoun(data.sessions, 'session')})`,
            );
          }
        }

        console.log(ansis.dim(`\n  Last updated: ${stats.updatedAt}`));
      }),
    );
}
