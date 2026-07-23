import { makeSession } from './session.js';
import { makeSummary } from './summary.js';
import { taskId } from '../../../src/core/schemas/task.js';

export function makeLegacySessionSummaryWithoutContextDetected({
  sessionId,
  payloadId = sessionId,
}: {
  sessionId: string;
  payloadId?: string;
}): Record<string, unknown> {
  const session = makeSession({
    id: payloadId,
    status: 'complete',
    summary: makeSummary({
      costPrediction: {
        estimatedTasks: 1,
        lowCost: 0,
        expectedCost: 0,
        highCost: 0,
        plannerTool: 'codex',
        implementerTool: 'codex',
        deterministic: {
          taskCount: 1,
          taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 0,
            contextDetected: 1,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 0,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: { priceKnown: 0, priceUnknown: 1, profileUnavailable: 0 },
          tasks: [
            {
              taskId: taskId('T001'),
              title: 'legacy task',
              estimatedPromptTokens: 10,
              selectedProfileId: 'default',
              contextFit: 'fits',
              contextConfidence: 'context-detected',
              priceConfidence: 'price-unknown',
              estimatedImplementerCost: null,
              hypotheticalPlannerCost: null,
            },
          ],
          totals: {
            knownActualEstimate: null,
            hypotheticalAllPlanner: null,
            estimatedSavings: null,
            unknownCostReason: ['implementer-price-unknown'],
          },
        },
      },
    }),
  });
  const raw = JSON.parse(JSON.stringify(session)) as {
    id: string;
    summary: {
      costPrediction: {
        deterministic: {
          contextConfidenceCounts: { contextDetected?: number };
        };
      };
    };
  };
  raw.id = sessionId;
  delete raw.summary.costPrediction.deterministic.contextConfidenceCounts.contextDetected;
  return raw;
}
