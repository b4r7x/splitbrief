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
import { stripTerminalControls } from '../../utils/display-text.js';

type SpecOpts = { project?: string; allowHooks: boolean; allowRepoRunners: boolean };

interface SpecCommandDeps {
  createPlanner?: typeof createPlanner | undefined;
}

export function registerSpecCommand(program: Command, deps: SpecCommandDeps = {}): void {
  const createPlannerForCommand = deps.createPlanner ?? createPlanner;
  program
    .command('spec <feature>')
    .description('Generate spec, plan, and tasks only (no implementation)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option(
      '--allow-repo-runners',
      'Trust repo-local shell/agent runner commands from project config',
      false,
    )
    .action(async (feature: string, opts: SpecOpts) => {
      const projectDir = resolveProjectDir(opts.project);
      await ensureGitAndConfig(projectDir);

      clearStaleSession(projectDir);

      const { config: baseConfig, warnings } = loadConfigOrExit(projectDir);
      const mergedHooks = await resolveHooksConfig(projectDir, baseConfig.hooks);
      await ensureHooksTrusted({ projectDir, hooks: mergedHooks, allowHooks: opts.allowHooks });
      rejectUntrustedRunners(baseConfig, projectDir, opts.allowRepoRunners);
      printConfigWarnings(warnings);

      const sessionId = beginSession(projectDir, feature);

      const planner = await createPlannerForCommand(baseConfig);

      console.log(
        `Planning feature: ${feature} (planner: ${getRunnerDisplayName(baseConfig.planner)})\n`,
      );

      const result: PlanResult = await withCliErrors(() =>
        planner.plan({
          feature,
          projectDir,
          callbacks: {
            onOutput(text: string) {
              process.stdout.write(stripTerminalControls(text));
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
