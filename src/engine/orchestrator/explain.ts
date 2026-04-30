import { validateSafeIdentifier } from '../../utils/validate-identifier.js';
import { assertSessionDirectory, readExplainArtifacts } from './explain-artifacts.js';
import { buildRoutes } from './explain-routing.js';
import { buildActivity, buildCost, buildReview, buildWarnings, sessionStatus } from './explain-sections.js';
import type { RunExplain } from './explain-types.js';

export async function buildRunExplain(opts: { projectDir: string; sessionId: string }): Promise<RunExplain> {
  validateSessionId(opts.sessionId);
  await assertSessionDirectory(opts.projectDir, opts.sessionId);

  const artifacts = await readExplainArtifacts(opts.projectDir, opts.sessionId);
  const { summary, reviewPacket, state, readiness, events } = artifacts;
  const readinessSummary = reviewPacket?.readiness ?? readiness;
  const routes = buildRoutes({ summary, reviewPacket, state, events });

  return {
    sessionId: opts.sessionId,
    feature: summary?.feature ?? reviewPacket?.run.feature ?? state?.feature ?? 'unknown',
    phase: state?.phase ?? reviewPacket?.run.phase ?? null,
    status: sessionStatus(summary, state),
    cost: buildCost(summary, reviewPacket, routes),
    routing: routes,
    activity: buildActivity(reviewPacket, state, events),
    review: buildReview(opts.sessionId, reviewPacket, state, events, artifacts.artifacts),
    warnings: buildWarnings(readinessSummary, reviewPacket, events),
    artifacts: artifacts.artifacts,
  };
}

function validateSessionId(sessionId: string): void {
  const result = validateSafeIdentifier(sessionId);
  if (!result.ok) throw new Error(`Invalid session id "${sessionId}": ${result.reason}`);
}
