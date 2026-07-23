import { ensureGitAndConfig } from '../../setup.js';
import { writeHeadlessJsonRecord } from '../../../engine/events/public-json.js';
import { createResponseWriter } from '../../rpc/writer.js';
import { bootstrapSession } from './readiness.js';
import type { RequiredFeatureDispatchArgs } from './types.js';

export async function runJsonStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const { sessionId } = await bootstrapSession({
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
    plannerContext,
  });
}

export async function runRpcStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const { sessionId } = await bootstrapSession({
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
    plannerContext,
  });
}
