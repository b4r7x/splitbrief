#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import App from './app.js';
import { loadConfig, initConfig, createDefaultConfig } from './config.js';
import { loadState } from './state.js';
import { detectLocalModels } from './orchestrator/providers.js';
import { planFeature } from './orchestrator/planner.js';
import { isGitRepo } from './utils/git.js';

function resolveProjectDir(dir?: string): string {
  return resolve(dir ?? process.cwd());
}

async function promptSelection(question: string, options: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<number>((res) => {
    console.log(question);
    options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
    rl.question('Selection: ', (answer) => {
      rl.close();
      const n = parseInt(answer, 10);
      if (n >= 1 && n <= options.length) {
        res(n - 1);
      } else {
        res(0);
      }
    });
  });
}

const program = new Command();

program
  .name('tiny-spec')
  .version('0.1.0')
  .description('Cost-optimized AI coding orchestrator');

// ── start ──────────────────────────────────────────────

program
  .command('start <feature>')
  .description('Full workflow: plan with Claude, implement with local model')
  .option('--auto', 'Auto-approve spec and plan', false)
  .option('--model <model>', 'Override implementer model')
  .option('--provider <provider>', 'Override implementer provider')
  .option('--project <dir>', 'Project directory (default: cwd)')
  .action(async (feature: string, opts: { auto: boolean; model?: string; provider?: string; project?: string }) => {
    const projectDir = resolveProjectDir(opts.project);

    if (!(await isGitRepo(projectDir))) {
      console.error('Error: not a git repository. Run `git init` first.');
      process.exit(1);
    }

    const configPath = resolve(projectDir, '.tiny-spec', 'config.yaml');
    if (!existsSync(configPath)) {
      console.log('No config found. Creating default .tiny-spec/config.yaml');
      initConfig(projectDir);
    }

    const config = loadConfig(projectDir);
    if (opts.model) config.implementer.model = opts.model;
    if (opts.provider) config.implementer.provider = opts.provider as typeof config.implementer.provider;

    render(createElement(App, {
      feature,
      projectDir,
      auto: opts.auto,
      modelOverride: opts.model,
      providerOverride: opts.provider,
    }));
  });

// ── spec ───────────────────────────────────────────────

program
  .command('spec <feature>')
  .description('Generate spec, plan, and tasks only (no implementation)')
  .option('--auto', 'Auto-approve spec and plan', false)
  .option('--project <dir>', 'Project directory (default: cwd)')
  .action(async (feature: string, opts: { auto: boolean; project?: string }) => {
    const projectDir = resolveProjectDir(opts.project);

    if (!(await isGitRepo(projectDir))) {
      console.error('Error: not a git repository. Run `git init` first.');
      process.exit(1);
    }

    const configPath = resolve(projectDir, '.tiny-spec', 'config.yaml');
    if (!existsSync(configPath)) {
      console.log('No config found. Creating default .tiny-spec/config.yaml');
      initConfig(projectDir);
    }

    const config = loadConfig(projectDir);

    console.log(`Planning feature: ${feature}\n`);

    const result = await planFeature(feature, projectDir, config, {
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

// ── init ───────────────────────────────────────────────

program
  .command('init')
  .description('Create .tiny-spec/config.yaml with detected models')
  .option('--reconfigure', 'Overwrite existing config', false)
  .action(async (opts: { reconfigure: boolean }) => {
    const projectDir = resolveProjectDir();
    const configPath = resolve(projectDir, '.tiny-spec', 'config.yaml');

    if (existsSync(configPath) && !opts.reconfigure) {
      console.log('Config already exists at .tiny-spec/config.yaml');
      console.log('Use --reconfigure to overwrite.');
      return;
    }

    console.log('Detecting local models...\n');
    const providers = await detectLocalModels();

    if (providers.length === 0) {
      console.log('No local model providers detected (Ollama, LM Studio).');
      console.log('Creating config with defaults (ollama / qwen2.5-coder:7b).');
      console.log('Start Ollama or LM Studio and run `tiny-spec init --reconfigure`.\n');
      initConfig(projectDir);
      console.log('Created .tiny-spec/config.yaml');
      return;
    }

    const allModels: Array<{ provider: string; model: string }> = [];
    for (const p of providers) {
      console.log(`${p.provider}: ${p.models.length} model(s)`);
      for (const m of p.models) {
        allModels.push({ provider: p.provider, model: m });
      }
    }

    console.log('');

    let selected: { provider: string; model: string };

    if (allModels.length === 1) {
      selected = allModels[0];
      console.log(`Auto-selected: ${selected.provider} / ${selected.model}`);
    } else {
      const options = allModels.map((m) => `${m.provider} / ${m.model}`);
      const idx = await promptSelection('Select a model for implementation:', options);
      selected = allModels[idx];
    }

    const defaults = createDefaultConfig();
    defaults.implementer.provider = selected.provider as typeof defaults.implementer.provider;
    defaults.implementer.model = selected.model;

    const providerBases: Record<string, string> = {
      ollama: 'http://localhost:11434/v1',
      'lm-studio': 'http://localhost:1234/v1',
    };
    defaults.implementer.apiBase = providerBases[selected.provider] ?? defaults.implementer.apiBase;

    // Write config manually to support --reconfigure (initConfig skips if exists)
    const fs = await import('node:fs');
    const path = await import('node:path');
    const YAML = await import('yaml');

    const dirPath = path.join(projectDir, '.tiny-spec');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(dirPath, 'config.yaml'),
      YAML.stringify(defaults),
      'utf-8',
    );

    console.log(`\nCreated .tiny-spec/config.yaml (${selected.provider} / ${selected.model})`);
  });

// ── status ─────────────────────────────────────────────

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

// ── resume ─────────────────────────────────────────────

program
  .command('resume')
  .description('Resume an interrupted workflow')
  .option('--auto', 'Auto-approve spec and plan', false)
  .option('--model <model>', 'Override implementer model')
  .option('--provider <provider>', 'Override implementer provider')
  .option('--project <dir>', 'Project directory (default: cwd)')
  .action(async (opts: { auto: boolean; model?: string; provider?: string; project?: string }) => {
    const projectDir = resolveProjectDir(opts.project);
    const state = loadState(projectDir);

    if (!state) {
      console.error('Error: no saved workflow to resume.');
      process.exit(1);
    }

    const nonResumable = new Set(['idle', 'researching', 'specifying', 'planning', 'complete']);
    if (nonResumable.has(state.phase)) {
      console.error(`Error: workflow is in '${state.phase}' phase and cannot be resumed.`);
      console.error('Use `tiny-spec start` to begin a new workflow.');
      process.exit(1);
    }

    console.log(`Resuming: ${state.feature} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`);

    render(createElement(App, {
      feature: state.feature,
      projectDir,
      auto: opts.auto,
      modelOverride: opts.model,
      providerOverride: opts.provider,
    }));
  });

program.parse();
