import { Command } from 'commander';
import ansis from 'ansis';
import { createPlanner, type PlanResult } from '../../engine/index.js';
import { getPlannerToolName } from '../../core/config/planner-config.js';
import { ensureGitAndConfig, resolveProjectDir, loadConfigOrExit } from '../workflow.js';
import { cliError } from '../errors.js';
import { toErrorMessage } from '../../utils/format.js';
import { TINY_SPEC_DIR, CURRENT_DIR, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';

export function registerSpecCommand(program: Command): void {
  program
    .command('spec <feature>')
    .description('Generate spec, plan, and tasks only (no implementation)')
    .option('--auto', 'Auto-approve spec and plan', false)
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (feature: string, opts: { auto: boolean; project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      await ensureGitAndConfig(projectDir);

      const config = loadConfigOrExit(projectDir);
      if (opts.auto) {
        config.workflow.autoApproveSpec = true;
        config.workflow.autoApprovePlan = true;
      }
      const planner = await createPlanner(config);

      console.log(`Planning feature: ${feature} (planner: ${getPlannerToolName(config.planner)})\n`);

      let result: PlanResult;
      try {
        result = await planner.plan(feature, projectDir, {
          onOutput(text: string) {
            process.stdout.write(text);
          },
          onPhase(phase: string) {
            console.log(`\n${ansis.bold(`--- ${phase} ---`)}\n`);
          },
        });
      } catch (err) {
        throw cliError(toErrorMessage(err));
      }

      const currentPath = `${TINY_SPEC_DIR}/${CURRENT_DIR}`;
      console.log('\nSpec generation complete.');
      console.log(`  Spec:  ${ansis.dim(`${currentPath}/${SPEC_FILE}`)}`);
      console.log(`  Plan:  ${ansis.dim(`${currentPath}/${PLAN_FILE}`)}`);
      console.log(`  Tasks: ${ansis.dim(`${currentPath}/${TASKS_FILE}`)} (${result.tasks.length} tasks)`);
    });
}
