import type { Command } from 'commander';
import ansis from 'ansis';
import { createPlanner } from '../../engine/runners/factory.js';
import type { PlanResult } from '../../engine/planners/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import { ensureGitAndConfig, resolveProjectDir, loadConfigOrExit } from '../setup.js';
import { withCliErrors } from '../errors.js';
import { printConfigWarnings } from '../build-overrides.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { beginSession } from '../../core/sessions/lifecycle.js';
import { clearStaleSession } from '../../core/sessions/guards.js';
import { ensureHooksTrusted } from '../hook-trust-prompt.js';
import { resolveHooksConfig } from '../../engine/hooks/discover.js';
import { rejectUntrustedRunners } from '../../engine/runners/trust.js';

type SpecOpts = { auto: boolean; project?: string; allowHooks: boolean };

export function registerSpecCommand(program: Command): void {
  program
    .command('spec <feature>')
    .description('Generate spec, plan, and tasks only (no implementation)')
    .option('--auto', 'Auto-approve spec and plan', false)
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .action(async (feature: string, opts: SpecOpts) => {
      const projectDir = resolveProjectDir(opts.project);
      await ensureGitAndConfig(projectDir);

      clearStaleSession(projectDir);

      const { config: baseConfig, warnings } = loadConfigOrExit(projectDir);
      const mergedHooks = await resolveHooksConfig(projectDir, baseConfig.hooks);
      await ensureHooksTrusted({ projectDir, hooks: mergedHooks, allowHooks: opts.allowHooks });
      rejectUntrustedRunners(baseConfig, projectDir, opts.allowHooks);
      printConfigWarnings(warnings);
      const config = opts.auto
        ? {
            ...baseConfig,
            workflow: { ...baseConfig.workflow, autoApproveSpec: true, autoApprovePlan: true },
          }
        : baseConfig;

      const sessionId = beginSession(projectDir, feature);

      const planner = await createPlanner(config);

      console.log(
        `Planning feature: ${feature} (planner: ${getRunnerDisplayName(config.planner)})\n`,
      );

      const result: PlanResult = await withCliErrors(() =>
        planner.plan({
          feature,
          projectDir,
          callbacks: {
            onOutput(text: string) {
              process.stdout.write(text);
            },
            onPhase(phase: Phase) {
              console.log(`\n${ansis.bold(`--- ${phase} ---`)}\n`);
            },
            sessionId,
          },
        }),
      );

      for (const phase of result.phases ?? []) {
        writeSpecFile({ projectDir, sessionId }, phase.filename, phase.text);
      }

      const sessionPath = sessionDir(projectDir, sessionId);
      console.log('\nSpec generation complete.');
      console.log(`  Session: ${ansis.dim(sessionId)}`);
      console.log(`  Spec:  ${ansis.dim(`${sessionPath}/${SPEC_FILE}`)}`);
      console.log(`  Plan:  ${ansis.dim(`${sessionPath}/${PLAN_FILE}`)}`);
      console.log(
        `  Tasks: ${ansis.dim(`${sessionPath}/${TASKS_FILE}`)} (${result.tasks.length} tasks)`,
      );
    });
}
