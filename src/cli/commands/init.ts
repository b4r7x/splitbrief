import { Command } from 'commander';
import { createElement } from 'react';
import { existsSync } from 'node:fs';
import { App } from '../../app.js';
import { configPath, initConfig } from '../../core/config/load/load.js';
import { renderApp } from '../render.js';
import { resolveProjectDir } from '../setup.js';
import { initStores } from '../init-stores.js';
import { routerStore } from '../../stores/navigation/router.js';
import { DIPTYCH_DIR, CONFIG_FILE } from '../../core/paths.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(`Create ${DIPTYCH_DIR}/${CONFIG_FILE} with detected models`)
    .option('--reconfigure', 'Overwrite existing config', false)
    .action(async (opts: { reconfigure: boolean }) => {
      const projectDir = resolveProjectDir();

      if (existsSync(configPath(projectDir)) && !opts.reconfigure) {
        console.log(`Config already exists at ${DIPTYCH_DIR}/${CONFIG_FILE}`);
        console.log('Use --reconfigure to overwrite.');
        return;
      }

      initConfig(projectDir, { force: opts.reconfigure });
      await initStores(projectDir);
      routerStore.init({ screen: 'setup', onComplete: 'home' });
      await renderApp(createElement(App), { fullscreen: true });
    });
}
