import { Command } from 'commander';
import { createElement } from 'react';
import { simpleGit } from 'simple-git';
import { App } from '../../app.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions } from '../options.js';
import { setupWorkflow, resolveProjectDir, ensureGitAndConfig } from '../setup.js';
import { routerStore } from '../../stores/navigation/router.js';
import { initStores } from '../init-stores.js';
import { clearStaleSession } from '../../core/sessions/guards.js';
import { beginSession, generateSessionId } from '../../core/sessions/lifecycle.js';
import { maybeMigrate } from '../../core/migration/executor.js';
import { runHeadless } from '../headless.js';
import { cliError } from '../errors.js';
import { createWorktree, detectWorktree } from '../../engine/git/worktree.js';
import { slugify } from '../../utils/slugify.js';
import { spawnServer } from '../../engine/ipc/spawn-server.js';
import { configPath } from '../../core/config/load/load.js';
import { sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export function registerStartCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('start [feature]')
      .description('Full workflow: plan with Claude, implement with local model')
      .option('--detach', 'spawn workflow as background server and exit', false),
  ).action(async (feature: string | undefined, opts: WorkflowOpts) => {
    if (opts.detach) {
      if (!feature) throw cliError('--detach requires a feature argument');
      if (opts.json) throw cliError('--detach and --json cannot be combined');

      const projectDir = resolveProjectDir(opts.project);
      await maybeMigrate(projectDir);
      await ensureGitAndConfig(projectDir);

      const mode = opts.mode ?? 'standard';
      const sessId = generateSessionId(projectDir, feature);
      const sessDir = sessionDir(projectDir, sessId);
      ensureSessionDir(projectDir, sessId);

      const result = await spawnServer({
        sessionDir: sessDir,
        sessionId: sessId,
        projectDir,
        feature,
        mode,
        configPath: configPath(projectDir),
      });

      if (!result.ok) {
        console.error(`Failed to start server: ${result.reason}`);
        process.exit(1);
      }

      console.log(`Session ${result.sessionId} started (pid ${result.pid}).`);
      console.log(`Run: diptych attach ${result.sessionId}`);
      return;
    }

    if (opts.worktree !== undefined) {
      const slug =
        typeof opts.worktree === 'string' && opts.worktree.length > 0
          ? opts.worktree
          : slugify(feature ?? 'session');
      const baseProjectDir = resolveProjectDir(opts.project);
      const git = simpleGit(baseProjectDir);
      try {
        const wtPath = await createWorktree({ projectDir: baseProjectDir, slug, git });
        console.log(`Starting session in worktree .trees/${slug} (branch diptych/${slug})`);
        opts.project = wtPath;
      } catch (err) {
        throw cliError(err instanceof Error ? err.message : String(err), 1);
      }
    }

    const projectDir = resolveProjectDir(opts.project);
    await maybeMigrate(projectDir);

    if (opts.json) {
      if (!feature) throw cliError('--json requires a feature argument');
      await ensureGitAndConfig(projectDir);
      clearStaleSession(projectDir);
      const sessionId = beginSession(projectDir, feature);
      await runHeadless(feature, projectDir, opts, undefined, sessionId);
      return;
    }

    const { useFullscreen, useMouse, needsSetup } = await setupWorkflow(opts);

    clearStaleSession(projectDir);

    const sessionId = feature ? beginSession(projectDir, feature) : undefined;

    await initStores(projectDir, opts);
    let worktreeName: string | null = null;
    try {
      worktreeName = await detectWorktree(projectDir, simpleGit(projectDir));
    } catch {
      worktreeName = null;
    }
    if (needsSetup) {
      routerStore.init({ screen: 'setup', onComplete: feature ? 'workflow' : 'home', feature });
    } else if (feature) {
      routerStore.init({ screen: 'workflow', feature, sessionId, worktreeName: worktreeName ?? undefined });
    }

    await renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useMouse });
  });
}
