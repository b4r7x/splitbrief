import { assertSessionDirectory, readExplainArtifacts } from './artifacts.js';
import { buildRoutes } from './routing.js';
import { buildActivity, buildCost, buildReview, buildWarnings, sessionStatus } from './sections.js';
import type { RunExplain } from './types.js';

export async function buildRunExplain(opts: {
  projectDir: string;
  sessionId: string;
}): Promise<RunExplain> {
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
    activity: buildActivity({ packet: reviewPacket, state, events }),
    review: buildReview({
      sessionId: opts.sessionId,
      packet: reviewPacket,
      state,
      events,
      artifacts: artifacts.artifacts,
    }),
    warnings: buildWarnings(readinessSummary, reviewPacket, events),
    artifacts: artifacts.artifacts,
  };
}
