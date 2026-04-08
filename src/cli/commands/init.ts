import { Command } from 'commander';
import { createElement } from 'react';
import { existsSync } from 'node:fs';
import App from '../../app.js';
import { configPath, initConfig } from '../../core/config/index.js';
import { renderApp } from '../render.js';
import { resolveProjectDir } from '../workflow.js';
import { configStore } from '../../stores/config.js';
import { routerStore } from '../../stores/router.js';

export function registerInitCommand(program: Command): void {
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

      initConfig(projectDir, { force: opts.reconfigure });
      configStore.load(projectDir);
      routerStore.init({ screen: 'setup', onComplete: 'home' });
      await renderApp(createElement(App), true);
    });
}
