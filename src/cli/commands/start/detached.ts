import { ensureGitAndConfig } from '../../setup.js';
import { ensureHooksTrusted } from '../../hook-trust-prompt.js';
import { resolveHooksConfig } from '../../../engine/hooks/discover.js';
import { createSessionPreparationCandidate } from '../../../core/sessions/prepare.js';
import {
  resolveCliWorkflowMode,
  workflowOptsToCLIOverrides,
} from '../../../core/config/runtime/overrides/from-options.js';
import { resolveRunConfigWithBase } from '../../build-overrides.js';
import { cliError } from '../../errors.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { formatDetachedAttachHint } from '../attach-hint.js';
import type { RequiredFeatureDispatchArgs } from './types.js';
import { assertDetachedOverridesTransportable } from '../../../engine/ipc/spawn-server.js';

export async function runDetachedStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  const overrides = workflowOptsToCLIOverrides(opts);
  assertDetachedOverridesTransportable({ overrides });
  await ensureGitAndConfig(projectDir);
  const { config } = resolveRunConfigWithBase({ projectDir, opts });
  const mergedHooks = await resolveHooksConfig(projectDir, config.hooks);
  await ensureHooksTrusted({
    projectDir,
    hooks: mergedHooks,
    allowHooks: opts.allowHooks ?? false,
  });

  const mode = resolveCliWorkflowMode(opts, config);
  const candidate = createSessionPreparationCandidate({
    projectDir,
    feature,
    persistTranscript: config.workflow.persistTranscript,
  });

  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let result: Awaited<ReturnType<typeof deps.spawnServer>>;
  try {
    result = await deps.spawnServer({
      candidate,
      projectDir,
      feature: enrichedFeature ?? feature,
      overrides: { ...overrides, mode },
      signal: cancellation.signal,
      ...(opts.allowHooks !== undefined && { allowHooks: opts.allowHooks }),
      ...(opts.allowRepoRunners !== undefined && { allowRepoRunners: opts.allowRepoRunners }),
      ...(opts.allowUnverifiedAuth !== undefined && {
        allowUnverifiedAuth: opts.allowUnverifiedAuth,
      }),
      ...(plannerContext !== undefined && { plannerContext }),
      ...(args.attachments !== undefined &&
        args.attachments.length > 0 && {
          attachments: args.attachments,
        }),
    });
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }

  if (!result.ok) {
    throw cliError(`Failed to start server: ${result.reason}`, 1);
  }

  console.log(`Session ${result.sessionId} started (pid ${result.pid}).`);
  console.log(
    `Run: ${formatDetachedAttachHint(stripTerminalControls(projectDir), stripTerminalControls(result.sessionId))}`,
  );
}
