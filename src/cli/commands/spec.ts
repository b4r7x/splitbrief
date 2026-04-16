import { Command } from 'commander';
import ansis from 'ansis';
import { createPlanner, type PlanResult } from '../../engine/index.js';
import { getRunnerDisplayName } from '../../core/config/index.js';
import { ensureGitAndConfig, resolveProjectDir, loadConfigOrExit } from '../workflow.js';
import { cliError } from '../errors.js';
import { toErrorMessage } from '../../utils/format.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { beginSession } from '../../core/sessions/begin.js';
import { clearStaleActiveSessionOrThrow } from './guards.js';

type SpecOpts = { auto: boolean; project?: string };

export function registerSpecCommand(program: Command): void {
  program
    .command('spec <feature>')
    .description('Generate spec, plan, and tasks only (no implementation)')
    .option('--auto', 'Auto-approve spec and plan', false)
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (feature: string, opts: SpecOpts) => {
      const projectDir = resolveProjectDir(opts.project);
      await ensureGitAndConfig(projectDir);

      clearStaleActiveSessionOrThrow(projectDir);

      const baseConfig = loadConfigOrExit(projectDir);
      const config = opts.auto
        ? {
            ...baseConfig,
            workflow: { ...baseConfig.workflow, autoApproveSpec: true, autoApprovePlan: true },
          }
        : baseConfig;

      const sessionId = beginSession(projectDir, feature);

      const planner = createPlanner(config);

      console.log(`Planning feature: ${feature} (planner: ${getRunnerDisplayName(config.planner)})\n`);

      let result: PlanResult;
      try {
        result = await planner.plan(feature, projectDir, {
          onOutput(text: string) {
            process.stdout.write(text);
          },
          onPhase(phase: string) {
            console.log(`\n${ansis.bold(`--- ${phase} ---`)}\n`);
          },
          sessionId,
        });
      } catch (err) {
        throw cliError(toErrorMessage(err));
      }

      for (const phase of result.phases ?? []) {
        writeSpecFile(projectDir, sessionId, phase.filename, phase.text);
      }

      const sessionPath = sessionDir(projectDir, sessionId);
      console.log('\nSpec generation complete.');
      console.log(`  Session: ${ansis.dim(sessionId)}`);
      console.log(`  Spec:  ${ansis.dim(`${sessionPath}/${SPEC_FILE}`)}`);
      console.log(`  Plan:  ${ansis.dim(`${sessionPath}/${PLAN_FILE}`)}`);
      console.log(`  Tasks: ${ansis.dim(`${sessionPath}/${TASKS_FILE}`)} (${result.tasks.length} tasks)`);
    });
}
