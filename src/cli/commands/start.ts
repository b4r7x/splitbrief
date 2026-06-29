import type { Command } from 'commander';
import { createElement } from 'react';
import { join } from 'node:path';
import { App } from '../../app.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions, assertModeFlagsExclusive } from '../options.js';
import {
  setupWorkflow,
  canonicalizeProjectDir,
  ensureGitAndConfig,
  assertInteractiveTty,
} from '../setup.js';
import { routerStore } from '../../stores/navigation/router.js';
import { initStores } from '../init-stores.js';
import { clearStaleSession } from '../../core/sessions/guards.js';
import {
  beginSession,
  generateOpaqueSessionSlug,
  MAX_SLUG_LENGTH,
} from '../../core/sessions/lifecycle.js';
import { sessionError } from '../../core/sessions/errors.js';
import { maybeMigrateAndReport } from './migrate.js';
import { runHeadless } from '../headless.js';
import { runRpc } from '../rpc/run.js';
import { createResponseWriter } from '../rpc/writer.js';
import { parseAtFiles } from '../parse-at-files.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { cliError, withCliErrors } from '../errors.js';
import { createWorktree, detectWorktree, removeWorktree } from '../../engine/worktree.js';
import { createGitClient, type GitClient } from '../../lib/git.js';
import { slugify } from '../../utils/slugify.js';
import { spawnServer } from '../../engine/ipc/spawn-server.js';
import { configPath, loadConfig } from '../../core/config/load/io.js';
import { ensureHooksTrusted } from '../hook-trust-prompt.js';
import { resolveHooksConfig } from '../../engine/hooks/discover.js';
import { READINESS_FILE, sessionDir } from '../../core/paths.js';
import { assertNotWindows } from '../windows-guard.js';
import { writeSecureFile } from '../../lib/fs.js';
import { collectReadiness } from '../../core/readiness/collect.js';
import type { CollectedReadiness } from '../../core/readiness/collect.js';
import {
  createStartReadinessRecord,
  formatReadinessBlockers,
  readinessBlockerPointer,
} from '../../core/readiness/format.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { SpawnServerOptions, SpawnServerResult } from '../../engine/ipc/spawn-server.js';
import { buildCLIOverrides, printConfigWarnings } from '../build-overrides.js';
import { writeHeadlessJsonRecord } from '../../engine/events/public-json.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { formatDetachedAttachHint } from '../../utils/shell-quote.js';
import { resolveCliWorkflowMode } from '../../core/config/runtime/overrides.js';

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

interface CreatedWorktree {
  slug: string;
  baseProjectDir: string;
  git: GitClient;
}

async function applyWorktreeOption(
  feature: string | undefined,
  opts: WorkflowOpts,
): Promise<CreatedWorktree | null> {
  if (opts.worktree === undefined) return null;

  const baseProjectDir = await canonicalizeProjectDir(opts);
  // A bare `--worktree` derives its slug from the feature. Under
  // workflow.persistTranscript:false the feature must not leak into the
  // `.trees/<slug>` directory or `diptych/<slug>` branch, so generate an
  // opaque slug instead. An explicit `--worktree <name>` is user-chosen and
  // kept verbatim.
  const persistTranscript = loadConfig(baseProjectDir).config.workflow.persistTranscript;
  const slug =
    typeof opts.worktree === 'string' && opts.worktree.length > 0
      ? opts.worktree
      : persistTranscript
        ? slugify(feature ?? 'session', MAX_SLUG_LENGTH) || 'unknown'
        : generateOpaqueSessionSlug();
  const git = createGitClient(baseProjectDir);
  const wtPath = await withCliErrors(() =>
    createWorktree({ projectDir: baseProjectDir, slug, git }),
  );
  const displaySlug = stripTerminalControls(slug);
  console.log(`Starting session in worktree .trees/${displaySlug} (branch diptych/${displaySlug})`);
  opts.project = wtPath;
  return { slug, baseProjectDir, git };
}

async function rollbackCreatedWorktree(created: CreatedWorktree): Promise<void> {
  try {
    await removeWorktree({
      projectDir: created.baseProjectDir,
      slug: created.slug,
      git: created.git,
      force: true,
      deleteBranch: true,
    });
  } catch {
    const displaySlug = stripTerminalControls(created.slug);
    process.stderr.write(
      `Warning: failed to remove worktree .trees/${displaySlug} after a startup error; ` +
        `run "git worktree prune" then "git branch -D diptych/${displaySlug}" to clean up.\n`,
    );
  }
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
  throw cliError(readinessBlockerPointer(report), 1);
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
    probeValidation: true,
    ...(args.defaultAutoApprove !== undefined && { defaultAutoApprove: args.defaultAutoApprove }),
  });
  args.emitReadiness(readiness.report);
  assertReadinessCanStart(readiness.report, args.assertJson);
  clearStaleSessionForCli(args.projectDir);
  const persistTranscript = readiness.config?.workflow.persistTranscript ?? true;
  const sessionId = beginSession(args.projectDir, args.feature, { persistTranscript });
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
  attachments?: Array<{ id: string; path: string; mimeType: string }>;
}

type RequiredFeatureDispatchArgs = DispatchArgs & { feature: string };

async function runDetachedStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const { config, warnings } = loadConfig(projectDir);
  printConfigWarnings(warnings);
  const mergedHooks = await resolveHooksConfig(projectDir, config.hooks);
  await ensureHooksTrusted({
    projectDir,
    hooks: mergedHooks,
    allowHooks: opts.allowHooks ?? false,
  });
  const readiness = await collectReadiness({ projectDir, opts, probeValidation: true });
  assertReadinessCanStart(readiness.report, opts.json);

  const mode = resolveCliWorkflowMode(opts, config);
  const persistTranscript = config.workflow.persistTranscript;
  clearStaleSessionForCli(projectDir);
  const sessId = beginSession(projectDir, feature, { persistTranscript });
  const sessDir = sessionDir(projectDir, sessId);
  persistStartReadiness({ projectDir, sessionId: sessId }, readiness.report);

  const overrides = buildCLIOverrides(opts);

  const result = await deps.spawnServer({
    sessionDir: sessDir,
    sessionId: sessId,
    projectDir,
    feature: enrichedFeature ?? feature,
    mode,
    configPath: configPath(projectDir),
    overrides,
    persistTranscript,
    ...(opts.allowHooks !== undefined && { allowHooks: opts.allowHooks }),
    ...(plannerContext !== undefined && { plannerContext }),
    ...(args.attachments !== undefined &&
      args.attachments.length > 0 && {
        attachments: args.attachments,
      }),
  });

  if (!result.ok) {
    throw cliError(`Failed to start server: ${result.reason}`, 1);
  }

  console.log(`Session ${result.sessionId} started (pid ${result.pid}).`);
  console.log(
    `Run: ${formatDetachedAttachHint(stripTerminalControls(projectDir), stripTerminalControls(result.sessionId))}`,
  );
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
      writeHeadlessJsonRecord({ type: 'readiness_report', report });
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
      createResponseWriter({ stream: process.stdout, onClose: () => {} }).status({
        type: 'readiness_report',
        report,
      });
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
  assertInteractiveTty();
  const { useFullscreen, useMouse, useHover, needsSetup } = await setupWorkflow(opts);

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
      readiness: readiness ? readiness.report : undefined,
    });
  }

  await deps.renderApp(createElement(App), {
    fullscreen: useFullscreen,
    mouse: useMouse,
    hover: useHover,
    projectDir,
  });
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

    const createdWorktree = await applyWorktreeOption(feature, opts);

    // Everything after worktree creation can fail (migration, readiness,
    // session bootstrap, server spawn). A failure there must not orphan the
    // freshly created `.trees/<slug>` directory and `diptych/<slug>` branch,
    // or the next retry would fail with "branch already exists". Roll the
    // worktree back on any such failure, then rethrow.
    try {
      const projectDir = await canonicalizeProjectDir(opts);

      let enrichedFeature = feature;
      let plannerContext: string | undefined;
      const parsedAttachments: Array<{ id: string; path: string; mimeType: string }> = [];
      if (feature && files.length > 0) {
        const parsed = parseAtFiles(feature, files, projectDir);
        enrichedFeature = parsed.feature;
        if (parsed.textContext) plannerContext = parsed.textContext;
        for (const att of parsed.attachments) {
          attachmentsStore.add(att);
          parsedAttachments.push({ id: att.id, path: att.path, mimeType: att.mimeType });
        }
        for (const err of parsed.errors) {
          console.error(`Warning: @${stripTerminalControls(err.path)}: ${err.reason}`);
        }
      }

      await maybeMigrateAndReport(projectDir, opts);

      if ((opts.detach || opts.json || opts.rpc) && feature) {
        const dispatch = {
          deps,
          projectDir,
          feature,
          enrichedFeature,
          plannerContext,
          opts,
          ...(parsedAttachments.length > 0 && { attachments: parsedAttachments }),
        };
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

      await runInteractiveStart({
        deps,
        projectDir,
        feature,
        enrichedFeature,
        plannerContext,
        opts,
      });
    } catch (err) {
      if (createdWorktree) await rollbackCreatedWorktree(createdWorktree);
      throw err;
    }
  });
}
