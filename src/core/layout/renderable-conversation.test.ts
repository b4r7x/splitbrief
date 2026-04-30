import { describe, expect, it } from 'vitest';
import type { Section } from './event-sections.js';
import { getMaxVisibleDiffLines } from './diff-height.js';
import {
  estimateEventHeight,
  estimateRenderableConversationHeight,
  getRenderableConversationItems,
  isChromeEvent,
} from './renderable-conversation.js';
import type { LayoutEvent } from './event-types.js';
import {
  makePlannerText,
  makeImplementerGenerate,
} from '#testing/helpers/events.js';

function estimateSectionHeight(section: Section, expandedDiffs: Set<number>, cols?: number, rows?: number): number {
  if (section.type === 'completed-task') return 1;
  return estimateRenderableConversationHeight(
    getRenderableConversationItems([section], expandedDiffs, cols, rows),
  );
}

describe('estimateSectionHeight', () => {
  it('returns 1 for completed-task section', () => {
    const section: Section = {
      type: 'completed-task',
      summary: { index: 1, title: 'Task', method: 'local', retries: 0, duration: 5 },
    };
    expect(estimateSectionHeight(section, new Set())).toBe(1);
  });

  it('sums event heights for events section', () => {
    const section: Section = {
      type: 'events',
      items: [makePlannerText(), makePlannerText()],
      startIndex: 0,
    };
    expect(estimateSectionHeight(section, new Set())).toBe(3);
  });

  it('accounts for diff expanded state', () => {
    const section: Section = {
      type: 'events',
      items: [makeImplementerGenerate({ status: 'done', diff: '+ line' })],
      startIndex: 5,
    };
    const collapsed = estimateSectionHeight(section, new Set());
    const expanded = estimateSectionHeight(section, new Set([5]));
    expect(expanded).toBeGreaterThan(collapsed);
  });

  it('matches the shared diff row budget for expanded diffs', () => {
    const diff = Array.from({ length: 20 }, (_, index) => `+ line ${index}`).join('\n');
    const section: Section = {
      type: 'events',
      items: [makeImplementerGenerate({ status: 'done', file: 'a.ts', diff })],
      startIndex: 0,
    };
    const rows = 12;
    const visibleLines = Math.min(20, getMaxVisibleDiffLines(rows));
    const expected = 1 + (1 + visibleLines + 1);
    expect(estimateSectionHeight(section, new Set([0]), 80, rows)).toBe(expected);
  });
});

describe('isChromeEvent', () => {
  it('marks planner status and workflow config as chrome-only events', () => {
    expect(isChromeEvent('planner_status')).toBe(true);
    expect(isChromeEvent('workflow_config')).toBe(true);
  });

  it('keeps regular conversation events in the scroll region', () => {
    expect(isChromeEvent('planner_text')).toBe(false);
    expect(isChromeEvent('user_message')).toBe(false);
  });
});

describe('event height rules', () => {
  const visibleAuditEvents = [
    { type: 'paused_external_changes' },
    { type: 'recovery_prompted' },
    { type: 'recovery_action_selected' },
    { type: 'recovery_action_failed' },
    { type: 'recovery_resolved' },
    { type: 'git_branch_created' },
    { type: 'brief_quality_passed' },
    { type: 'brief_quality_failed' },
    { type: 'drift_report' },
    { type: 'mode_downgrade_advised' },
    { type: 'budget_paused' },
    { type: 'approval_mode_changed' },
  ] satisfies LayoutEvent[];

  const hiddenSystemEvents = [
    { type: 'workflow_started' },
    { type: 'workflow_resumed' },
    { type: 'workflow_complete' },
    { type: 'cost_update' },
    { type: 'snapshot_created' },
    { type: 'snapshot_restored' },
    { type: 'snapshot_restore_conflict' },
    { type: 'approval_prompted' },
    { type: 'ipc_server_started' },
    { type: 'replay_complete' },
  ] satisfies LayoutEvent[];

  it('reserves rows for visible audit events', () => {
    for (const event of visibleAuditEvents) {
      expect(estimateEventHeight(event), event.type).toBeGreaterThan(0);
    }

    const section = { type: 'events', items: visibleAuditEvents, startIndex: 0 } satisfies Extract<Section, { type: 'events' }>;
    const items = getRenderableConversationItems([section], new Set());
    expect(items).toHaveLength(visibleAuditEvents.length);
    expect(estimateRenderableConversationHeight(items)).toBeGreaterThanOrEqual(visibleAuditEvents.length);
  });

  it('does not reserve rows or spacer gaps for hidden system events', () => {
    for (const event of hiddenSystemEvents) {
      expect(estimateEventHeight(event), event.type).toBe(0);
    }

    const section = {
      type: 'events',
      items: [
        makePlannerText({ ts: 0, text: 'before' }),
        ...hiddenSystemEvents,
        makePlannerText({ ts: hiddenSystemEvents.length + 1, text: 'after' }),
      ],
      startIndex: 0,
    } satisfies Extract<Section, { type: 'events' }>;

    const items = getRenderableConversationItems([section], new Set());
    expect(items.map((item) => item.event.type)).toEqual(['planner_text', 'planner_text']);
    expect(estimateRenderableConversationHeight(items)).toBe(3);
  });

  it('matches cost prediction card rows for heuristic predictions', () => {
    const event = {
      type: 'cost_prediction',
      prediction: {
        estimatedTasks: 4,
        lowCost: 0.1,
        expectedCost: 0.2,
        highCost: 0.4,
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
      },
    } satisfies LayoutEvent;

    expect(estimateEventHeight(event)).toBe(4);
  });

  it('matches cost prediction card rows for deterministic optional lines', () => {
    const event = {
      type: 'cost_prediction',
      prediction: {
        estimatedTasks: 1,
        lowCost: 0,
        expectedCost: 0,
        highCost: 0,
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
        deterministic: {
          taskCount: 1,
          taskFitCounts: { fits: 0, tight: 1, overflow: 0, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 1,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 0,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: {
            priceKnown: 0,
            priceUnknown: 1,
            profileUnavailable: 0,
          },
          tasks: [],
          totals: {
            knownActualEstimate: null,
            hypotheticalAllPlanner: null,
            estimatedSavings: null,
            unknownCostReason: ['implementer-price-unknown'],
          },
        },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'completed',
          classification: 'risk',
          affectedTaskIds: [],
          reason: null,
          recommendedUserDecision: null,
        },
      },
    } satisfies LayoutEvent;

    expect(estimateEventHeight(event)).toBe(9);
  });
});
