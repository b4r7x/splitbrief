import { Command } from 'commander';
import { createElement } from 'react';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { App } from '../../app.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions } from '../options.js';
import { setupWorkflow, resolveProjectDir, ensureGitAndConfig } from '../setup.js';
import { routerStore } from '../../stores/navigation/router.js';
import { initStores } from '../init-stores.js';
import { clearStaleSession } from '../../core/sessions/guards.js';
import { beginSession, generateSessionId } from '../../core/sessions/lifecycle.js';
import { sessionError } from '../../core/sessions/errors.js';
import { maybeMigrate } from '../../core/migration/executor.js';
import { printMigrationResult } from './migrate.js';
import { runHeadless } from '../headless.js';
import { runRpc } from '../rpc/run.js';
import { createResponseWriter } from '../rpc/writer.js';
import { parseAtFiles } from '../parse-at-files.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { cliError } from '../errors.js';
import { createWorktree, detectWorktree } from '../../engine/worktree.js';
import { slugify } from '../../utils/slugify.js';
import { spawnServer } from '../../engine/ipc/spawn-server.js';
import { configPath } from '../../core/config/load/load.js';
import { READINESS_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { assertNotWindows } from '../platform.js';
import { writeSecureFile } from '../../lib/fs.js';
import { collectReadiness } from '../../core/readiness/collect.js';
import {
  createBlockerOnlyReadinessReport,
  createStartReadinessRecord,
  formatReadinessBlockers,
  readinessBlockerMessage,
} from '../../core/readiness/format.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { SpawnServerOptions, SpawnServerResult } from '../../engine/ipc/spawn-server.js';
import { buildCLIOverrides } from '../build-overrides.js';

export interface StartDeps {
  spawnServer: (opts: SpawnServerOptions) => Promise<SpawnServerResult>;
  runHeadless: typeof runHeadless;
  runRpc: typeof runRpc;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
}

const defaultStartDeps: StartDeps = {
  spawnServer,
  runHeadless,
  runRpc,
  initStores,
  renderApp,
};

async function applyWorktreeOption(feature: string | undefined, opts: WorkflowOpts): Promise<void> {
  if (opts.worktree === undefined) return;

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

function persistStartReadiness(projectDir: string, sessionId: string, report: ReadinessReport): void {
  const record = createStartReadinessRecord(report);
  writeSecureFile(
    join(sessionDir(projectDir, sessionId), READINESS_FILE),
    JSON.stringify(record, null, 2) + '\n',
  );
}

function assertReadinessCanStart(report: ReadinessReport, json: boolean | undefined): void {
  if (report.status !== 'blocked') return;
  if (!json) console.log(formatReadinessBlockers(report));
  throw cliError(readinessBlockerMessage(report), 1);
}

function clearStaleSessionForCli(projectDir: string): void {
  try {
    clearStaleSession(projectDir);
  } catch (err) {
    if (sessionError.isStillActive(err)) {
      throw cliError(err.message, 1);
    }
    throw err;
  }
}

function readinessForInteractiveStart(report: ReadinessReport): ReadinessReport {
  return report.status === 'blocked' ? createBlockerOnlyReadinessReport(report) : report;
}

export function registerStartCommand(program: Command, deps: StartDeps = defaultStartDeps): void {
  addWorkflowOptions(
    program
      .command('start [feature] [files...]', { isDefault: true })
      .description('Full workflow: plan with Claude, implement with local model')
      .option('--detach', 'spawn workflow as background server and exit', false),
  ).action(async (feature: string | undefined, files: string[], opts: WorkflowOpts) => {
    // Validate flag combinations BEFORE creating any worktree. A failed
    // validation must not leave behind a `.trees/<slug>` directory or a
    // `diptych/<slug>` branch.
    if (opts.detach) {
      assertNotWindows();
      if (!feature) throw cliError('--detach requires a feature argument');
      if (opts.json) throw cliError('--detach and --json cannot be combined');
      if (opts.rpc) throw cliError('--detach and --rpc cannot be combined');
    }
    if (opts.json && opts.rpc) throw cliError('--json and --rpc cannot be combined');
    if (opts.rpc && !feature) throw cliError('--rpc requires a feature argument');

    await applyWorktreeOption(feature, opts);

    let enrichedFeature = feature;
    let textContext = '';
    if (feature && files.length > 0) {
      const projectDirAt = resolveProjectDir(opts.project);
      const parsed = parseAtFiles(feature, files, projectDirAt);
      enrichedFeature = parsed.feature;
      textContext = parsed.textContext;
      for (const att of parsed.attachments) attachmentsStore.add(att);
      for (const err of parsed.errors) {
        console.error(`Warning: @${err.path}: ${err.reason}`);
      }
    }
    const plannerFeature = textContext
      ? `${enrichedFeature}\n\n<user-context>\n${textContext}\n</user-context>`
      : enrichedFeature;

    if (opts.detach) {
      if (!feature) throw cliError('--detach requires a feature argument');
      const projectDir = resolveProjectDir(opts.project);
      printMigrationResult(await maybeMigrate(projectDir));
      await ensureGitAndConfig(projectDir);
      const readiness = await collectReadiness({ projectDir, opts });
      assertReadinessCanStart(readiness.report, opts.json);

      const mode = opts.mode ?? 'standard';
      const sessId = generateSessionId(projectDir, feature);
      const sessDir = sessionDir(projectDir, sessId);
      ensureSessionDir(projectDir, sessId);
      persistStartReadiness(projectDir, sessId, readiness.report);

      const overrides = { ...buildCLIOverrides(opts), mode };

      const result = await deps.spawnServer({
        sessionDir: sessDir,
        sessionId: sessId,
        projectDir,
        feature: plannerFeature ?? feature,
        mode,
        configPath: configPath(projectDir),
        overrides,
      });

      if (!result.ok) {
        console.error(`Failed to start server: ${result.reason}`);
        process.exit(1);
      }

      console.log(`Session ${result.sessionId} started (pid ${result.pid}).`);
      console.log(`Run: cd ${projectDir} && diptych attach ${result.sessionId}`);
      return;
    }

    const projectDir = resolveProjectDir(opts.project);
    const migration = await maybeMigrate(projectDir);
    if (!opts.json && !opts.rpc) printMigrationResult(migration);

    if (opts.json) {
      if (!feature) throw cliError('--json requires a feature argument');
      await ensureGitAndConfig(projectDir);
      const readiness = await collectReadiness({ projectDir, opts, defaultAutoApprove: true });
      process.stdout.write(JSON.stringify({ type: 'readiness_report', report: readiness.report }) + '\n');
      assertReadinessCanStart(readiness.report, true);
      clearStaleSessionForCli(projectDir);
      const sessionId = beginSession(projectDir, feature);
      persistStartReadiness(projectDir, sessionId, readiness.report);
      await deps.runHeadless(plannerFeature ?? feature, projectDir, opts, undefined, sessionId, readiness);
      return;
    }

    if (opts.rpc) {
      if (!feature) throw cliError('--rpc requires a feature argument');
      await ensureGitAndConfig(projectDir);
      const readiness = await collectReadiness({ projectDir, opts });
      createResponseWriter(process.stdout).status({ type: 'readiness_report', report: readiness.report });
      assertReadinessCanStart(readiness.report, true);
      clearStaleSessionForCli(projectDir);
      const sessionId = beginSession(projectDir, feature);
      persistStartReadiness(projectDir, sessionId, readiness.report);
      await deps.runRpc(plannerFeature ?? feature, projectDir, opts, undefined, sessionId, readiness);
      return;
    }

    const { useFullscreen, useMouse, needsSetup } = await setupWorkflow(opts);

    const readiness = feature && !needsSetup
      ? await collectReadiness({ projectDir, opts })
      : undefined;
    if (readiness) assertReadinessCanStart(readiness.report, false);

    clearStaleSessionForCli(projectDir);

    const sessionId = feature ? beginSession(projectDir, feature) : undefined;
    if (feature && sessionId && readiness) persistStartReadiness(projectDir, sessionId, readiness.report);

    await deps.initStores(projectDir, opts);
    let worktreeName: string | null = null;
    try {
      worktreeName = await detectWorktree(projectDir, simpleGit(projectDir));
    } catch {
      worktreeName = null;
    }
    if (needsSetup) {
      routerStore.init({ screen: 'setup', onComplete: feature ? 'workflow' : 'home', feature });
    } else if (feature) {
      routerStore.init({
        screen: 'workflow',
        feature: plannerFeature ?? feature,
        sessionId,
        worktreeName: worktreeName ?? undefined,
        readiness: readiness ? readinessForInteractiveStart(readiness.report) : undefined,
      });
    }

    await deps.renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useMouse });
  });
}
