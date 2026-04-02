#!/usr/bin/env node

import { Command } from 'commander';
import { createElement } from 'react';
import { existsSync } from 'node:fs';
import App from './app.js';
import { configPath } from './core/config.js';
import { loadState } from './state-persistence.js';
import { createPlanner } from './engine/planners/factory.js';
import { runPicker } from './cli/picker.js';
import { renderApp } from './cli/render.js';
import { addWorkflowOptions, setupWorkflow, ensureGitAndConfig, resolveProjectDir, loadConfigOrExit } from './cli/workflow.js';
import type { WorkflowOpts } from './cli/workflow.js';
import type { Phase } from './types.js';

const program = new Command();

program
  .name('tiny-spec')
  .version('0.1.0')
  .description('Cost-optimized AI coding orchestrator');

addWorkflowOptions(
  program
    .command('start [feature]')
    .description('Full workflow: plan with Claude, implement with local model'),
).action(async (feature: string | undefined, opts: WorkflowOpts) => {
    const { projectDir, config, useFullscreen } = await setupWorkflow(opts);

    const appElement = createElement(App, {
      feature,
      projectDir,
      modelOverride: opts.model,
      providerOverride: opts.provider,
      plannerOverride: opts.planner,
      plannerModelOverride: opts.plannerModel,
      contextLengthOverride: config.implementer.contextLength,
    });

    await renderApp(appElement, useFullscreen);
  });

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

program
  .command('init')
  .description('Create .tiny-spec/config.yaml with detected models')
  .option('--reconfigure', 'Overwrite existing config', false)
  .action(async (opts: { reconfigure: boolean }) => {
    const projectDir = resolveProjectDir();

    if (existsSync(configPath(projectDir)) && !opts.reconfigure) {
      console.log('Config already exists at .tiny-spec/config.yaml');
      console.log('Use --reconfigure to overwrite.');
      return;
    }

    await runPicker(projectDir);
  });

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

addWorkflowOptions(
  program
    .command('resume')
    .description('Resume an interrupted workflow'),
).action(async (opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    const state = loadState(projectDir);

    if (!state) {
      console.error('Error: no saved workflow to resume.');
      process.exit(1);
    }

    if (!('stateVersion' in state) || state.stateVersion < 2) {
      console.error('Error: saved state is from an older version and cannot be resumed.');
      console.error('Please start a new workflow with `tiny-spec start`.');
      process.exit(1);
    }

    const RESUMABLE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
      'reviewing-spec', 'reviewing-plan', 'implementing',
      'validating-task', 'escalating', 'final-review',
    ]);
    if (!RESUMABLE_PHASES.has(state.phase)) {
      console.error(`Cannot resume from phase "${state.phase}".`);
      process.exit(1);
    }

    console.log(`Resuming: ${state.feature} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`);

    const { config, useFullscreen } = await setupWorkflow(opts);

    const appElement = createElement(App, {
      feature: state.feature,
      projectDir,
      modelOverride: opts.model,
      providerOverride: opts.provider,
      plannerOverride: opts.planner,
      plannerModelOverride: opts.plannerModel,
      contextLengthOverride: config.implementer.contextLength,
      savedState: state,
    });

    await renderApp(appElement, useFullscreen);
  });

program.parseAsync().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
