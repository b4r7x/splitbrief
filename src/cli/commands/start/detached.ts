import { ensureGitAndConfig } from '../../setup.js';
import { configPath } from '../../../core/config/load/io.js';
import { ensureHooksTrusted } from '../../hook-trust-prompt.js';
import { resolveHooksConfig } from '../../../engine/hooks/discover.js';
import { clearActive } from '../../../core/sessions/lifecycle.js';
import { sessionDir } from '../../../core/paths.js';
import {
  resolveCliWorkflowMode,
  workflowOptsToCLIOverrides,
} from '../../../core/config/runtime/overrides/from-options.js';
import { resolveRunConfigWithBase } from '../../build-overrides.js';
import { cliError } from '../../errors.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { formatDetachedAttachHint } from '../attach-hint.js';
import { bootstrapSession } from './readiness.js';
import type { RequiredFeatureDispatchArgs } from './types.js';

export async function runDetachedStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const { config } = resolveRunConfigWithBase({ projectDir, opts });
  const mergedHooks = await resolveHooksConfig(projectDir, config.hooks);
  await ensureHooksTrusted({
    projectDir,
    hooks: mergedHooks,
    allowHooks: opts.allowHooks ?? false,
  });

  const mode = resolveCliWorkflowMode(opts, config);
  const persistTranscript = config.workflow.persistTranscript;
  const { sessionId: sessId, trustedCliGates } = await bootstrapSession({
    projectDir,
    feature,
    opts,
    assertJson: opts.json ?? false,
    emitReadiness: () => {},
    ...(deps.detectCliReadiness !== undefined && {
      detectCliReadiness: deps.detectCliReadiness,
    }),
  });
  const sessDir = sessionDir(projectDir, sessId);

  const overrides = workflowOptsToCLIOverrides(opts);

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
    ...(opts.allowRepoRunners !== undefined && { allowRepoRunners: opts.allowRepoRunners }),
    ...(plannerContext !== undefined && { plannerContext }),
    ...(args.attachments !== undefined &&
      args.attachments.length > 0 && {
        attachments: args.attachments,
      }),
    trustedCliGates,
  });

  if (!result.ok) {
    clearActive({ projectDir, sessionId: sessId });
    throw cliError(`Failed to start server: ${result.reason}`, 1);
  }

  console.log(`Session ${result.sessionId} started (pid ${result.pid}).`);
  console.log(
    `Run: ${formatDetachedAttachHint(stripTerminalControls(projectDir), stripTerminalControls(result.sessionId))}`,
  );
}
