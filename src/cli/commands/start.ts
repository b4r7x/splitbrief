import type { Command } from 'commander';
import { createElement } from 'react';
import { join } from 'node:path';
import { App } from '../../app.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions, assertModeFlagsExclusive } from '../options.js';
import { setupWorkflow, resolveProjectDir, ensureGitAndConfig } from '../setup.js';
import { routerStore } from '../../stores/navigation/router.js';
import { initStores } from '../init-stores.js';
import { clearStaleSession } from '../../core/sessions/guards.js';
import { beginSession, generateSessionId } from '../../core/sessions/lifecycle.js';
import { sessionError } from '../../core/sessions/errors.js';
import { maybeMigrateAndReport } from './migrate.js';
import { runHeadless } from '../headless.js';
import { runRpc } from '../rpc/run.js';
import { createResponseWriter } from '../rpc/writer.js';
import { parseAtFiles } from '../parse-at-files.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { cliError, withCliErrors } from '../errors.js';
import { createWorktree, detectWorktree } from '../../engine/worktree.js';
import { createGitClient } from '../../lib/git.js';
import { slugify } from '../../utils/slugify.js';
import { spawnServer } from '../../engine/ipc/spawn-server.js';
import { configPath } from '../../core/config/load/io.js';
import { READINESS_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { assertNotWindows } from '../windows-guard.js';
import { writeSecureFile } from '../../lib/fs.js';
import { collectReadiness } from '../../core/readiness/collect.js';
import type { CollectedReadiness } from '../../core/readiness/collect.js';
import {
  createBlockerOnlyReadinessReport,
  createStartReadinessRecord,
  formatReadinessBlockers,
  readinessBlockerMessage,
} from '../../core/readiness/format.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { SessionRef } from '../../core/types/session-ref.js';
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
  const git = createGitClient(baseProjectDir);
  const wtPath = await withCliErrors(() =>
    createWorktree({ projectDir: baseProjectDir, slug, git }),
  );
  console.log(`Starting session in worktree .trees/${slug} (branch diptych/${slug})`);
  opts.project = wtPath;
}

function persistStartReadiness(ref: SessionRef, report: ReadinessReport): void {
  const record = createStartReadinessRecord(report);
  writeSecureFile(
    join(sessionDir(ref.projectDir, ref.sessionId), READINESS_FILE),
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

interface BootstrapSessionArgs {
  projectDir: string;
  feature: string;
  opts: WorkflowOpts;
  assertJson: boolean;
  emitReadiness: (report: ReadinessReport) => void;
  defaultAutoApprove?: boolean | undefined;
}

async function bootstrapSession(
  args: BootstrapSessionArgs,
): Promise<{ sessionId: string; readiness: CollectedReadiness }> {
  const readiness = await collectReadiness({
    projectDir: args.projectDir,
    opts: args.opts,
    ...(args.defaultAutoApprove !== undefined && { defaultAutoApprove: args.defaultAutoApprove }),
  });
  args.emitReadiness(readiness.report);
  assertReadinessCanStart(readiness.report, args.assertJson);
  clearStaleSessionForCli(args.projectDir);
  const sessionId = beginSession(args.projectDir, args.feature);
  persistStartReadiness({ projectDir: args.projectDir, sessionId }, readiness.report);
  return { sessionId, readiness };
}

interface DispatchArgs {
  deps: StartDeps;
  projectDir: string;
  feature: string | undefined;
  enrichedFeature: string | undefined;
  plannerContext: string | undefined;
  opts: WorkflowOpts;
}

type RequiredFeatureDispatchArgs = DispatchArgs & { feature: string };

async function runDetachedStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const readiness = await collectReadiness({ projectDir, opts });
  assertReadinessCanStart(readiness.report, opts.json);

  const mode = opts.mode ?? 'standard';
  const sessId = generateSessionId(projectDir, feature);
  const sessDir = sessionDir(projectDir, sessId);
  ensureSessionDir(projectDir, sessId);
  persistStartReadiness({ projectDir, sessionId: sessId }, readiness.report);

  const overrides = { ...buildCLIOverrides(opts), mode };

  const result = await deps.spawnServer({
    sessionDir: sessDir,
    sessionId: sessId,
    projectDir,
    feature: enrichedFeature ?? feature,
    mode,
    configPath: configPath(projectDir),
    overrides,
    ...(opts.allowHooks !== undefined && { allowHooks: opts.allowHooks }),
    ...(plannerContext !== undefined && { plannerContext }),
  });

  if (!result.ok) {
    throw cliError(`Failed to start server: ${result.reason}`, 1);
  }

  console.log(`Session ${result.sessionId} started (pid ${result.pid}).`);
  console.log(`Run: cd ${projectDir} && diptych attach ${result.sessionId}`);
}

async function runJsonStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const { sessionId, readiness } = await bootstrapSession({
    projectDir,
    feature,
    opts,
    assertJson: true,
    defaultAutoApprove: true,
    emitReadiness: (report) => {
      process.stdout.write(JSON.stringify({ type: 'readiness_report', report }) + '\n');
    },
  });
  await deps.runHeadless({
    feature: enrichedFeature ?? feature,
    projectDir,
    opts,
    sessionId,
    readiness,
    plannerContext,
  });
}

async function runRpcStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const { sessionId, readiness } = await bootstrapSession({
    projectDir,
    feature,
    opts,
    assertJson: true,
    emitReadiness: (report) => {
      createResponseWriter(process.stdout).status({ type: 'readiness_report', report });
    },
  });
  await deps.runRpc({
    feature: enrichedFeature ?? feature,
    projectDir,
    opts,
    sessionId,
    readiness,
    plannerContext,
  });
}

async function runInteractiveStart(args: DispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  const { useFullscreen, useMouse, needsSetup } = await setupWorkflow(opts);

  let sessionId: string | undefined;
  let readiness: CollectedReadiness | undefined;
  if (feature && !needsSetup) {
    ({ sessionId, readiness } = await bootstrapSession({
      projectDir,
      feature,
      opts,
      assertJson: false,
      emitReadiness: () => {},
    }));
  } else {
    clearStaleSessionForCli(projectDir);
  }

  await deps.initStores(projectDir, opts);
  let worktreeName: string | null = null;
  try {
    worktreeName = await detectWorktree(projectDir, createGitClient(projectDir));
  } catch {
    worktreeName = null;
  }
  if (needsSetup) {
    routerStore.init({
      screen: 'setup',
      onComplete: feature ? 'workflow' : 'home',
      feature: enrichedFeature ?? feature,
      plannerContext,
    });
  } else if (feature) {
    routerStore.init({
      screen: 'workflow',
      feature: enrichedFeature ?? feature,
      plannerContext,
      sessionId,
      worktreeName: worktreeName ?? undefined,
      readiness: readiness ? readinessForInteractiveStart(readiness.report) : undefined,
    });
  }

  await deps.renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useMouse });
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
    assertModeFlagsExclusive(opts);
    if (opts.rpc && !feature) throw cliError('--rpc requires a feature argument');
    if (opts.json && !feature) throw cliError('--json requires a feature argument');

    await applyWorktreeOption(feature, opts);

    const projectDir = resolveProjectDir(opts.project);

    let enrichedFeature = feature;
    let plannerContext: string | undefined;
    if (feature && files.length > 0) {
      const parsed = parseAtFiles(feature, files, projectDir);
      enrichedFeature = parsed.feature;
      if (parsed.textContext) plannerContext = parsed.textContext;
      for (const att of parsed.attachments) attachmentsStore.add(att);
      for (const err of parsed.errors) {
        console.error(`Warning: @${err.path}: ${err.reason}`);
      }
    }

    await maybeMigrateAndReport(projectDir, opts);

    if ((opts.detach || opts.json || opts.rpc) && feature) {
      const dispatch = { deps, projectDir, feature, enrichedFeature, plannerContext, opts };
      if (opts.detach) {
        await runDetachedStart(dispatch);
        return;
      }
      if (opts.json) {
        await runJsonStart(dispatch);
        return;
      }
      await runRpcStart(dispatch);
      return;
    }

    await runInteractiveStart({ deps, projectDir, feature, enrichedFeature, plannerContext, opts });
  });
}
