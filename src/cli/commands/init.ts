import type { Command } from 'commander';
import { createElement } from 'react';
import { existsSync } from 'node:fs';
import { App } from '../../app/root.js';
import { configPath } from '../../core/config/load/document.js';
import { renderApp } from '../render/app.js';
import { canonicalizeProjectDir, assertInteractiveTty, ensureHeadlessConfig } from '../setup.js';
import { initStores } from '../bootstrap/init.js';
import { routerStore } from '../../stores/navigation/router.js';
import { withHeldDiagnostics } from '../../lib/warn.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../core/paths.js';

export interface InitDeps {
  initStores: typeof initStores;
  renderApp: typeof renderApp;
}

export const defaultInitDeps: InitDeps = {
  initStores,
  renderApp,
};

export function registerInitCommand(program: Command, deps: InitDeps = defaultInitDeps): void {
  program
    .command('init')
    .description(`Create ${SPLITBRIEF_DIR}/${CONFIG_FILE} with detected models`)
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--reconfigure', 'Overwrite existing config', false)
    .option('--yes', 'Save a detected ready crew without the interactive picker', false)
    .action(async (opts: InitOpts) => {
      // The setup screen shows what an interactive init raises from its first step.
      const init = () => initProject(opts, deps);
      await (opts.yes ? init() : withHeldDiagnostics(init));
    });
}

type InitOpts = { project?: string; reconfigure: boolean; yes: boolean };

async function initProject(opts: InitOpts, deps: InitDeps): Promise<void> {
  const projectDir = await canonicalizeProjectDir(opts);

  if (existsSync(configPath(projectDir)) && !opts.reconfigure) {
    console.log(`Config already exists at ${SPLITBRIEF_DIR}/${CONFIG_FILE}`);
    console.log('Use --reconfigure to overwrite.');
    return;
  }

  if (opts.yes) {
    await ensureHeadlessConfig({ projectDir, reconfigure: opts.reconfigure });
    console.log('Run `splitbrief doctor` to check readiness before your first run.');
    return;
  }

  assertInteractiveTty('use --yes to save a detected ready crew without the picker');

  await deps.initStores(projectDir);
  routerStore.init({ screen: 'setup', onComplete: 'home' });
  await deps.renderApp(createElement(App), { fullscreen: true });
}
