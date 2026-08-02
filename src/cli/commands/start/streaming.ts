import { ensureGitAndConfig } from '../../setup.js';
import { serializeReadinessReportJson } from '../../../core/readiness/format.js';
import { writeHeadlessJsonRecord } from '../../../engine/events/public-json.js';
import { createResponseWriter } from '../../rpc/writer.js';
import { bootstrapSession } from './readiness.js';
import type { RequiredFeatureDispatchArgs } from './types.js';

export async function runJsonStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const { sessionId, trustedCliGates } = await bootstrapSession({
    projectDir,
    feature,
    opts,
    assertJson: true,
    defaultApprove: 'none',
    ...(deps.detectCliReadiness !== undefined && {
      detectCliReadiness: deps.detectCliReadiness,
    }),
    emitReadiness: (report) => {
      writeHeadlessJsonRecord({
        type: 'readiness_report',
        report: serializeReadinessReportJson(report),
      });
    },
  });
  await deps.runHeadless({
    feature: enrichedFeature ?? feature,
    projectDir,
    opts,
    sessionId,
    plannerContext,
    trustedCliGates,
  });
}

export async function runRpcStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const { sessionId, trustedCliGates } = await bootstrapSession({
    projectDir,
    feature,
    opts,
    assertJson: true,
    ...(deps.detectCliReadiness !== undefined && {
      detectCliReadiness: deps.detectCliReadiness,
    }),
    emitReadiness: (report) => {
      createResponseWriter({ stream: process.stdout, onClose: () => {} }).status({
        type: 'readiness_report',
        report: serializeReadinessReportJson(report),
      });
    },
  });
  await deps.runRpc({
    feature: enrichedFeature ?? feature,
    projectDir,
    opts,
    sessionId,
    plannerContext,
    trustedCliGates,
  });
}
