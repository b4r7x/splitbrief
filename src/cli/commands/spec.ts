import { Command } from 'commander';
import { createPlanner } from '../../engine/planners/factory.js';
import { ensureGitAndConfig, resolveProjectDir, loadConfigOrExit } from '../workflow.js';

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

      console.log(`Planning feature: ${feature} (planner: ${config.planner.tool ?? 'claude-code'})\n`);

      const result = await planner.plan(feature, projectDir, config, {
        onOutput(text: string) {
          process.stdout.write(text);
        },
        onPhase(phase: string) {
          console.log(`\n--- ${phase} ---\n`);
        },
      });

      console.log('\nSpec generation complete.');
      console.log(`  Spec:  .tiny-spec/current/spec.md`);
      console.log(`  Plan:  .tiny-spec/current/plan.md`);
      console.log(`  Tasks: .tiny-spec/current/tasks.md (${result.tasks.length} tasks)`);
    });
}
