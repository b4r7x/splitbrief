import type { Command } from 'commander';
import { createElement } from 'react';
import { existsSync } from 'node:fs';
import { App } from '../../app/root.js';
import { initConfig } from '../../core/config/load/io.js';
import { configPath } from '../../core/config/load/document.js';
import { renderApp } from '../render/app.js';
import { canonicalizeProjectDir, assertInteractiveTty } from '../setup.js';
import { initStores } from '../init-stores.js';
import { routerStore } from '../../stores/navigation/router.js';
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
    .option('--yes', 'Write the default config without the interactive picker', false)
    .action(async (opts: { project?: string; reconfigure: boolean; yes: boolean }) => {
      const projectDir = await canonicalizeProjectDir(opts);

      if (existsSync(configPath(projectDir)) && !opts.reconfigure) {
        console.log(`Config already exists at ${SPLITBRIEF_DIR}/${CONFIG_FILE}`);
        console.log('Use --reconfigure to overwrite.');
        return;
      }

      // CI, container builds and piped shells have no picker to drive. They get
      // the same defaults `start` and `spec` already fall back to when no config
      // exists, written deliberately instead of as a side effect of a run.
      if (opts.yes) {
        await initConfig(projectDir, { force: opts.reconfigure });
        console.log(`Wrote ${SPLITBRIEF_DIR}/${CONFIG_FILE}`);
        console.log('Run `splitbrief doctor` to check readiness before your first run.');
        return;
      }

      assertInteractiveTty('use --yes to write the default config without the picker');

      await deps.initStores(projectDir);
      routerStore.init({ screen: 'setup', onComplete: 'home' });
      await deps.renderApp(createElement(App), { fullscreen: true });
    });
}
